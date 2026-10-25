import {
  schema,
  type BlockSignal,
  type DiscoverInput,
  type DiscoverResult,
  type Stage,
  type StageContext,
} from '@pp/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { detectBlock } from './blocks';
import { logRequest, remainingToday } from './cap';
import type { DriverFactory, PageDriver } from './driver/types';
import { PlaywrightDriver } from './driver/playwright';
import { scrollFeedToEnd } from './feed';
import { parseCard } from './parse/card';
import { parsePlace } from './parse/place';
import { persistCard, persistPlace, type PersistCtx } from './persist';
import { buildSearchUrl, type QueryForm } from './query';
import { resumeRun, stopRun } from './run-state';
import { randomPause } from './throttle';

export interface DiscoverDeps {
  /** Builds the browser page for one stage run. Tests pass a FixtureDriver; the default launches Chromium. */
  driverFactory?: (ctx: StageContext) => Promise<PageDriver>;
  rng?: () => number;
  queryForm?: QueryForm;
}

/** Three searches in a row that show neither a results list nor a place panel look like an unknown interstitial. */
const MAX_CONSECUTIVE_EMPTY = 3;

export const defaultDriverFactory = (ctx: StageContext): Promise<PageDriver> => PlaywrightDriver.launch(ctx.config);

export function requestOutcomeFor(signal: BlockSignal): 'sorry' | 'captcha' | 'blocked' {
  if (signal === 'sorry') return 'sorry';
  if (signal === 'captcha') return 'captcha';
  return 'blocked';
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === 'TimeoutError';
}

