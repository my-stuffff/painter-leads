import type { Db, PpConfig } from '@pp/core';
import type { JobAreaStatus, JobStatus, StateCode } from './contract';
import { buildExport, type BuiltExport, type ExportArea, type ExportInput } from './export';
import { jobsReadyToFinish, takeExportBuild } from './queue';
import { readSettings } from './settings';
import { q, q1 } from './sql';

/** The export input of a job from its rows: the done / reused cities in position order, the others named as left out. */
export async function loadExportInput(db: Db, jobId: number): Promise<ExportInput> {
  const job = await q1<{ name: string; settings: unknown }>(db, `SELECT name, settings FROM jobs WHERE id = $1`, [jobId]);
  if (!job) throw new Error(`Unknown job ${jobId}`);
  const areas = await q<{ area_id: string; label: string; state: StateCode; status: JobAreaStatus; run_id: number | null }>(
    db,
    `SELECT area_id, label, state, status, run_id FROM job_areas WHERE job_id = $1 ORDER BY position, id`,
    [jobId],
  );
  const included: ExportArea[] = [];
  const leftOut: { label: string; status: string }[] = [];
  for (const a of areas) {
    if ((a.status === 'done' || a.status === 'reused') && a.run_id !== null) {
      included.push({ areaId: a.area_id, label: a.label, state: a.state, runId: a.run_id });
    } else {
      leftOut.push({ label: a.label, status: a.status });
    }
  }
  return { name: job.name, settings: readSettings(job.settings), areas: included, leftOut };
}

/** Writes (or replaces) the job's stored export. */
export async function saveJobExport(db: Db, jobId: number, built: BuiltExport): Promise<void> {
  await q(
    db,
    `INSERT INTO job_exports (job_id, built_at, xlsx, csv, rows, summary) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     ON CONFLICT (job_id) DO UPDATE SET built_at = EXCLUDED.built_at, xlsx = EXCLUDED.xlsx, csv = EXCLUDED.csv,
       rows = EXCLUDED.rows, summary = EXCLUDED.summary`,
    [jobId, new Date(built.summary.builtAt), built.xlsx, built.csv, JSON.stringify(built.rows), JSON.stringify(built.summary)],
  );
}

export interface FinishResult {
  jobId: number;
  status: JobStatus;
  exportStatus: 'ready' | 'failed';
  exportError: string | null;
}

/**
 * Builds the export of a job whose cities are all finished, then settles the job: done (or failed when no city
 * finished; a cancelled job stays cancelled). Returns null when the job is not due or another worker took it.
 * The caller must have taken the build (takeExportBuild) — finishJob does it.
 */
async function buildTakenJob(db: Db, base: PpConfig, jobId: number, log?: (line: string) => void): Promise<FinishResult> {
  const input = await loadExportInput(db, jobId);
  if (input.areas.length === 0) {
    const error = 'No city finished';
    const row = await q1<{ status: JobStatus }>(
      db,
      `UPDATE jobs SET export_status = 'failed', export_error = $2,
              status = CASE WHEN status IN ('queued', 'running') THEN 'failed' ELSE status END,
              error = CASE WHEN status IN ('queued', 'running') THEN $2 ELSE error END,
              finished_at = COALESCE(finished_at, now())
       WHERE id = $1 RETURNING status`,
      [jobId, error],
    );
    return { jobId, status: row?.status ?? 'failed', exportStatus: 'failed', exportError: error };
  }
  let exportError: string | null = null;
  try {
    const built = await buildExport(db, base, { ...input, log });
    await saveJobExport(db, jobId, built);
  } catch (e) {
    exportError = (e as Error).message.slice(0, 500) || 'export failed';
  }
  const row = await q1<{ status: JobStatus }>(
    db,
    `UPDATE jobs SET export_status = $2, export_error = $3,
            status = CASE WHEN status IN ('queued', 'running') THEN 'done' ELSE status END,
            finished_at = COALESCE(finished_at, now())
     WHERE id = $1 RETURNING status`,
    [jobId, exportError === null ? 'ready' : 'failed', exportError],
  );
  return { jobId, status: row?.status ?? 'done', exportStatus: exportError === null ? 'ready' : 'failed', exportError };
}

/** Finishes one job if its cities are all finished and its export is due (see jobsReadyToFinish). */
export async function finishJob(db: Db, base: PpConfig, jobId: number, log?: (line: string) => void): Promise<FinishResult | null> {
  if (!(await takeExportBuild(db, jobId))) return null;
  return buildTakenJob(db, base, jobId, log);
}

/** Every job that is due: finished jobs whose export was not built yet, and rebuild requests. */
export async function finishReadyJobs(db: Db, base: PpConfig, log?: (line: string) => void): Promise<FinishResult[]> {
  const out: FinishResult[] = [];
  for (const id of await jobsReadyToFinish(db)) {
    const r = await finishJob(db, base, id, log);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Rebuilds a job's export now (pp jobs export <jobId>), whatever its export status, unless a build is running.
 * Cities still running are left out of this build (they are not finished); the job's own status is not changed
 * unless all its cities are finished.
 */
export async function rebuildJobExport(db: Db, base: PpConfig, jobId: number, log?: (line: string) => void): Promise<FinishResult> {
  const taken = await q(
    db,
    `UPDATE jobs SET export_status = 'building', export_error = NULL WHERE id = $1 AND export_status <> 'building' RETURNING id`,
    [jobId],
  );
  if (taken.length === 0) {
    const exists = await q1(db, `SELECT 1 FROM jobs WHERE id = $1`, [jobId]);
    throw new Error(exists ? `job ${jobId}: an export build is already running` : `Unknown job ${jobId}`);
  }
  const open = await q1<{ n: string }>(
    db,
    `SELECT COUNT(*) AS n FROM job_areas WHERE job_id = $1 AND status NOT IN ('done', 'reused', 'failed', 'cancelled')`,
    [jobId],
  );
  if (Number(open?.n ?? 0) === 0) return buildTakenJob(db, base, jobId, log);

  const input = await loadExportInput(db, jobId);
  let exportError: string | null = null;
  try {
    if (input.areas.length === 0) throw new Error('No city finished');
    await saveJobExport(db, jobId, await buildExport(db, base, { ...input, log }));
  } catch (e) {
    exportError = (e as Error).message.slice(0, 500) || 'export failed';
  }
  await q(db, `UPDATE jobs SET export_status = $2, export_error = $3 WHERE id = $1`, [
    jobId,
    exportError === null ? 'ready' : 'failed',
    exportError,
  ]);
  const status = (await q1<{ status: JobStatus }>(db, `SELECT status FROM jobs WHERE id = $1`, [jobId]))?.status ?? 'running';
  return { jobId, status, exportStatus: exportError === null ? 'ready' : 'failed', exportError };
}
