import { schema, type Db, type PpConfig } from '@pp/core';
import { and, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { requestsToday } from './cap';

export interface MapsStatus {
  runId: number;
  runStatus: string;
  stoppedReason: string | null;
  searches: Record<string, number>;
  listingsByDetailStatus: Record<string, number>;
  /** Listings with a NULL value, grouped by why it is NULL. */
  nullRatingByStatus: Record<string, number>;
  nullReviewCountByStatus: Record<string, number>;
  requestsToday: { searches: number; placePages: number };
  caps: { searches: number; placePages: number };
  lastBlockSignal: string | null;
}

const toRecord = (rows: { key: string; n: number | string }[]): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));

export async function collectStatus(db: Db, runId: number, config: PpConfig, now: Date): Promise<MapsStatus> {
  const { runs, searches, searchHits, listings } = schema;
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) throw new Error(`run ${runId} does not exist`);

  const bySearch = await db
    .select({ key: searches.status, n: count() })
    .from(searches)
    .where(eq(searches.runId, runId))
    .groupBy(searches.status);

  const reached = db
    .select({ id: searchHits.listingId })
    .from(searchHits)
    .innerJoin(searches, eq(searches.id, searchHits.searchId))
    .where(eq(searches.runId, runId));
  const inRun = inArray(listings.id, reached);

  const byDetail = await db
    .select({ key: listings.detailStatus, n: count() })
    .from(listings)
    .where(inRun)
    .groupBy(listings.detailStatus);
  const nullRating = await db
    .select({ key: listings.ratingStatus, n: count() })
    .from(listings)
    .where(and(inRun, isNull(listings.rating)))
    .groupBy(listings.ratingStatus);
  const nullReviews = await db
    .select({ key: listings.reviewCountStatus, n: count() })
    .from(listings)
    .where(and(inRun, isNull(listings.reviewCount)))
    .groupBy(listings.reviewCountStatus);

  const [lastBlock] = await db
    .select({ signal: searches.blockSignal })
    .from(searches)
    .where(and(eq(searches.runId, runId), isNotNull(searches.blockSignal)))
    .orderBy(desc(searches.finishedAt))
    .limit(1);

  return {
    runId,
    runStatus: run.status,
    stoppedReason: run.stoppedReason,
    searches: toRecord(bySearch),
    listingsByDetailStatus: toRecord(byDetail),
    nullRatingByStatus: toRecord(nullRating),
    nullReviewCountByStatus: toRecord(nullReviews),
    requestsToday: {
      searches: await requestsToday(db, 'search', now),
      placePages: await requestsToday(db, 'place', now),
    },
    caps: { searches: config.maps.dailyCap.searches, placePages: config.maps.dailyCap.placePages },
    lastBlockSignal: lastBlock?.signal ?? null,
  };
}
