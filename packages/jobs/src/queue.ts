import type { Db } from '@pp/core';
import type { JobAreaStatus, JobSettings, JobStatus, StateCode } from './contract';
import { readSettings } from './settings';
import { inTransaction, q, q1 } from './sql';

/** pg_advisory_xact_lock key that serialises claims across workers. */
export const CLAIM_LOCK_KEY = 4242;
/** A running city whose heartbeat is older than this belongs to a worker that died: it can be claimed again. */
export const STALE_MINUTES = 10;
/** Statuses a city never leaves on its own. */
export const TERMINAL_AREA_STATUSES: readonly JobAreaStatus[] = ['done', 'reused', 'failed', 'cancelled'];

const TERMINAL_SQL = `('done', 'reused', 'failed', 'cancelled')`;

/** One city a worker has claimed, with its job's settings. */
export interface ClaimedArea {
  id: number;
  jobId: number;
  areaId: string;
  state: StateCode;
  label: string;
  position: number;
  runId: number | null;
  /** Claims so far, this one included. */
  attempts: number;
  settings: JobSettings;
  jobStatus: JobStatus;
}

interface AreaRaw {
  id: number;
  job_id: number;
  area_id: string;
  state: StateCode;
  label: string;
  position: number;
  run_id: number | null;
  attempts: number;
}

/**
 * Registers (or re-registers) the worker. Cities this worker id still holds as running were cut off by a restart:
 * they go back to queued. Returns how many were put back.
 */
export async function registerWorker(db: Db, workerId: string, note: string | null = null): Promise<number> {
  await q(
    db,
    `INSERT INTO workers (id, started_at, last_seen_at, job_area_id, note) VALUES ($1, now(), now(), NULL, $2)
     ON CONFLICT (id) DO UPDATE SET started_at = now(), last_seen_at = now(), job_area_id = NULL, note = EXCLUDED.note`,
    [workerId, note],
  );
  const reset = await q(
    db,
    `UPDATE job_areas SET status = 'queued', worker_id = NULL, heartbeat_at = NULL
     WHERE status = 'running' AND worker_id = $1 RETURNING id`,
    [workerId],
  );
  return reset.length;
}

/** The worker is alive; so is the city it is running (when it still holds it). */
export async function heartbeat(db: Db, workerId: string, jobAreaId: number | null): Promise<void> {
  await q(db, `UPDATE workers SET last_seen_at = now(), job_area_id = $2 WHERE id = $1`, [workerId, jobAreaId]);
  if (jobAreaId !== null) {
    await q(db, `UPDATE job_areas SET heartbeat_at = now() WHERE id = $1 AND worker_id = $2 AND status = 'running'`, [
      jobAreaId,
      workerId,
    ]);
  }
}

/**
 * Claims the next city, under an advisory lock so two workers never take the same one: oldest job first, then
 * position. A city is claimable when queued, waiting past its not_before, or running with a heartbeat older than
 * STALE_MINUTES (its worker died). A state that already has a live running city is skipped (merges in a state
 * re-point shared listings). Only cities of queued / running jobs are claimed (never a cancelled job's).
 */
export async function claimNext(db: Db, workerId: string): Promise<ClaimedArea | null> {
  return inTransaction(db, async (tx) => {
    await q(tx, `SELECT pg_advisory_xact_lock($1)`, [CLAIM_LOCK_KEY]);
    const row = await q1<AreaRaw>(
      tx,
      `UPDATE job_areas a
         SET status = 'running', worker_id = $1, heartbeat_at = now(), attempts = a.attempts + 1,
             started_at = COALESCE(a.started_at, now()), not_before = NULL, message = NULL
       WHERE a.id = (
         SELECT c.id FROM job_areas c JOIN jobs j ON j.id = c.job_id
         WHERE j.status IN ('queued', 'running')
           AND (c.status = 'queued'
             OR (c.status = 'waiting' AND (c.not_before IS NULL OR c.not_before <= now()))
             OR (c.status = 'running' AND (c.heartbeat_at IS NULL OR c.heartbeat_at < now() - make_interval(mins => $2))))
           AND NOT EXISTS (
             SELECT 1 FROM job_areas o
             WHERE o.state = c.state AND o.id <> c.id AND o.status = 'running'
               AND o.heartbeat_at >= now() - make_interval(mins => $2))
         ORDER BY c.job_id, c.position, c.id
         LIMIT 1)
       RETURNING a.id, a.job_id, a.area_id, a.state, a.label, a.position, a.run_id, a.attempts`,
      [workerId, STALE_MINUTES],
    );
    if (!row) return null;
    const job = await q1<{ status: JobStatus; settings: unknown }>(
      tx,
      `UPDATE jobs SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
                       started_at = COALESCE(started_at, now())
       WHERE id = $1 RETURNING status, settings`,
      [row.job_id],
    );
    await q(tx, `UPDATE workers SET job_area_id = $2, last_seen_at = now() WHERE id = $1`, [workerId, row.id]);
    return {
      id: row.id,
      jobId: row.job_id,
      areaId: row.area_id,
      state: row.state,
      label: row.label,
      position: row.position,
      runId: row.run_id,
      attempts: row.attempts,
      settings: readSettings(job?.settings),
      jobStatus: job?.status ?? 'running',
    };
  });
}

