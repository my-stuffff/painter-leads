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
import { isBrowserCrash, MAX_CRASH_STREAK, MAX_TRANSIENT_STREAK, openWithRetry } from './transient';

export interface DiscoverDeps {
  /** Builds the browser page for one stage run. Tests pass a FixtureDriver; the default launches Chromium. */
  driverFactory?: (ctx: StageContext) => Promise<PageDriver>;
  rng?: () => number;
  queryForm?: QueryForm;
}

/** Three searches in a row that show neither a results list nor a place panel look like an unknown interstitial. */
const MAX_CONSECUTIVE_EMPTY = 3;

export const defaultDriverFactory = (ctx: StageContext): Promise<PageDriver> => PlaywrightDriver.launch(ctx.config);

/** Runs each call only after every earlier call has finished, in the order they were made. */
function serial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function requestOutcomeFor(signal: BlockSignal): 'sorry' | 'captcha' | 'blocked' {
  if (signal === 'sorry') return 'sorry';
  if (signal === 'captcha') return 'captcha';
  return 'blocked';
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
      // config.maps.searchConcurrency workers, each with its own page driver, take searches from one shared queue.
      // The streaks and the stop are shared, so "in a row" counts across workers, and one stop halts them all.
      // Listing writes go one card at a time (persisting), so two searches that find the same business at
      // once never both create it, double its evidence or both count it as new.
      let next = 0;
      let emptyStreak = 0;
      let transientStreak = 0;
      let crashStreak = 0;
      let cardErrorStreak = 0;
      let crashed = false;
      const persisting = serial();
      const halt = async (...args: Parameters<typeof stopRun>): Promise<void> => {
        const stopped = await stopRun(...args);
        result.stopped ??= stopped;
      };

      const worker = async (): Promise<void> => {
        let driver: PageDriver | null = null;
        try {
          while (result.stopped === null && !crashed) {
            const s = queue[next++];
            if (!s) break;

            // Daily cap, checked before every navigation.
            if ((await remainingToday(db, 'search', config.maps.dailyCap.searches, ctx.now())) <= 0) {
              await halt(db, runId, 'daily_cap', `${config.maps.dailyCap.searches} searches already logged today`, ctx.now());
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

            try {
              driver ??= await makeDriver();
              // A non-transient error is thrown: the search stays 'running' and a re-run retries it.
              const attempt = await openWithRetry(driver, url, {
                db,
                runId,
                kind: 'search',
                now: () => ctx.now(),
                sleep: ctx.sleep,
                rng: deps.rng,
                log: ctx.log,
              });
              if (!attempt.ok) {
                // Slow page, not a block: leave the search pending (nothing stored for it) and carry on with the next one.
                await db.update(searches).set({ status: 'pending' }).where(eq(searches.id, s.id));
                transientStreak++;
                if (transientStreak >= MAX_TRANSIENT_STREAK) {
                  await halt(
                    db,
                    runId,
                    'daily_cap',
                    `network looks down: ${transientStreak} searches in a row did not load (search ${s.id} last: ${attempt.error.message.split('\n')[0]})`,
                    ctx.now(),
                    { searchId: s.id },
                  );
                  break;
                }
                if (next < queue.length) await ctx.sleep(randomPause(config.maps.searchPauseMs, deps.rng));
                continue;
              }
              transientStreak = 0;
              const { opened, started } = attempt;
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
                await halt(db, runId, block, `search ${s.id} (${s.query}) landed on ${opened.landedUrl}`, ctx.now(), {
                  searchId: s.id,
                });
                break;
              }

              if (!signals.hasFeed && signals.hasPlacePanel) {
                // The search landed straight on one place page: that is one listing.
                const snapshot = await driver.snapshotPlace();
                const parsed = parsePlace(snapshot);
                const { placed, isNew } = await persisting(async () => {
                  const placed = await persistPlace(pctx, runId, null, snapshot, parsed);
                  let isNew = 0;
                  if (placed.listingId !== null) {
                    const hit = await db
                      .insert(schema.searchHits)
                      .values({ searchId: s.id, listingId: placed.listingId, position: 1, isNew: placed.inserted })
                      .onConflictDoNothing({ target: [schema.searchHits.searchId, schema.searchHits.listingId] })
                      .returning({ id: schema.searchHits.id });
                    if (hit.length > 0 && placed.inserted) isNew = 1;
                  }
                  return { placed, isNew };
                });
                await logRequest(db, {
                  runId,
                  url,
                  status: opened.status,
                  ms: Date.now() - started,
                  outcome: parsed.limitedView ? 'limited_view' : 'ok',
                  note: 'search',
                  at: ctx.now(),
                });
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
                  await halt(
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
                  const at = position;
                  let saved: Awaited<ReturnType<typeof persistCard>>;
                  try {
                    saved = await persisting(() => persistCard(pctx, runId, s.id, at, snap, parseCard(snap)));
                    cardErrorStreak = 0;
                  } catch (e) {
                    // One card the database refuses is skipped (a missing listing, never a wrong one); many in a row is a real fault.
                    cardErrorStreak++;
                    const cause = (e as { cause?: unknown }).cause;
                    ctx.log.warn(
                      { searchId: s.id, position, href: snap.href, cause: cause instanceof Error ? cause.message : String(cause) },
                      'card skipped: could not be stored',
                    );
                    if (cardErrorStreak >= 10) throw e;
                    continue;
                  }
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

            } catch (e) {
              if (!isBrowserCrash(e)) throw e;
              // The browser died under this search (out of memory): the search goes back to pending for the next
              // pass and this worker starts a fresh browser.
              crashStreak++;
              ctx.log.warn(
                { searchId: s.id, crashStreak, message: (e as Error).message.split('\n')[0] },
                'browser crashed; search left pending, fresh browser next',
              );
              await db.update(searches).set({ status: 'pending' }).where(eq(searches.id, s.id));
              const dead = driver;
              driver = null;
              await dead?.close().catch(() => undefined);
              if (crashStreak >= MAX_CRASH_STREAK) throw e;
              continue;
            }
            crashStreak = 0;

            if (next < queue.length) await ctx.sleep(randomPause(config.maps.searchPauseMs, deps.rng));
          }
        } catch (e) {
          crashed = true; // the other workers finish their current search and stop; the error is rethrown below
          throw e;
        } finally {
          await driver?.close();
        }
      };

      const workers = Math.min(config.maps.searchConcurrency, queue.length);
      const settled = await Promise.allSettled(Array.from({ length: workers }, () => worker()));
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failure) throw failure.reason;

      result.searchesRemaining = (await unfinished()).length;
      return result;
    },
  };
}

export const discoverStage: Stage<DiscoverInput, DiscoverResult> = createDiscoverStage();