export function createDiscoverStage(deps: DiscoverDeps = {}): Stage<DiscoverInput, DiscoverResult> {
  return {
    name: 'discover',
    async run(ctx, input) {
      const { db, config } = ctx;
      const { runId } = input;
      const { searches } = schema;
      const makeDriver: DriverFactory = () => (deps.driverFactory ?? defaultDriverFactory)(ctx);
      const pctx: PersistCtx = { db, evidence: ctx.evidence, now: () => ctx.now() };
      const result: DiscoverResult = { searchesDone: 0, searchesRemaining: 0, cardsSeen: 0, newListings: 0, stopped: null };

      const unfinished = () =>
        db
          .select()
          .from(searches)
          .where(and(eq(searches.runId, runId), inArray(searches.status, ['pending', 'running', 'blocked'])))
          .orderBy(asc(searches.position), asc(searches.id));

      // Back off after a block: a blocked search is only retried once the back-off has passed.
      const queue = await unfinished();
      const backoffMs = config.maps.blockBackoffMinutes * 60_000;
      for (const s of queue) {
        if (s.status !== 'blocked') continue;
        const until = (s.finishedAt?.getTime() ?? 0) + backoffMs;
        if (ctx.now().getTime() < until) {
          result.searchesRemaining = queue.length;
          result.stopped = {
            signal: (s.blockSignal as BlockSignal | null) ?? 'unusual_traffic',
            searchId: s.id,
            listingId: null,
            at: ctx.now(),
            detail: `search ${s.id} was blocked; backing off until ${new Date(until).toISOString()}`,
          };
          return result;
        }
      }
      if (queue.length === 0) return result;

      await resumeRun(db, runId, ctx.now());
      let driver: PageDriver | null = null;
      let emptyStreak = 0;
      try {
        for (let i = 0; i < queue.length; i++) {
          const s = queue[i];
          if (!s) break;

          // Daily cap, checked before every navigation.
          if ((await remainingToday(db, 'search', config.maps.dailyCap.searches, ctx.now())) <= 0) {
            result.stopped = await stopRun(
              db,
              runId,
              'daily_cap',
              `${config.maps.dailyCap.searches} searches already logged today`,
              ctx.now(),
            );
            break;
          }

          const url =
            s.url ??
            buildSearchUrl({ term: s.term, zip: s.zip, centerLat: s.centerLat, centerLng: s.centerLng }, deps.queryForm);
          await db
            .update(searches)
            .set({
              status: 'running',
              attempts: s.attempts + 1,
              startedAt: ctx.now(),
              finishedAt: null,
              blockSignal: null,
              query: s.query,
              url,
            })
            .where(eq(searches.id, s.id));

          driver ??= await makeDriver();
          const started = Date.now();
          let opened;
          try {
            opened = await driver.open(url);
          } catch (e) {
            await logRequest(db, {
              runId,
              url,
              status: null,
              ms: Date.now() - started,
              outcome: isTimeout(e) ? 'timeout' : 'http_error',
              note: 'search',
              at: ctx.now(),
            });
            throw e; // the search stays 'running'; a re-run retries it
          }
          const signals = await driver.pageSignals();
          const block = detectBlock(signals, opened.status);
          if (block) {
            await logRequest(db, {
              runId,
              url,
              status: opened.status,
              ms: Date.now() - started,
              outcome: requestOutcomeFor(block),
              note: 'search',
              at: ctx.now(),
            });
            await db
              .update(searches)
              .set({ status: 'blocked', blockSignal: block, landedUrl: opened.landedUrl, finishedAt: ctx.now() })
              .where(eq(searches.id, s.id));
            result.stopped = await stopRun(db, runId, block, `search ${s.id} (${s.query}) landed on ${opened.landedUrl}`, ctx.now(), {
              searchId: s.id,
            });
            break;
          }

          if (!signals.hasFeed && signals.hasPlacePanel) {
            // The search landed straight on one place page: that is one listing.
            const snapshot = await driver.snapshotPlace();
            const parsed = parsePlace(snapshot);
            const placed = await persistPlace(pctx, runId, null, snapshot, parsed);
            await logRequest(db, {
              runId,
              url,
              status: opened.status,
              ms: Date.now() - started,
              outcome: parsed.limitedView ? 'limited_view' : 'ok',
              note: 'search',
              at: ctx.now(),
            });
            let isNew = 0;
            if (placed.listingId !== null) {
              const hit = await db
                .insert(schema.searchHits)
                .values({ searchId: s.id, listingId: placed.listingId, position: 1, isNew: placed.inserted })
                .onConflictDoNothing({ target: [schema.searchHits.searchId, schema.searchHits.listingId] })
                .returning({ id: schema.searchHits.id });
              if (hit.length > 0 && placed.inserted) isNew = 1;
            }
            await db
              .update(searches)
              .set({
                status: placed.listingId !== null ? 'done' : 'failed',
                cardsFound: placed.listingId !== null ? 1 : 0,
                newPlaceIds: isNew,
                endReached: true,
                landedUrl: opened.landedUrl,
                finishedAt: ctx.now(),
              })
              .where(eq(searches.id, s.id));
            emptyStreak = 0;
            if (placed.listingId !== null) {
              result.searchesDone++;
              result.cardsSeen++;
              result.newListings += isNew;
            }
          } else if (!signals.hasFeed) {
            // Neither a results list nor a place panel and not a recognised block: record it, do not guess.
            await logRequest(db, {
              runId,
              url,
              status: opened.status,
              ms: Date.now() - started,
              outcome: 'http_error',
              note: 'search',
              at: ctx.now(),
            });
            await db
              .update(searches)
              .set({ status: 'failed', landedUrl: opened.landedUrl, finishedAt: ctx.now() })
              .where(eq(searches.id, s.id));
            ctx.log.warn({ searchId: s.id, landedUrl: opened.landedUrl }, 'search page has no results list and no place panel');
            emptyStreak++;
            if (emptyStreak >= MAX_CONSECUTIVE_EMPTY) {
              result.stopped = await stopRun(
                db,
                runId,
                'unusual_traffic',
                `${MAX_CONSECUTIVE_EMPTY} searches in a row showed no results list and no place panel (possible new interstitial); last landed on ${opened.landedUrl}`,
                ctx.now(),
                { searchId: s.id },
              );
              break;
            }
          } else {
            emptyStreak = 0;
            const feed = await scrollFeedToEnd(driver, config.maps.maxScrolls);
            const cards = await driver.snapshotCards();
            let newCount = 0;
            let position = 0;
            for (const snap of cards) {
              position++;
              const saved = await persistCard(pctx, runId, s.id, position, snap, parseCard(snap));
              if (!saved) {
                ctx.log.warn({ searchId: s.id, position, href: snap.href }, 'card skipped: no name or place id');
                continue;
              }
              if (saved.isNew) newCount++;
            }
            await logRequest(db, {
              runId,
              url,
              status: opened.status,
              ms: Date.now() - started,
              outcome: 'ok',
              note: 'search',
              at: ctx.now(),
            });
            await db
              .update(searches)
              .set({
                status: 'done',
                cardsFound: cards.length,
                newPlaceIds: newCount,
                endReached: feed.endReached,
                landedUrl: opened.landedUrl,
                finishedAt: ctx.now(),
              })
              .where(eq(searches.id, s.id));
            result.searchesDone++;
            result.cardsSeen += cards.length;
            result.newListings += newCount;
          }

          if (i < queue.length - 1) await ctx.sleep(randomPause(config.maps.searchPauseMs, deps.rng));
        }
      } finally {
        await driver?.close();
      }

      result.searchesRemaining = (await unfinished()).length;
      return result;
    },
  };
}

export const discoverStage: Stage<DiscoverInput, DiscoverResult> = createDiscoverStage();

