import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db, PpConfig } from '@pp/core';
import { accuracyDir } from './accuracy/sample';
import { recall, type SummaryDoc } from './accuracy/compare';
import { loadRun } from './data';
import { writeFileAtomic } from './report/csv';
import { buildReportData, type ReportCompany } from './report/rows';
import { resolveOutDir, runOutputDir } from './report/stage';

export const FILL_FIELDS: [string, string][] = [
  ['owner', 'Owner / decision-maker'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['website', 'Website'],
];

export interface FillCount {
  count: number;
  of: number;
  pct: number;
}

export interface FillRates {
  runId: number;
  state: string;
  area: string;
  /** Painting companies in the area (denominator of the first block) and the qualified ones. */
  paintingCompanies: number;
  qualified: number;
  fields: Record<string, { painting: FillCount; qualified: FillCount; missedFindableShare: number | null }>;
}

const share = (count: number, of: number): FillCount => ({ count, of, pct: of === 0 ? 0 : Math.round((count / of) * 1000) / 10 });
const has = (c: ReportCompany, col: string): boolean => {
  const v = c.cells[col];
  return v !== null && v !== undefined && String(v).trim() !== '';
};

/**
 * ACC-03: how often owner / email / phone / website are filled, over the painting companies of the area and over the
 * qualified ones, per state. When a compare result exists the share of findable values that were missed is added.
 */
export async function computeFillRates(db: Db, config: PpConfig, runId: number, base?: string): Promise<FillRates> {
  const run = await loadRun(db, runId);
  const data = await buildReportData(db, config, runId);
  const painting = data.companies.filter((c) => c.painterStatus === 'painter' && !c.reasons.includes('outside pilot area'));
  const qualified = data.companies.filter((c) => c.qualified);

  let summary: SummaryDoc | null = null;
  const summaryFile = path.join(accuracyDir(resolveOutDir(config, base), runId, run.state), 'summary.json');
  if (existsSync(summaryFile)) summary = JSON.parse(readFileSync(summaryFile, 'utf8')) as SummaryDoc;

  const fields: FillRates['fields'] = {};
  for (const [label, col] of FILL_FIELDS) {
    let missedShare: number | null = null;
    if (summary) {
      const key = label === 'owner' ? 'owner_name' : label;
      const r = recall(summary, key);
      missedShare = r.n === 0 ? null : Math.round((1 - (r.point as number)) * 1000) / 10;
    }
    fields[label] = {
      painting: share(painting.filter((c) => has(c, col)).length, painting.length),
      qualified: share(qualified.filter((c) => has(c, col)).length, qualified.length),
      missedFindableShare: missedShare,
    };
  }
  return { runId, state: run.state, area: run.areaId, paintingCompanies: painting.length, qualified: qualified.length, fields };
}

export function fillRateLines(r: FillRates): string[] {
  const lines = [`run ${r.runId} ${r.area} (${r.state}): ${r.paintingCompanies} painting companies, ${r.qualified} qualified`];
  for (const [name, f] of Object.entries(r.fields)) {
    const missed = f.missedFindableShare === null ? '' : `, findable values missed ${f.missedFindableShare}%`;
    lines.push(
      `  ${name.padEnd(8)} painting ${f.painting.count}/${f.painting.of} (${f.painting.pct}%)  qualified ${f.qualified.count}/${f.qualified.of} (${f.qualified.pct}%)${missed}`,
    );
  }
  return lines;
}

export async function writeFillRates(config: PpConfig, r: FillRates, base?: string): Promise<string> {
  const file = path.join(runOutputDir(resolveOutDir(config, base), r.runId), 'fillrates.json');
  await writeFileAtomic(file, `${JSON.stringify(r, null, 2)}\n`);
  return file;
}
