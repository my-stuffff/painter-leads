import path from 'node:path';
import type { Db, PpConfig, StateCode } from '@pp/core';
import { loadRun } from '../data';
import { writeFileAtomic, csvText } from '../report/csv';
import { buildReportData, type ReportCompany } from '../report/rows';
import { resolveOutDir, runOutputDir } from '../report/stage';
import { q } from '../sql';
import { mulberry32, shuffle } from './prng';
import { TRUTH_FIELDS } from './truth';

export type Stratum = 'qualified' | 'non_qualified' | 'non_painter';

export interface Candidate {
  companyId: number;
  stratum: Stratum;
}

export interface SampleOptions {
  perState: number;
  minQualified: number;
  maxNonPainters: number;
  seed: number;
}

/**
 * ACC-01 / D-31, pure and deterministic: up to minQualified qualified companies (all of them when fewer exist), at most
 * maxNonPainters non-painters (to check the filter), the rest non-qualified painting companies. If those run out, more
 * qualified ones fill the gap. The drawn companies are shuffled again so the order carries no stratum.
 */
export function chooseSample(population: Candidate[], o: SampleOptions): Candidate[] {
  const rng = mulberry32(o.seed);
  const pool = (s: Stratum): Candidate[] =>
    shuffle(
      population.filter((c) => c.stratum === s).sort((a, b) => a.companyId - b.companyId),
      rng,
    );
  const qualified = pool('qualified');
  const nonQualified = pool('non_qualified');
  const nonPainters = pool('non_painter');

  let room = o.perState;
  const takeQ = Math.min(o.minQualified, qualified.length, room);
  room -= takeQ;
  const takeNP = Math.min(o.maxNonPainters, nonPainters.length, room);
  room -= takeNP;
  const takeNQ = Math.min(nonQualified.length, room);
  room -= takeNQ;
  const extraQ = Math.min(qualified.length - takeQ, room);

  return shuffle(
    [...qualified.slice(0, takeQ + extraQ), ...nonQualified.slice(0, takeNQ), ...nonPainters.slice(0, takeNP)],
    rng,
  );
}

export function stratumOf(c: ReportCompany): Stratum {
  if (c.qualified) return 'qualified';
  return c.painterStatus === 'painter' ? 'non_qualified' : 'non_painter';
}

export function accuracyDir(base: string, runId: number, state: string): string {
  return path.join(runOutputDir(base, runId), 'accuracy', state);
}

export interface DrawnSample {
  sampleId: string;
  companyId: number;
  stratum: Stratum;
  company: string;
  profileUrl: string;
}

export interface SampleResult {
  runId: number;
  state: StateCode;
  seed: number;
  dir: string;
  samples: DrawnSample[];
  files: { sample: string; key: string; truthTemplate: string };
}

/**
 * `pp accuracy sample <run> --seed N`: needs a finished (frozen) run. Writes accuracy_samples and, per state,
 * sample.csv (sample_id, company, google_profile_link ONLY: what the blind checker receives), sample-key.csv and
 * truth-template.csv. The key and the system's outputs never travel with the checker's file (D-31).
 */
export async function drawSample(db: Db, config: PpConfig, runId: number, seed: number, base?: string): Promise<SampleResult> {
  const run = await loadRun(db, runId);
  if (run.status !== 'done') throw new Error(`Run ${runId} is ${run.status}; sample only a finished (frozen) run`);

  const data = await buildReportData(db, config, runId);
  const inArea = data.companies.filter((c) => !c.reasons.includes('outside pilot area'));
  const byId = new Map(inArea.map((c) => [c.companyId, c] as const));
  const chosen = chooseSample(
    inArea.map((c) => ({ companyId: c.companyId, stratum: stratumOf(c) })),
    { ...config.accuracy, seed },
  );

  const state = run.state;
  const samples: DrawnSample[] = chosen.map((c, i) => {
    const company = byId.get(c.companyId) as ReportCompany;
    return {
      sampleId: `${state}-${String(i + 1).padStart(3, '0')}`,
      companyId: c.companyId,
      stratum: c.stratum,
      company: company.name,
      profileUrl: company.profileUrl ?? '',
    };
  });

  await q(db, `DELETE FROM accuracy_samples WHERE run_id = $1`, [runId]);
  for (const s of samples) {
    await q(
      db,
      `INSERT INTO accuracy_samples (run_id, state, sample_id, company_id, stratum, seed) VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, state, s.sampleId, s.companyId, s.stratum, seed],
    );
  }

  const dir = accuracyDir(resolveOutDir(config, base), runId, state);
  const files = {
    sample: path.join(dir, 'sample.csv'),
    key: path.join(dir, 'sample-key.csv'),
    truthTemplate: path.join(dir, 'truth-template.csv'),
  };
  await writeFileAtomic(
    files.sample,
    csvText(['sample_id', 'company', 'google_profile_link'], samples.map((s) => [s.sampleId, s.company, s.profileUrl])),
  );
  await writeFileAtomic(
    files.key,
    csvText(['sample_id', 'company_id', 'stratum', 'seed'], samples.map((s) => [s.sampleId, s.companyId, s.stratum, seed])),
  );
  await writeFileAtomic(
    files.truthTemplate,
    csvText(
      ['sample_id', 'field', 'value', 'source_url', 'checked_at', 'notes'],
      samples.flatMap((s) => TRUTH_FIELDS.map((f) => [s.sampleId, f, '', '', '', ''])),
    ),
  );
  return { runId, state, seed, dir, samples, files };
}