/** Saves the run a claimed city is using, as soon as it is known. */
export async function setAreaRun(db: Db, workerId: string, jobAreaId: number, runId: number): Promise<void> {
  await q(db, `UPDATE job_areas SET run_id = $3 WHERE id = $1 AND worker_id = $2`, [jobAreaId, workerId, runId]);
}

/** How a claimed city ended this time. */
export interface AreaOutcome {
  status: Exclude<JobAreaStatus, 'queued' | 'running'>;
  runId?: number | null;
  notBefore?: Date | null;
  message?: string | null;
}

/**
 * Records the outcome, only while this worker still holds the city (a city taken over as stale is left alone).
 * Returns false when the city was no longer ours.
 */
export async function finishArea(db: Db, workerId: string, jobAreaId: number, o: AreaOutcome): Promise<boolean> {
  const terminal = TERMINAL_AREA_STATUSES.includes(o.status);
  const rows = await q(
    db,
    `UPDATE job_areas
       SET status = $3, run_id = COALESCE($4, run_id), not_before = $5, message = $6,
           finished_at = CASE WHEN $7::boolean THEN now() ELSE NULL END
     WHERE id = $1 AND worker_id = $2 AND status = 'running'
     RETURNING id`,
    [jobAreaId, workerId, o.status, o.runId ?? null, o.notBefore ?? null, o.message ?? null, terminal],
  );
  await q(db, `UPDATE workers SET job_area_id = NULL, last_seen_at = now() WHERE id = $1`, [workerId]);
  return rows.length > 0;
}

/** Hands a running city back to the queue (the worker is shutting down); its run is resumed by the next claim. */
export async function releaseArea(db: Db, workerId: string, jobAreaId: number): Promise<void> {
  await q(
    db,
    `UPDATE job_areas SET status = 'queued', worker_id = NULL, heartbeat_at = NULL,
            attempts = GREATEST(attempts - 1, 0), message = 'Worker restarted; continues shortly'
     WHERE id = $1 AND worker_id = $2 AND status = 'running'`,
    [jobAreaId, workerId],
  );
  await q(db, `UPDATE workers SET job_area_id = NULL, last_seen_at = now() WHERE id = $1`, [workerId]);
}

/**
 * Cities of cancelled jobs that will never run: queued or waiting ones, and running ones whose worker died.
 * (The web marks queued ones itself; waiting and orphaned ones are swept here so the job can finish.)
 */
export async function sweepCancelled(db: Db): Promise<number> {
  const rows = await q(
    db,
    `UPDATE job_areas a SET status = 'cancelled', finished_at = now(), not_before = NULL, message = 'Cancelled'
     FROM jobs j
     WHERE j.id = a.job_id AND j.status = 'cancelled'
       AND (a.status IN ('queued', 'waiting')
         OR (a.status = 'running' AND (a.heartbeat_at IS NULL OR a.heartbeat_at < now() - make_interval(mins => $1))))
     RETURNING a.id`,
    [STALE_MINUTES],
  );
  return rows.length;
}

/** The job's status now (null when it was deleted). */
export async function jobStatus(db: Db, jobId: number): Promise<JobStatus | null> {
  return (await q1<{ status: JobStatus }>(db, `SELECT status FROM jobs WHERE id = $1`, [jobId]))?.status ?? null;
}

/**
 * Jobs whose cities are all finished and whose export is due: a queued / running job (its last city just ended)
 * or any job whose export_status was set back to 'none' (the web's "rebuild").
 */
export async function jobsReadyToFinish(db: Db): Promise<number[]> {
  const rows = await q<{ id: number }>(
    db,
    `SELECT j.id FROM jobs j
     WHERE j.export_status <> 'building'
       AND (j.export_status = 'none' OR j.status IN ('queued', 'running'))
       AND EXISTS (SELECT 1 FROM job_areas a WHERE a.job_id = j.id)
       AND NOT EXISTS (SELECT 1 FROM job_areas a WHERE a.job_id = j.id AND a.status NOT IN ${TERMINAL_SQL})
     ORDER BY j.id`,
  );
  return rows.map((r) => r.id);
}

/** Takes the export build of a finished job for this worker (false when not due, or another worker took it). */
export async function takeExportBuild(db: Db, jobId: number): Promise<boolean> {
  const rows = await q(
    db,
    `UPDATE jobs SET export_status = 'building', export_error = NULL
     WHERE id = $1 AND export_status <> 'building'
       AND (export_status = 'none' OR status IN ('queued', 'running'))
       AND EXISTS (SELECT 1 FROM job_areas a WHERE a.job_id = jobs.id)
       AND NOT EXISTS (SELECT 1 FROM job_areas a WHERE a.job_id = jobs.id AND a.status NOT IN ${TERMINAL_SQL})
     RETURNING id`,
    [jobId],
  );
  return rows.length > 0;
}
