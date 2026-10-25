import path from 'node:path';
import type { Db, PpConfig } from '@pp/core';
import { loadRun } from '../data';
import { csvText, writeFileAtomic } from '../report/csv';
import { resolveOutDir } from '../report/stage';
import { compareTruth, loadSystemSamples, type ResultRow } from './compare';
import { accuracyDir } from './sample';
import { parseAdjudicationCsv, parseTruthCsv } from './truth';

export const ADJUDICATION_COLUMNS = [
  'sample_id',
  'field',
  'system_value',
  'confidence',
  'source_url',
  'snippet',
  'verdict',
  'note',
] as const;

/**
 * The unverifiable rows: the system filled a value the blind checker could not find. This is the one place where
 * the checker is NOT blind: they see the system's value with its source URL and snippet and rule `correct` or
 * `wrong` in the verdict column. That file then feeds `accuracy compare --adjudication`.
 */
export function adjudicationRows(rows: ResultRow[]): (string | number)[][] {
  return rows
    .filter((r) => r.cls === 'unverifiable')
    .map((r) => [r.sampleId, r.field, r.systemValue, r.confidence, r.sourceUrl, r.snippet, '', '']);
}

export async function buildAdjudicationSheet(
  db: Db,
  config: PpConfig,
  runId: number,
  o: { truthText: string; adjudicationText?: string; base?: string },
): Promise<{ file: string; rows: number }> {
  const run = await loadRun(db, runId);
  const out = compareTruth({
    samples: await loadSystemSamples(db, config, runId),
    truth: parseTruthCsv(o.truthText),
    adjudication: o.adjudicationText ? parseAdjudicationCsv(o.adjudicationText) : [],
    drift: config.accuracy.drift,
    runFrozenAt: run.finishedAt ?? run.createdAt,
    truthWithinHours: config.accuracy.truthWithinHours,
  });
  const rows = adjudicationRows(out.rows);
  const file = path.join(accuracyDir(resolveOutDir(config, o.base), runId, run.state), 'adjudication-sheet.csv');
  await writeFileAtomic(file, csvText(ADJUDICATION_COLUMNS, rows));
  return { file, rows: rows.length };
}
