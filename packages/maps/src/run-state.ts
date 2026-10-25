import { schema, type BlockSignal, type Db, type StopInfo } from '@pp/core';
import { eq } from 'drizzle-orm';
import { isBlockSignal } from './blocks';

const SIGNALS: readonly BlockSignal[] = [
  'sorry',
  'captcha',
  'unusual_traffic',
  'limited_view_streak',
  'daily_cap',
  'http_403',
];

/** Marks the run stopped: 'blocked' for a block signal, 'stopped' for a clean stop (daily cap). */
export async function stopRun(
  db: Db,
  runId: number,
  signal: BlockSignal,
  detail: string,
  now: Date,
  ids: { searchId?: number | null; listingId?: number | null } = {},
): Promise<StopInfo> {
  await db
    .update(schema.runs)
    .set({
      status: isBlockSignal(signal) ? 'blocked' : 'stopped',
      stoppedReason: `${signal}: ${detail}`,
      finishedAt: now,
    })
    .where(eq(schema.runs.id, runId));
  return { signal, searchId: ids.searchId ?? null, listingId: ids.listingId ?? null, at: now, detail };
}

/** Marks the run as running again (after a block back-off or a clean stop). */
export async function resumeRun(db: Db, runId: number, now: Date): Promise<void> {
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
  if (!run) throw new Error(`run ${runId} does not exist`);
  await db
    .update(schema.runs)
    .set({ status: 'running', stoppedReason: null, finishedAt: null, startedAt: run.startedAt ?? now })
    .where(eq(schema.runs.id, runId));
}

/** The signal recorded in runs.stopped_reason ("<signal>: <detail>"), or null. */
export function signalFromReason(reason: string | null): BlockSignal | null {
  if (!reason) return null;
  const head = reason.split(':')[0]?.trim();
  return SIGNALS.find((s) => s === head) ?? null;
}

/**
 * When the run was blocked less than `backoffMinutes` ago, the StopInfo to return without opening anything.
 * Used by the detail stage (the discover stage reads the blocked search rows instead).
 */
export async function recentRunBlock(db: Db, runId: number, now: Date, backoffMinutes: number): Promise<StopInfo | null> {
  const [run] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId)).limit(1);
  if (!run) throw new Error(`run ${runId} does not exist`);
  if (run.status !== 'blocked' || !run.finishedAt) return null;
  const signal = signalFromReason(run.stoppedReason);
  if (!signal) return null;
  const until = run.finishedAt.getTime() + backoffMinutes * 60_000;
  if (now.getTime() >= until) return null;
  return {
    signal,
    searchId: null,
    listingId: null,
    at: now,
    detail: `backing off after ${run.stoppedReason} until ${new Date(until).toISOString()}`,
  };
}
