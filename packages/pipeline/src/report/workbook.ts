import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import {
  BY_CITY_COLUMNS,
  COMPLETENESS_COLUMNS,
  LINK_COLUMNS,
  MASTER_COLUMNS,
  QUALIFIED_COLUMNS,
  SOURCES_COLUMNS,
  SUMMARY_COLUMNS,
  TEXT_COLUMNS,
} from './columns';
import { safeHyperlink, sanitizeCell } from './sanitize';
import type { Cell, ReportCompany, SourceRow } from './rows';

/** Beyond this many hyperlinks a sheet gets plain-text URLs (T-05-05). */
export const MAX_HYPERLINKS_PER_SHEET = 60000;

export interface WorkbookModel {
  companies: ReportCompany[];
  sources: SourceRow[];
  byCity: Cell[][];
  completeness: Cell[][];
  summary: Cell[][];
}

type CellValue = string | number | { text: string; hyperlink: string } | null;

function plain(v: Cell): string | number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'number' ? v : sanitizeCell(v);
}

function companyRow(c: ReportCompany, columns: readonly string[], links: { n: number }): CellValue[] {
  return columns.map((col) => {
    const v = c.cells[col] ?? null;
    if (v === null || v === '') return null;
    if (typeof v === 'number') return v;
    if (LINK_COLUMNS.has(col) && links.n < MAX_HYPERLINKS_PER_SHEET) {
      const href = safeHyperlink(v);
      if (href) {
        links.n += 1;
        return { text: sanitizeCell(v), hyperlink: href };
      }
    }
    return sanitizeCell(v);
  });
}

function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  headers: readonly string[],
  rows: CellValue[][],
  widths?: number[],
): void {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = headers.map((h, i) => ({
    header: h,
    key: `c${i}`,
    width: widths?.[i] ?? Math.min(Math.max(h.length + 4, 12), 40),
    style: TEXT_COLUMNS.has(h) ? { numFmt: '@' } : {},
  }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) ws.addRow(r);
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
}

export function buildWorkbook(model: WorkbookModel): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Painter Promotions lead finder';

  const qualifiedLinks = { n: 0 };
  const masterLinks = { n: 0 };
  addSheet(
    wb,
    'Qualified',
    QUALIFIED_COLUMNS,
    model.companies.filter((c) => c.qualified).map((c) => companyRow(c, QUALIFIED_COLUMNS, qualifiedLinks)),
    [32, 26, 18, 18, 14, 16, 30, 18, 32, 10, 10, 40, 22, 30, 16, 8, 7, 18, 24, 12, 12],
  );
  addSheet(
    wb,
    'Master list',
    MASTER_COLUMNS,
    model.companies.map((c) => companyRow(c, MASTER_COLUMNS, masterLinks)),
    [32, 26, 18, 18, 14, 16, 30, 18, 32, 10, 10, 40, 22, 30, 16, 8, 7, 18, 24, 12, 12, 10, 60],
  );
  addSheet(wb, 'By city', BY_CITY_COLUMNS, model.byCity.map((r) => r.map(plain)), [24, 16, 12, 12, 12]);
  addSheet(wb, 'Contact completeness', COMPLETENESS_COLUMNS, model.completeness.map((r) => r.map(plain)), [16, 14, 10, 18, 14]);
  addSheet(wb, 'Summary', SUMMARY_COLUMNS, model.summary.map((r) => r.map(plain)), [48, 90]);

  const sourceLinks = { n: 0 };
  const sourceRows: CellValue[][] = model.sources.map((s) => {
    let url: CellValue = sanitizeCell(s.sourceUrl);
    if (sourceLinks.n < MAX_HYPERLINKS_PER_SHEET) {
      const href = safeHyperlink(s.sourceUrl);
      if (href) {
        sourceLinks.n += 1;
        url = { text: sanitizeCell(s.sourceUrl), hyperlink: href };
      }
    }
    return [
      sanitizeCell(s.company),
      sanitizeCell(s.field),
      sanitizeCell(s.value),
      url,
      s.capturedAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      s.confidence,
    ];
  });
  addSheet(wb, 'Sources', SOURCES_COLUMNS, sourceRows, [32, 24, 34, 60, 22, 12]);
  return wb;
}

export interface WriteWorkbookOptions {
  /** Replaces the file write (tests use it to interrupt a write). */
  write?: (wb: ExcelJS.Workbook, file: string) => Promise<void>;
}

/** Writes beside the final name and renames only when complete: an interrupted report never leaves a half file. */
export async function writeWorkbook(file: string, model: WorkbookModel, o: WriteWorkbookOptions = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const wb = buildWorkbook(model);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await (o.write ?? ((w, f) => w.xlsx.writeFile(f).then(() => undefined)))(wb, tmp);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
