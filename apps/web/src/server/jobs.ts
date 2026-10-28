import type pg from 'pg';
import { z } from 'zod';
import type {
  AreaProgress,
  CreateJobBody,
  ExportStatus,
  JobArea,
  JobAreaStatus,
  JobDetail,
  JobSettings,
  JobStatus,
  JobSummary,
  LeadCounts,
  StateCode,
} from '../shared/api';
import type { CatalogFileCity } from './catalog';
import { iso, q, q1, tx } from './sql';

/** Rough minutes one worker needs per ZIP of a city that has to be scraped (5 terms, observed on Railway). */
export const MINUTES_PER_ZIP = 1.5;

const TERMINAL: ReadonlySet<JobAreaStatus> = new Set(['done', 'reused', 'failed', 'cancelled']);

export const SettingsSchema = z
  .object({
    minRating: z.number().min(1).max(5),
    minReviews: z.number().int().min(0).max(100_000),
    maxReviews: z.number().int().min(0).max(100_000),
    reuseDays: z.number().int().min(0).max(3650),
    terms: z.array(z.string().trim().min(2).max(60)).min(1).max(12),
  })
  .refine((s) => s.minReviews <= s.maxReviews, { message: 'The review range is upside down' });

export const CreateJobSchema = z.object({
  name: z.string().trim().max(120).optional(),
  areaIds: z.array(z.string().min(1)).min(1).max(500),
  settings: SettingsSchema,
});

interface JobDb {
  id: number;
  name: string;
  status: JobStatus;
  states: StateCode[];
  settings: JobSettings;
  error: string | null;
  export_status: ExportStatus;
  export_error: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  created_by_name: string | null;
  export_built_at: Date | null;
  export_counts: LeadCounts | null;
}

interface AreaDb {
  id: number;
  job_id: number;
  area_id: string;
  label: string;
  state: StateCode;
  status: JobAreaStatus;
  run_id: number | null;
  attempts: number;
  message: string | null;
  not_before: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  run_status: string | null;
}

const JOB_SELECT = `
  SELECT j.*, u.name AS created_by_name, e.built_at AS export_built_at, e.summary->'counts' AS export_counts
    FROM jobs j LEFT JOIN users u ON u.id = j.created_by LEFT JOIN job_exports e ON e.job_id = j.id`;

const RUN_LISTINGS = `
  SELECT h.listing_id AS id FROM search_hits h JOIN searches s ON s.id = h.search_id WHERE s.run_id = $1
  UNION SELECT id FROM listings WHERE first_seen_run_id = $1 OR last_seen_run_id = $1`;

/** Counts for one run: searches, place pages, companies, painters, qualified, and the step it is in. */
export async function runProgress(pool: pg.Pool, runId: number, runStatus: string | null): Promise<AreaProgress> {
  const r = await q1<Record<string, string>>(
    pool,
    `WITH l AS (SELECT id, detail_status, company_id FROM listings WHERE id IN (${RUN_LISTINGS})),
          c AS (SELECT * FROM companies WHERE id IN (SELECT DISTINCT company_id FROM l WHERE company_id IS NOT NULL))
     SELECT
       (SELECT count(*) FROM searches WHERE run_id = $1)::text AS s_total,
       (SELECT count(*) FROM searches WHERE run_id = $1 AND status IN ('done', 'failed'))::text AS s_done,
       (SELECT count(*) FROM l)::text AS p_total,
       (SELECT count(*) FROM l WHERE detail_status <> 'pending')::text AS p_done,
       (SELECT count(*) FROM c)::text AS companies,
       (SELECT count(*) FROM c WHERE painter_status = 'painter' AND in_area IS TRUE)::text AS painters,
       (SELECT count(*) FROM c WHERE qualified IS TRUE)::text AS qualified,
       (SELECT count(*) FROM c WHERE painter_status = 'painter' AND in_area IS TRUE AND site_status IS NULL)::text AS unchecked`,
    [runId],
  );
  const n = (k: string) => Number(r?.[k] ?? 0);
  let stage: AreaProgress['stage'];
  if (runStatus === 'done') stage = 'done';
  else if (n('s_total') === 0 || n('s_done') < n('s_total')) stage = 'searching';
  else if (n('companies') === 0) stage = 'reading listings';
  else if (n('unchecked') > 0) stage = 'checking websites';
  else stage = 'finishing';
  return {
    searchesDone: n('s_done'),
    searchesTotal: n('s_total'),
    placesDone: n('p_done'),
    placesTotal: n('p_total'),
    companies: n('companies'),
    painters: n('painters'),
    qualified: n('qualified'),
    stage,
  };
}

