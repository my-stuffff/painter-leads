import type { DetailResult, StageContext, StageRegistry, StopInfo } from '@pp/core';
import { planSearches, resolveStages, runPilot, type PilotEnv, type RunOutcome } from '@pp/pipeline';
import type { ClaimedArea, AreaOutcome } from './queue';
import { jobStatus, setAreaRun } from './queue';
import { pipelineConfig } from './settings';
import { q1 } from './sql';

/** A city blocked this many times (claims) is finished with what it has. */
export const MAX_BLOCKED_ATTEMPTS = 6;
/** A city whose run threw this many times is marked failed. */
export const MAX_ERROR_ATTEMPTS = 3;
export const BLOCK_WAIT_MINUTES = 30;
export const ERROR_WAIT_MINUTES = 5;

export interface CityDeps {
  /** Stand-in stages for maps / sites / registries (tests, `pp worker --fake-stages`). */
  fake?: boolean;
  /** Use this stage registry instead of resolving one (tests). */
  stages?: StageRegistry;
  /** Base directory for run outputs (default: config.report.outDir). */
  outDir?: string;
  /** The detail pass behind `pp maps detail --retry-limited` (default: the registry's detail stage, retryLimited). */
  retryLimited?: (env: PilotEnv, runId: number, stages: StageRegistry) => Promise<DetailResult>;
}

const stageCtx = (env: PilotEnv, runId: number): StageContext => ({
  runId,
  config: env.config,
  db: env.db,
  evidence: env.evidence,
  fetcher: env.fetcher,
  log: env.log,
  now: () => env.now(),
  sleep: (ms) => env.sleep(ms),
});

/** The maps detail stage with retryLimited: what `pp maps detail --run N --retry-limited` runs. */
async function defaultRetryLimited(env: PilotEnv, runId: number, stages: StageRegistry): Promise<DetailResult> {
  return stages.detail.run(stageCtx(env, runId), { runId, retryLimited: true });
}

/** discover / detail that find nothing left to do, so runPilot goes straight on to merge ... report. */
function finishingStages(stages: StageRegistry): StageRegistry {
  return {
    ...stages,
    discover: {
      name: 'discover',
      run: async () => ({ searchesDone: 0, searchesRemaining: 0, cardsSeen: 0, newListings: 0, stopped: null }),
    },
    detail: { name: 'detail', run: async () => ({ done: 0, limitedView: 0, failed: 0, stopped: null }) },
  };
}

