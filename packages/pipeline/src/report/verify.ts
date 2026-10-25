import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import type { Db, PpConfig } from '@pp/core';
import { loadRun } from '../data';
import { q } from '../sql';
import { MASTER_COLUMNS, QUALIFIED_COLUMNS, TAB_HEADERS, TAB_NAMES } from './columns';
import { SAB_ADDRESS_TEXT } from './rows';
import { hasUnguardedFormulaPrefix, unguardCell } from './sanitize';
import { resolveOutDir, runOutputDir } from './stage';

/** Master columns whose non-blank value must be backed by a Sources row (company, field, value). */
const EVIDENCE_COLUMNS = [
  'Company',
  'Owner / decision-maker',
  'Phone',
  'Email',
  'Website',
  'Google rating',
  'Google reviews',
  'Google profile link',
  'Category',
  'Address',
  'City',
  'ZIP',
  'State',
  'Licence/registration no.',
  'Residential status',
] as const;

const NUMERIC_COLUMNS = new Set(['Google rating', 'Google reviews']);

type Raw = ExcelJS.CellValue;

function text(v: Raw): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('text' in o && typeof o.text === 'string') return o.text;
    if ('richText' in o && Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if ('result' in o) return text(o.result as Raw);
  }
  return String(v);
}

function samePlain(column: string, a: string, b: string): boolean {
  if (NUMERIC_COLUMNS.has(column)) return Number(a) === Number(b);
  return a === b;
}

/**
 * `pp report verify`: reopens the written workbook and CSVs and checks the report invariants. Returns every
 * violation (empty = the report is sound): tab order and exact headers, ZIP as text, no formula prefixes,
 * a Sources row behind every shown value, no 0 for a rating / review count that was not captured, reasons on
 * every excluded row, and CSV headers equal to the tab headers.
 */
