import { getArea, schema, type DetailInput, type DetailResult, type Stage, type StageContext } from '@pp/core';
import { and, asc, eq, inArray, lt, or } from 'drizzle-orm';
import { detectBlock } from './blocks';
import { logRequest, remainingToday } from './cap';
import { defaultDriverFactory, requestOutcomeFor } from './discover';
import type { PageDriver } from './driver/types';
import { parsePlace } from './parse/place';
import { withLocale } from './parse/url';
import { persistPlace, type PersistCtx } from './persist';
import { createPinSkipper } from './pin-skip';
import { recentRunBlock, resumeRun, stopRun } from './run-state';
import { randomPause } from './throttle';
import { isBrowserCrash, MAX_CRASH_STREAK, MAX_TRANSIENT_STREAK, openWithRetry } from './transient';

export interface DetailDeps {
  driverFactory?: (ctx: StageContext) => Promise<PageDriver>;
  rng?: () => number;
}

/** A listing whose place page showed no review count is retried this many times at most. */
export const MAX_LIMITED_ATTEMPTS = 3;

type ListingRow = typeof schema.listings.$inferSelect;

/**
 * Drops the listings whose map pin is clearly outside the run's area (farther than PIN_SKIP_KM from every ZIP
 * polygon, expansion ZIPs included): no place page is opened for them. They keep detail_status 'pending' (no
 * existing status fits and the status list is frozen); the area step later puts their company outside the pilot
 * area from the same pin. A listing without a pin is always kept.
 */
async function withoutFarListings(ctx: StageContext, runId: number, queue: ListingRow[]): Promise<ListingRow[]> {
  const [run] = await ctx.db.select({ areaId: schema.runs.areaId }).from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
  if (!run || queue.length === 0) return queue;
  const farKm = createPinSkipper(getArea(ctx.config, run.areaId));
  const kept: ListingRow[] = [];
  let skipped = 0;
  for (const listing of queue) {
    const km =
      listing.coordsStatus === 'captured' && listing.lat !== null && listing.lng !== null ? farKm(listing.lat, listing.lng) : null;
    if (km === null) {
      kept.push(listing);
      continue;
    }
    skipped++;
    ctx.log.debug(
      { listingId: listing.id, name: listing.name, km: Math.round(km * 10) / 10 },
      `place page not opened: outside pilot area (card pin ${km.toFixed(1)} km away)`,
    );
  }
  if (skipped > 0) ctx.log.info({ runId, skipped }, `${skipped} listings skipped: card pin outside the pilot area`);
  return kept;
}