const hhmm = (d: Date): string => `${d.toISOString().slice(11, 16)} UTC`;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The next midnight UTC after `now` (the daily cap counts the container's day, which is UTC on Railway). */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** A finished run of the area younger than reuseDays (newest first), or null. */
export async function freshDoneRun(env: PilotEnv, areaId: string, reuseDays: number): Promise<{ id: number; finishedAt: Date } | null> {
  if (!(reuseDays > 0)) return null;
  const row = await q1<{ id: number; finished_at: Date }>(
    env.db,
    `SELECT id, finished_at FROM runs
     WHERE area_id = $1 AND status = 'done' AND finished_at IS NOT NULL AND finished_at > $2::timestamptz - make_interval(secs => $3)
     ORDER BY finished_at DESC, id DESC LIMIT 1`,
    [areaId, env.now(), reuseDays * 86400],
  );
  return row ? { id: row.id, finishedAt: row.finished_at } : null;
}

async function runStatus(env: PilotEnv, runId: number): Promise<{ status: string; areaId: string } | null> {
  const r = await q1<{ status: string; area_id: string }>(env.db, `SELECT status, area_id FROM runs WHERE id = $1`, [runId]);
  return r ? { status: r.status, areaId: r.area_id } : null;
}

/** The newest run of the area that is not done (pilot run --resume), or null. */
async function newestUnfinishedRun(env: PilotEnv, areaId: string): Promise<number | null> {
  const r = await q1<{ id: number }>(env.db, `SELECT id FROM runs WHERE area_id = $1 AND status <> 'done' ORDER BY id DESC LIMIT 1`, [
    areaId,
  ]);
  return r?.id ?? null;
}

/** Listings of the run whose place page Google never showed in full, and searches never done. */
async function leftovers(env: PilotEnv, runId: number): Promise<{ hidden: number; searches: number }> {
  const hidden = await q1<{ n: string }>(
    env.db,
    `SELECT COUNT(DISTINCT l.id) AS n FROM listings l
     JOIN search_hits h ON h.listing_id = l.id JOIN searches s ON s.id = h.search_id
     WHERE s.run_id = $1 AND l.detail_status IN ('limited_view', 'blocked')`,
    [runId],
  );
  const searches = await q1<{ n: string }>(env.db, `SELECT COUNT(*) AS n FROM searches WHERE run_id = $1 AND status <> 'done'`, [
    runId,
  ]);
  return { hidden: Number(hidden?.n ?? 0), searches: Number(searches?.n ?? 0) };
}

/**
 * Runs one claimed city with the existing engine and says how it ended:
 * a) a finished run younger than reuseDays is reused;
 * b) else the city's own run, or the newest unfinished run of the area, is resumed, or a new run is planned;
 * c) block / limited views: one retry-limited detail pass, runPilot again; still blocked -> waiting 30 min, and after
 *    MAX_BLOCKED_ATTEMPTS the run is finished with what it has; daily cap -> waiting until midnight UTC;
 *    an error -> waiting 5 min, failed after MAX_ERROR_ATTEMPTS.
 * The job's search terms replace config.search.terms; the thresholds stay the base config's (see pipelineConfig).
 */
export async function runCity(base: PilotEnv, workerId: string, area: ClaimedArea, deps: CityDeps = {}): Promise<AreaOutcome> {
  const env: PilotEnv = { ...base, config: pipelineConfig(base.config, area.settings) };
  const stages = deps.stages ?? resolveStages({ fake: deps.fake });
  const runOpts = { stages, outDir: deps.outDir };
  let runId: number | null = null;

  try {
    // The city's own run may already be done (the worker stopped after the run finished but before recording it).
    if (area.runId !== null) {
      const own = await runStatus(env, area.runId);
      if (own?.status === 'done' && own.areaId === area.areaId) return { status: 'done', runId: area.runId, message: null };
    }

    const fresh = await freshDoneRun(env, area.areaId, area.settings.reuseDays);
    if (fresh) return { status: 'reused', runId: fresh.id, message: `Used data from ${isoDay(fresh.finishedAt)}` };

    if (area.runId !== null) {
      const own = await runStatus(env, area.runId);
      if (own && own.areaId === area.areaId && own.status !== 'done') runId = area.runId;
    }
    runId ??= await newestUnfinishedRun(env, area.areaId);
    runId ??= (await planSearches(env.db, env.config, area.areaId)).runId;
    await setAreaRun(env.db, workerId, area.id, runId);

    let outcome: RunOutcome = await runPilot(env, area.areaId, { ...runOpts, runId });
    if (outcome.status === 'blocked') {
      env.log.info({ jobAreaId: area.id, runId, signal: outcome.stopped?.signal }, 'blocked: one retry-limited detail pass, then resume');
      await (deps.retryLimited ?? defaultRetryLimited)(env, runId, stages);
      outcome = await runPilot(env, area.areaId, { ...runOpts, runId });
    }
    return await settle(env, area, runId, outcome, stages, runOpts.outDir);
  } catch (e) {
    const msg = ((e as Error).message || 'unknown error').slice(0, 300);
    env.log.error({ jobAreaId: area.id, runId, err: msg }, 'city failed');
    if (area.attempts < MAX_ERROR_ATTEMPTS) {
      const at = new Date(env.now().getTime() + ERROR_WAIT_MINUTES * 60_000);
      return { status: 'waiting', runId, notBefore: at, message: `Error: ${msg} — trying again at ${hhmm(at)}` };
    }
    return { status: 'failed', runId, message: `Stopped after ${area.attempts} tries: ${msg}` };
  }
}

async function settle(
  env: PilotEnv,
  area: ClaimedArea,
  runId: number,
  outcome: RunOutcome,
  stages: StageRegistry,
  outDir: string | undefined,
): Promise<AreaOutcome> {
  if (outcome.status === 'done') return { status: 'done', runId, message: null };

  const stop = outcome.stopped as StopInfo | null;
  const cancelled = (await jobStatus(env.db, area.jobId)) === 'cancelled';

  if (stop?.signal === 'daily_cap') {
    if (cancelled) return { status: 'cancelled', runId, message: 'Cancelled' };
    const at = nextUtcMidnight(env.now());
    return { status: 'waiting', runId, notBefore: at, message: `Daily limit reached — continuing at ${hhmm(at)}` };
  }

  // Blocked (a block signal or a limited-view streak).
  if (area.attempts >= MAX_BLOCKED_ATTEMPTS) {
    // Finish the run with what it has: runPilot with nothing left to discover or open does merge ... report.
    const finished = await runPilot(env, area.areaId, { stages: finishingStages(stages), outDir, runId });
    if (finished.status !== 'done') return { status: 'failed', runId, message: 'Google kept blocking; the run could not be finished' };
    const left = await leftovers(env, runId);
    const extra = left.searches > 0 ? `; ${left.searches} searches not done` : '';
    return { status: 'done', runId, message: `Finished with ${left.hidden} listings Google kept hidden${extra}` };
  }
  if (cancelled) return { status: 'cancelled', runId, message: 'Cancelled' };
  const at = new Date(env.now().getTime() + BLOCK_WAIT_MINUTES * 60_000);
  return { status: 'waiting', runId, notBefore: at, message: `Google is limiting views — trying again at ${hhmm(at)}` };
}
