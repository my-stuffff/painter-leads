import { schema, type Db, type RequestOutcome } from '@pp/core';
import { and, count, eq, gte } from 'drizzle-orm';
import { MAPS_HOST } from './version';

export type RequestKind = 'search' | 'place';

/** Midnight (local time) at the start of the day `now` falls in. */
export function startOfLocalDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** How many Maps navigations of this kind the request log already holds for today. */
export async function requestsToday(db: Db, kind: RequestKind, now: Date): Promise<number> {
  const { requestLog } = schema;
  const rows = await db
    .select({ n: count() })
    .from(requestLog)
    .where(and(eq(requestLog.source, 'maps'), eq(requestLog.note, kind), gte(requestLog.at, startOfLocalDay(now))));
  return Number(rows[0]?.n ?? 0);
}

/** Requests left under the daily cap (never negative). */
export async function remainingToday(db: Db, kind: RequestKind, cap: number, now: Date = new Date()): Promise<number> {
  return Math.max(0, cap - (await requestsToday(db, kind, now)));
}

export interface LoggedRequest {
  runId: number | null;
  url: string;
  status: number | null;
  ms: number;
  outcome: RequestOutcome;
  note: string;
  at: Date;
}

/** One request_log row per Maps navigation, with its outcome. */
export async function logRequest(db: Db, r: LoggedRequest): Promise<void> {
  await db.insert(schema.requestLog).values({
    at: r.at,
    source: 'maps',
    host: MAPS_HOST,
    method: 'GET',
    url: r.url,
    status: r.status,
    bytes: null,
    ms: Math.round(r.ms),
    outcome: r.outcome,
    runId: r.runId,
    note: r.note,
  });
}
