import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MASTER_COLUMNS, QUALIFIED_COLUMNS } from './columns';
import { sanitizeCell } from './sanitize';
import type { Cell, ReportCompany } from './rows';

export const BOM = '﻿';

/** The cell values of one company in the given column order. */
export function companyMatrix(companies: ReportCompany[], columns: readonly string[]): Cell[][] {
  return companies.map((c) => columns.map((col) => c.cells[col] ?? null));
}

function field(v: Cell): string {
  const text = v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : sanitizeCell(v);
  return `"${text.replace(/"/g, '""')}"`;
}

/** UTF-8 BOM, every field quoted, CRLF line ends, blanks as empty fields (never 'null' or '0'). */
export function csvText(headers: readonly string[], rows: Cell[][]): string {
  const lines = [headers.map((h) => field(h)).join(','), ...rows.map((r) => r.map(field).join(','))];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Written beside the final name first and renamed only when complete. */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function writeCsvFiles(
  dir: string,
  companies: ReportCompany[],
): Promise<{ masterCsvPath: string; qualifiedCsvPath: string }> {
  const masterCsvPath = path.join(dir, 'master.csv');
  const qualifiedCsvPath = path.join(dir, 'qualified.csv');
  await writeFileAtomic(masterCsvPath, csvText(MASTER_COLUMNS, companyMatrix(companies, MASTER_COLUMNS)));
  await writeFileAtomic(
    qualifiedCsvPath,
    csvText(QUALIFIED_COLUMNS, companyMatrix(companies.filter((c) => c.qualified), QUALIFIED_COLUMNS)),
  );
  return { masterCsvPath, qualifiedCsvPath };
}
