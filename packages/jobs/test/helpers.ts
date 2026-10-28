import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger, DbEvidenceStore, loadConfig, type Db, type PpConfig } from '@pp/core';
import type { PilotEnv } from '@pp/pipeline';
import { DEFAULT_JOB_SETTINGS, type JobSettings, type StateCode } from '../src/contract';

process.env.PP_LOG_LEVEL ??= 'silent';

export function tempDir(prefix = 'pp-jobs-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Tests start from the code default (Comptroller off), like the pipeline tests. */
export function testConfig(): PpConfig {
  const c = loadConfig();
  return { ...c, sources: { ...c.sources, tx_comptroller: { ...c.sources.tx_comptroller, enabled: false } } };
}

/** A pipeline env on the test database with the real clock (claims compare against the database's now()). */
export function makeEnv(db: Db, over: Partial<PilotEnv> = {}): PilotEnv {
  return {
    config: testConfig(),
    db,
    evidence: new DbEvidenceStore(db),
    fetcher: undefined as never,
    log: createLogger('test'),
    now: () => new Date(),
    sleep: async () => {},
    out: () => {},
    ...over,
  };
}

export interface AreaSpec {
  areaId: string;
  state: StateCode;
  label?: string;
}

/** Inserts a job and its cities (positions 0..n-1); returns the job id and the job_areas ids in order. */
export async function createJob(
  db: Db,
  areas: AreaSpec[],
  o: { settings?: Partial<JobSettings>; status?: string; name?: string } = {},
): Promise<{ jobId: number; areaIds: number[] }> {
  const states = [...new Set(areas.map((a) => a.state))];
  const job = await db.$client.query(
    `INSERT INTO jobs (name, status, states, settings) VALUES ($1, $2, $3::text[], $4::jsonb) RETURNING id`,
    [o.name ?? 'test job', o.status ?? 'queued', states, JSON.stringify({ ...DEFAULT_JOB_SETTINGS, ...o.settings })],
  );
  const jobId = job.rows[0].id as number;
  const areaIds: number[] = [];
  for (const [i, a] of areas.entries()) {
    const r = await db.$client.query(
      `INSERT INTO job_areas (job_id, area_id, state, label, position) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [jobId, a.areaId, a.state, a.label ?? a.areaId, i],
    );
    areaIds.push(r.rows[0].id as number);
  }
  return { jobId, areaIds };
}

export async function areaRow(db: Db, id: number): Promise<Record<string, any>> {
  return (await db.$client.query(`SELECT * FROM job_areas WHERE id = $1`, [id])).rows[0];
}

export async function jobRow(db: Db, id: number): Promise<Record<string, any>> {
  return (await db.$client.query(`SELECT * FROM jobs WHERE id = $1`, [id])).rows[0];
}