export async function verifyReport(db: Db, config: PpConfig, runId: number, base?: string): Promise<string[]> {
  const violations: string[] = [];
  const run = await loadRun(db, runId);
  const dir = runOutputDir(resolveOutDir(config, base), runId);
  const xlsx = path.join(dir, `${run.areaId}.xlsx`);
  if (!existsSync(xlsx)) return [`workbook not found: ${xlsx}`];

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsx);

  const names = wb.worksheets.map((w) => w.name);
  if (names.join('|') !== TAB_NAMES.join('|')) {
    violations.push(`tabs are [${names.join(', ')}], expected [${TAB_NAMES.join(', ')}]`);
  }

  const sheets = new Map<string, string[][]>();
  const rawCells = new Map<string, Raw[][]>();
  for (const name of TAB_NAMES) {
    const ws = wb.getWorksheet(name);
    if (!ws) continue;
    const rows: string[][] = [];
    const raws: Raw[][] = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const width = TAB_HEADERS[name].length;
      const values: Raw[] = [];
      for (let c = 1; c <= width; c++) {
        const cell = row.getCell(c);
        values.push(cell.value);
        if (rowNumber > 1) {
          if (cell.type === ExcelJS.ValueType.Formula) violations.push(`${name}!${cell.address} is a formula`);
          else {
            const t = text(cell.value);
            if (typeof cell.value === 'string' && hasUnguardedFormulaPrefix(t)) {
              violations.push(`${name}!${cell.address} starts like a formula without the guard: ${t.slice(0, 40)}`);
            }
          }
        }
      }
      rows.push(values.map(text));
      raws.push(values);
    });
    sheets.set(name, rows);
    rawCells.set(name, raws);
    const header = rows[0] ?? [];
    const expected = TAB_HEADERS[name];
    if (header.join('\u0000') !== expected.join('\u0000')) {
      violations.push(`tab "${name}": header row is [${header.join(' | ')}], expected [${expected.join(' | ')}]`);
    }
  }

  const master = sheets.get('Master list') ?? [];
  const masterRaw = rawCells.get('Master list') ?? [];
  const qualifiedRows = sheets.get('Qualified') ?? [];
  const sources = (sheets.get('Sources') ?? []).slice(1);
  const masterHeader = MASTER_COLUMNS as readonly string[];
  const col = (name: string): number => masterHeader.indexOf(name);

  // Sources round trip: company + field + value
  const sourcesFor = new Map<string, string[]>();
  for (const r of sources) {
    const k = `${r[0]}\u0000${r[1]}`;
    const list = sourcesFor.get(k);
    if (list) list.push(unguardCell(r[2] ?? ''));
    else sourcesFor.set(k, [unguardCell(r[2] ?? '')]);
  }

  for (let i = 1; i < master.length; i++) {
    const row = master[i] as string[];
    const company = row[col('Company')] ?? '';
    const where = `Master list row ${i + 1} (${company})`;

    for (const column of EVIDENCE_COLUMNS) {
      const value = unguardCell(row[col(column)] ?? '');
      if (value === '') continue;
      if (column === 'Address' && value === SAB_ADDRESS_TEXT) continue;
      if (column === 'Residential status' && value === 'Unclear') continue;
      const backing = sourcesFor.get(`${company}\u0000${column}`) ?? [];
      if (!backing.some((b) => samePlain(column, b, value))) {
        violations.push(`${where}: "${column}" = "${value}" has no Sources row`);
      }
    }

    const zip = masterRaw[i]?.[col('ZIP')];
    if (zip !== null && zip !== undefined && zip !== '' && !(typeof zip === 'string' && /^\d{5}$/.test(zip))) {
      violations.push(`${where}: ZIP is not a 5-character text cell (${String(zip)})`);
    }

    const qualified = row[col('Qualified')];
    const reasons = row[col('Exclusion reasons')] ?? '';
    if (qualified === 'no' && reasons.trim() === '') violations.push(`${where}: not qualified but has no exclusion reasons`);
    if (qualified === 'yes' && reasons.trim() !== '') violations.push(`${where}: qualified but lists exclusion reasons`);
    if (qualified !== 'yes' && qualified !== 'no') violations.push(`${where}: Qualified must be yes or no, found "${qualified}"`);

    // a captured zero is real; a zero standing in for "not captured" is not
    const rating = masterRaw[i]?.[col('Google rating')];
    const reviews = masterRaw[i]?.[col('Google reviews')];
    const link = row[col('Google profile link')] ?? '';
    if ((rating === 0 || reviews === 0) && link !== '') {
      const [listing] = await q<{ rating_status: string; review_count_status: string }>(
        db,
        `SELECT rating_status, review_count_status FROM listings WHERE profile_url = $1 LIMIT 1`,
        [link],
      );
      if (rating === 0 && listing && listing.rating_status !== 'captured') {
        violations.push(`${where}: rating is 0 but the listing's rating was ${listing.rating_status}`);
      }
      if (reviews === 0 && listing && listing.review_count_status !== 'captured') {
        violations.push(`${where}: review count is 0 but the listing's review count was ${listing.review_count_status}`);
      }
    }
  }

  const yes = master.slice(1).filter((r) => r[col('Qualified')] === 'yes').length;
  if (qualifiedRows.length - 1 !== yes) {
    violations.push(`Qualified tab has ${qualifiedRows.length - 1} rows but the Master list marks ${yes} as qualified`);
  }

  // CSVs: same headers, same rows in the same order as the tabs
  const csvChecks: [string, readonly string[], string[][]][] = [
    ['master.csv', MASTER_COLUMNS, master],
    ['qualified.csv', QUALIFIED_COLUMNS, qualifiedRows],
  ];
  for (const [file, headers, tab] of csvChecks) {
    const p = path.join(dir, file);
    if (!existsSync(p)) {
      violations.push(`${file} not found in ${dir}`);
      continue;
    }
    const records = parse(readFileSync(p, 'utf8'), { bom: true, relax_column_count: true }) as string[][];
    const header = records[0] ?? [];
    if (header.join('\u0000') !== headers.join('\u0000')) {
      violations.push(`${file}: header [${header.join(' | ')}] differs from the tab header [${headers.join(' | ')}]`);
    }
    if (records.length !== tab.length) violations.push(`${file}: ${records.length - 1} rows but the tab has ${tab.length - 1}`);
    else {
      for (let r = 1; r < records.length; r++) {
        if ((records[r]?.[0] ?? '') !== (tab[r]?.[0] ?? '')) {
          violations.push(`${file}: row ${r + 1} is "${records[r]?.[0]}" but the tab has "${tab[r]?.[0]}" (order differs)`);
          break;
        }
      }
    }
  }

  return violations;
}