/** Finished runs never change: their progress is computed once per server process. */
const finishedProgress = new Map<number, AreaProgress>();

async function areaProgress(pool: pg.Pool, a: AreaDb): Promise<AreaProgress | null> {
  if (a.run_id === null) return null;
  const finished = a.run_status === 'done';
  const cached = finished ? finishedProgress.get(a.run_id) : undefined;
  if (cached) return cached;
  const p = await runProgress(pool, a.run_id, a.run_status);
  if (finished) finishedProgress.set(a.run_id, p);
  return p;
}

/** 0..1 for one city: searches 45 %, place pages 35 %, websites and the rest 20 %. */
export function areaFraction(status: JobAreaStatus, p: AreaProgress | null): number {
  if (TERMINAL.has(status)) return 1;
  if (!p) return 0;
  const ratio = (a: number, b: number) => (b > 0 ? Math.min(1, a / b) : 0);
  const rest = p.stage === 'finishing' ? 0.9 : p.stage === 'checking websites' ? 0.4 : 0;
  return 0.45 * ratio(p.searchesDone, p.searchesTotal) + 0.35 * ratio(p.placesDone, p.placesTotal) + 0.2 * rest;
}

function toArea(a: AreaDb, progress: AreaProgress | null): JobArea {
  return {
    id: a.id,
    areaId: a.area_id,
    label: a.label,
    state: a.state,
    status: a.status,
    runId: a.run_id,
    attempts: a.attempts,
    message: a.message,
    notBefore: iso(a.not_before),
    startedAt: iso(a.started_at),
    finishedAt: iso(a.finished_at),
    progress,
  };
}

function toSummary(j: JobDb, areas: JobArea[]): JobSummary {
  const fractions = areas.map((a) => areaFraction(a.status, a.progress));
  return {
    id: j.id,
    name: j.name,
    status: j.status,
    states: j.states,
    createdAt: iso(j.created_at) ?? '',
    startedAt: iso(j.started_at),
    finishedAt: iso(j.finished_at),
    createdBy: j.created_by_name,
    cityCount: areas.length,
    citiesDone: areas.filter((a) => a.status === 'done' || a.status === 'reused').length,
    progress: areas.length ? fractions.reduce((s, f) => s + f, 0) / areas.length : 0,
    exportStatus: j.export_status,
    counts: j.export_counts,
  };
}

async function areasOf(pool: pg.Pool, jobIds: number[]): Promise<Map<number, JobArea[]>> {
  const rows = await q<AreaDb>(
    pool,
    `SELECT ja.*, r.status AS run_status FROM job_areas ja LEFT JOIN runs r ON r.id = ja.run_id
      WHERE ja.job_id = ANY($1::int[]) ORDER BY ja.job_id, ja.position`,
    [jobIds],
  );
  const out = new Map<number, JobArea[]>();
  for (const a of rows) {
    const live = a.status === 'running' || a.status === 'waiting' || a.status === 'done' || a.status === 'reused';
    const area = toArea(a, live ? await areaProgress(pool, a) : null);
    out.set(a.job_id, [...(out.get(a.job_id) ?? []), area]);
  }
  return out;
}

export async function listJobs(pool: pg.Pool, limit = 200): Promise<JobSummary[]> {
  const jobs = await q<JobDb>(pool, `${JOB_SELECT} ORDER BY j.id DESC LIMIT $1`, [limit]);
  const areas = await areasOf(
    pool,
    jobs.map((j) => j.id),
  );
  return jobs.map((j) => toSummary(j, areas.get(j.id) ?? []));
}