export function createDetailStage(deps: DetailDeps = {}): Stage<DetailInput, DetailResult> {
  return {
    name: 'detail',
    async run(ctx, input) {
      const { db, config } = ctx;
      const { runId } = input;
      const { listings, searchHits, searches } = schema;
      const result: DetailResult = { done: 0, limitedView: 0, failed: 0, stopped: null };

      const backoff = await recentRunBlock(db, runId, ctx.now(), config.maps.blockBackoffMinutes);
      if (backoff) {
        result.stopped = backoff;
        return result;
      }

      const reached = db
        .select({ id: searchHits.listingId })
        .from(searchHits)
        .innerJoin(searches, eq(searches.id, searchHits.searchId))
        .where(eq(searches.runId, runId));
      const wanted = input.retryLimited
        ? or(
            inArray(listings.detailStatus, ['pending', 'blocked']),
            and(eq(listings.detailStatus, 'limited_view'), lt(listings.detailAttempts, MAX_LIMITED_ATTEMPTS)),
          )
        : inArray(listings.detailStatus, ['pending', 'blocked']);
      let queue = await db
        .select()
        .from(listings)
        .where(and(inArray(listings.id, reached), wanted))
        .orderBy(asc(listings.id));
      queue = await withoutFarListings(ctx, runId, queue);
      if (input.limit !== undefined) queue = queue.slice(0, input.limit);
      if (queue.length === 0) return result;

      await resumeRun(db, runId, ctx.now());
      const pctx: PersistCtx = { db, evidence: ctx.evidence, now: () => ctx.now() };
      // config.maps.placeConcurrency workers, each with its own page driver, take listings from one shared queue.
      // The streaks and the stop are shared, so "in a row" counts across workers, and one stop halts them all.
      let next = 0;
      let streak = 0;
      let transientStreak = 0;
      let crashStreak = 0;
      const crashRetried = new Set<number>();
      let crashed = false;
      const halt = async (...args: Parameters<typeof stopRun>): Promise<void> => {
        const stopped = await stopRun(...args);
        result.stopped ??= stopped;
      };

      const worker = async (): Promise<void> => {
        let driver: PageDriver | null = null;
        try {
          while (result.stopped === null && !crashed) {
            const i = next++;
            const listing = queue[i];
            if (!listing) break;

            if ((await remainingToday(db, 'place', config.maps.dailyCap.placePages, ctx.now())) <= 0) {
              await halt(db, runId, 'daily_cap', `${config.maps.dailyCap.placePages} place pages already logged today`, ctx.now(), {
                listingId: listing.id,
              });
              break;
            }

            const url = withLocale(listing.profileUrl);
            try {
              driver ??= await (deps.driverFactory ?? defaultDriverFactory)(ctx);
              const attempt = await openWithRetry(driver, url, {
                db,
                runId,
                kind: 'place',
                now: () => ctx.now(),
                sleep: ctx.sleep,
                rng: deps.rng,
                log: ctx.log,
              });
              if (!attempt.ok) {
                // Slow page, not a block: the listing keeps its status (still wanted by the next run) and its card data.
                transientStreak++;
                if (transientStreak >= MAX_TRANSIENT_STREAK) {
                  await halt(
                    db,
                    runId,
                    'daily_cap',
                    `network looks down: ${transientStreak} place pages in a row did not load (listing ${listing.id} last: ${attempt.error.message.split('\n')[0]})`,
                    ctx.now(),
                    { listingId: listing.id },
                  );
                  break;
                }
                if (next < queue.length) await ctx.sleep(randomPause(config.maps.placePauseMs, deps.rng));
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
                  note: 'place',
                  at: ctx.now(),
                });
                await db.update(listings).set({ detailStatus: 'blocked' }).where(eq(listings.id, listing.id));
                await halt(db, runId, block, `place page of listing ${listing.id} landed on ${opened.landedUrl}`, ctx.now(), {
                  listingId: listing.id,
                });
                break;
              }

              const snapshot = await driver.snapshotPlace();
              const parsed = parsePlace(snapshot);
              const saved = await persistPlace(pctx, runId, listing, snapshot, parsed);
              await logRequest(db, {
                runId,
                url,
                status: opened.status,
                ms: Date.now() - started,
                outcome: saved.outcome === 'done' ? 'ok' : saved.outcome === 'limited_view' ? 'limited_view' : 'http_error',
                note: 'place',
                at: ctx.now(),
              });

              if (saved.outcome === 'done') {
                result.done++;
                streak = 0;
              } else if (saved.outcome === 'limited_view') {
                result.limitedView++;
                streak++;
                if (streak >= config.maps.limitedViewStreakStop) {
                  await halt(
                    db,
                    runId,
                    'limited_view_streak',
                    `${streak} place pages in a row showed no review count (listing ${listing.id} last)`,
                    ctx.now(),
                    { listingId: listing.id },
                  );
                  break;
                }
              } else {
                result.failed++;
                streak = 0;
              }

            } catch (e) {
              if (!isBrowserCrash(e)) throw e;
              // The browser died under this page (out of memory): the listing keeps its status and goes to the back of
              // the queue once, and this worker starts a fresh browser.
              crashStreak++;
              ctx.log.warn(
                { listingId: listing.id, crashStreak, message: (e as Error).message.split('\n')[0] },
                'browser crashed; place page retried later on a fresh browser',
              );
              if (!crashRetried.has(listing.id)) {
                crashRetried.add(listing.id);
                queue.push(listing);
              }
              const dead = driver;
              driver = null;
              await dead?.close().catch(() => undefined);
              if (crashStreak >= MAX_CRASH_STREAK) throw e;
              continue;
            }
            crashStreak = 0;

            if (next < queue.length) await ctx.sleep(randomPause(config.maps.placePauseMs, deps.rng));
          }
        } catch (e) {
          crashed = true; // the other workers finish their current page and stop; the error is rethrown below
          throw e;
        } finally {
          await driver?.close();
        }
      };

      const workers = Math.min(config.maps.placeConcurrency, queue.length);
      const settled = await Promise.allSettled(Array.from({ length: workers }, () => worker()));
      const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failure) throw failure.reason;
      return result;
    },
  };
}

export const detailStage: Stage<DetailInput, DetailResult> = createDetailStage();

