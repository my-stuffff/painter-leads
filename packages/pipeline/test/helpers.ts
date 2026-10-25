import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createLogger, DbEvidenceStore, loadConfig, type Db, type PpConfig } from '@pp/core';
import type { PilotEnv } from '../src/env';

process.env.PP_LOG_LEVEL ??= 'silent';

export const FIXED_NOW = new Date('2026-10-25T12:00:00Z');

export function tempDir(prefix = 'pp-pipeline-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Tests start from the code default (Comptroller off); the shipped switch is the owner's ruling. */
function withComptrollerOff(c: PpConfig): PpConfig {
  return { ...c, sources: { ...c.sources, tx_comptroller: { ...c.sources.tx_comptroller, enabled: false } } };
}

export function makeEnv(db: Db, over: Partial<PilotEnv> & { config?: PpConfig } = {}): PilotEnv & { lines: string[] } {
  const lines: string[] = [];
  return {
    config: over.config ?? withComptrollerOff(loadConfig()),
    db,
    evidence: new DbEvidenceStore(db),
    fetcher: undefined as never,
    log: createLogger('test'),
    now: () => FIXED_NOW,
    sleep: async () => {},
    out: (l) => {
      lines.push(l);
    },
    ...over,
    lines,
  };
}

/** Every sheet of a workbook as rows of cell values (hyperlink cells give their text). */
export async function readSheets(file: string): Promise<Record<string, unknown[][]>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const out: Record<string, unknown[][]> = {};
  wb.eachSheet((ws) => {
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as unknown[]).slice(1);
      rows.push(values.map((v) => (v && typeof v === 'object' && 'text' in (v as object) ? (v as { text: string }).text : v)));
    });
    out[ws.name] = rows;
  });
  return out;
}

export async function sheetNames(file: string): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map((w) => w.name);
}