export async function getJob(pool: pg.Pool, id: number, cities: CatalogFileCity[], workersOnline: number): Promise<JobDetail | null> {
  const j = await q1<JobDb>(pool, `${JOB_SELECT} WHERE j.id = $1`, [id]);
  if (!j) return null;
  const areas = (await areasOf(pool, [id])).get(id) ?? [];
  const zips = new Map(cities.map((c) => [c.areaId, c.zipCount]));
  const open = areas.filter((a) => !TERMINAL.has(a.status));
  const minutes = open.reduce((s, a) => s + (zips.get(a.areaId) ?? 10) * MINUTES_PER_ZIP * (1 - areaFraction(a.status, a.progress)), 0);
  const lanes = Math.max(1, Math.min(workersOnline || 1, new Set(open.map((a) => a.state)).size));
  return {
    ...toSummary(j, areas),
    settings: j.settings,
    error: j.error,
    exportError: j.export_error,
    exportBuiltAt: iso(j.export_built_at),
    areas,
    etaMinutes: open.length ? Math.round(minutes / lanes) : null,
  };
}

/** Queues a job: one job_areas row per city in the order given. Unknown cities are refused. */
export async function createJob(
  pool: pg.Pool,
  body: CreateJobBody,
  userId: number,
  cities: CatalogFileCity[],
): Promise<number> {
  const byId = new Map(cities.map((c) => [c.areaId, c]));
  const picked = [...new Set(body.areaIds)].map((id) => {
    const c = byId.get(id);
    if (!c) throw new UserError(`Unknown city: ${id}`);
    return c;
  });
  const states = [...new Set(picked.map((c) => c.state))];
  const name =
    body.name?.trim() ||
    `${states.join(', ')} · ${picked.length === 1 ? picked[0]?.name : `${picked.length} cities`}`;
  return tx(pool, async (c) => {
    const job = await q1<{ id: number }>(
      c,
      `INSERT INTO jobs (name, created_by, states, settings) VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, userId, states, JSON.stringify(body.settings)],
    );
    if (!job) throw new Error('could not create the job');
    let position = 0;
    for (const city of picked) {
      await q(c, `INSERT INTO job_areas (job_id, area_id, state, label, position) VALUES ($1, $2, $3, $4, $5)`, [
        job.id,
        city.areaId,
        city.state,
        `${city.name}, ${city.state}`,
        position++,
      ]);
    }
    return job.id;
  });
}

/** Queued and waiting cities stop at once; a running city finishes first (the worker checks the job between cities). */
export async function cancelJob(pool: pg.Pool, id: number): Promise<void> {
  await tx(pool, async (c) => {
    await q(
      c,
      `UPDATE job_areas SET status = 'cancelled', finished_at = now(), message = 'Cancelled'
        WHERE job_id = $1 AND status IN ('queued', 'waiting')`,
      [id],
    );
    await q(c, `UPDATE jobs SET status = 'cancelled' WHERE id = $1 AND status IN ('queued', 'running')`, [id]);
    // Export what finished so far once nothing is running (the worker builds exports for status 'none').
  });
}

/** Failed and cancelled cities go back in the queue; the job runs again. */
export async function retryJob(pool: pg.Pool, id: number): Promise<number> {
  return tx(pool, async (c) => {
    const rows = await q(
      c,
      `UPDATE job_areas SET status = 'queued', attempts = 0, not_before = NULL, message = NULL, finished_at = NULL
        WHERE job_id = $1 AND status IN ('failed', 'cancelled') RETURNING id`,
      [id],
    );
    if (rows.length > 0) {
      await q(c, `UPDATE jobs SET status = 'running', finished_at = NULL, error = NULL, export_status = 'none' WHERE id = $1`, [id]);
    }
    return rows.length;
  });
}

export async function rebuildExport(pool: pg.Pool, id: number): Promise<void> {
  await q(pool, `UPDATE jobs SET export_status = 'none', export_error = NULL WHERE id = $1`, [id]);
}

/** An error whose message is meant for the person using the app (400). */
export class UserError extends Error {}
