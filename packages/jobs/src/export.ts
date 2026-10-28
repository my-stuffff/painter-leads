import ExcelJS from 'exceljs';
import type { Db, PpConfig } from '@pp/core';
import {
  buildReportData,
  csvText,
  LINK_COLUMNS,
  QUALIFIED_COLUMNS,
  safeHyperlink,
  sanitizeCell,
  TEXT_COLUMNS,
  type Cell,
} from '@pp/pipeline';
import {
  LEAD_LIST_LABEL,
  type ExportSummary,
  type JobSettings,
  type LeadCounts,
  type LeadList,
  type LeadRow,
  type StateCode,
} from './contract';
import { compareRows, dedupe, dedupeKey, pickList } from './lists';
import { judgeAgainstRunArea } from './run-area';
import { exportConfig } from './settings';

/** A city whose run feeds the export (status done or reused). */
export interface ExportArea {
  areaId: string;
  /** "Los Angeles, CA": the Search city column. */
  label: string;
  state: StateCode;
  runId: number;
}

export interface ExportInput {
  name: string;
  settings: JobSettings;
  /** Cities that feed the export, in the job's position order (the first city wins a company found twice). */
  areas: ExportArea[];
  /** Cities that did not finish (failed / cancelled): named on the Summary tab. */
  leftOut?: { label: string; status: string }[];
  builtAt?: Date;
  /** One line per city read (the CLI prints them). */
  log?: (line: string) => void;
}

export interface BuiltExport {
  xlsx: Buffer;
  csv: Buffer;
  rows: LeadRow[];
  summary: ExportSummary;
}

/** One lead with the cells of its report row (QUALIFIED_COLUMNS headers). */
interface Lead {
  row: LeadRow;
  cells: Record<string, Cell>;
}

const LIST_ORDER: LeadList[] = ['painting', 'check', 'likely'];
const WHY_NOT = 'Why not in main list';
const SEARCH_CITY = 'Search city';
const LIST = 'List';

/** Workbook column widths: Search city, then the 28 Oct widths of QUALIFIED_COLUMNS. */
const QUALIFIED_WIDTHS = [32, 26, 18, 18, 14, 16, 30, 18, 32, 10, 10, 40, 22, 30, 16, 8, 7, 18, 24, 12, 12];
const MAX_HYPERLINKS_PER_SHEET = 60000;

const text = (v: Cell | undefined): string | null =>
  v === null || v === undefined || v === '' ? null : typeof v === 'number' ? String(v) : v;
const numberOrNull = (v: Cell | undefined): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** "Residential only, Google rating ≥ 4.7, reviews 10–99. Blank = not found; nothing guessed." */
export function ruleLine(s: JobSettings): string {
  return `Residential only, Google rating ≥ ${s.minRating}, reviews ${s.minReviews}–${s.maxReviews}. Blank = not found; nothing guessed.`;
}

function toLeadRow(
  area: ExportArea,
  companyId: number,
  list: LeadList,
  whyNot: string | null,
  cells: Record<string, Cell>,
): LeadRow {
  return {
    companyId,
    runId: area.runId,
    list,
    whyNot,
    areaId: area.areaId,
    searchCity: area.label,
    company: text(cells['Company']) ?? '',
    owner: text(cells['Owner / decision-maker']),
    ownerTitle: text(cells['Owner title']),
    ownerSource: text(cells['Owner source']),
    ownerConfidence: text(cells['Owner confidence']),
    phone: text(cells['Phone']),
    email: text(cells['Email']),
    emailSource: text(cells['Email source']),
    website: text(cells['Website']),
    rating: numberOrNull(cells['Google rating']),
    reviews: numberOrNull(cells['Google reviews']),
    googleUrl: text(cells['Google profile link']),
    category: text(cells['Category']),
    address: text(cells['Address']),
    city: text(cells['City']),
    zip: text(cells['ZIP']),
    // The searched city's state: always one of the job's states (a company's address may name another state; the
    // State column of the files shows the address state).
    state: area.state,
    licence: text(cells['Licence/registration no.']),
    residentialStatus: text(cells['Residential status']),
    firstSeen: text(cells['First seen']),
    lastChecked: text(cells['Last checked']),
  };
}

/**
 * Every lead of the job's cities, split into the three lists, deduplicated by Google profile link (first city in
 * position order wins), each list sorted by State, Search city, Company.
 *
 * Each city's rows come from the per-run report (buildReportData: the run's own master list, every value exactly as
 * the 28 Oct workbook shows it). Qualification is the pure qualify(computeFacts(...)) inside buildReportData, judged
 * with the job's thresholds: buildReportData reads the config only for the confidence floor (report.minConfidence)
 * and for qualification, and exportConfig changes nothing but the thresholds, so this is the base report re-judged
 * with the job's thresholds. In-area is judged against each run's own area (judgeAgainstRunArea), as the run's own
 * report did when it finished. Nothing is written back to companies.
 */
async function collectLeads(db: Db, base: PpConfig, input: ExportInput): Promise<Lead[]> {
  const cfg = exportConfig(base, input.settings);
  const found: { lead: Lead; key: string }[] = [];
  for (const area of input.areas) {
    const data = await buildReportData(db, cfg, area.runId);
    const companies = await judgeAgainstRunArea(db, cfg, area.runId, data.run.areaId, data.companies);
    let kept = 0;
    for (const c of companies) {
      const pick = pickList({ qualified: c.qualified, reasons: c.reasons, name: c.name, category: text(c.cells['Category']) });
      if (!pick) continue;
      kept++;
      found.push({
        lead: { row: toLeadRow(area, c.companyId, pick.list, pick.whyNot, c.cells), cells: c.cells },
        key: dedupeKey(c.profileUrl, c.companyId),
      });
    }
    input.log?.(`${area.label} (run ${area.runId}): ${companies.length} companies, ${kept} in a list`);
  }
  const unique = dedupe(found, (f) => f.key).map((f) => f.lead);
  const sortKey = (l: Lead) => ({
    state: text(l.cells['State']) ?? l.row.state,
    searchCity: l.row.searchCity,
    company: l.row.company,
    companyId: l.row.companyId,
  });
  const out: Lead[] = [];
  for (const list of LIST_ORDER) {
    out.push(...unique.filter((l) => l.row.list === list).sort((a, b) => compareRows(sortKey(a), sortKey(b))));
  }
  return out;
}

const emptyCounts = (): LeadCounts => ({ painting: 0, check: 0, likely: 0 });

export function summarise(leads: readonly LeadRow[], citiesIncluded: number, builtAt: Date, states: readonly string[]): ExportSummary {
  const counts = emptyCounts();
  const byState: Record<string, LeadCounts> = {};
  for (const s of states) byState[s] = emptyCounts();
  const fill = { owner: 0, phone: 0, email: 0, website: 0 };
  for (const r of leads) {
    counts[r.list]++;
    (byState[r.state] ??= emptyCounts())[r.list]++;
    if (r.list !== 'painting') continue;
    if (r.owner) fill.owner++;
    if (r.phone) fill.phone++;
    if (r.email) fill.email++;
    if (r.website) fill.website++;
  }
  return { builtAt: builtAt.toISOString(), counts, byState, fill, citiesIncluded };
}

type CellValue = string | number | { text: string; hyperlink: string } | null;

function cellValue(col: string, v: Cell | undefined, links: { n: number }): CellValue {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  if (LINK_COLUMNS.has(col) && links.n < MAX_HYPERLINKS_PER_SHEET) {
    const href = safeHyperlink(v);
    if (href) {
      links.n += 1;
      return { text: sanitizeCell(v), hyperlink: href };
    }
  }
  return sanitizeCell(v);
}

function addListSheet(wb: ExcelJS.Workbook, list: LeadList, leads: Lead[]): void {
  const withWhy = list === 'likely';
  const headers = [...(withWhy ? [WHY_NOT] : []), SEARCH_CITY, ...QUALIFIED_COLUMNS];
  const widths = [...(withWhy ? [36] : []), 22, ...QUALIFIED_WIDTHS];
  const ws = wb.addWorksheet(LEAD_LIST_LABEL[list], { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = headers.map((h, i) => ({
    header: h,
    key: `c${i}`,
    width: widths[i] ?? 16,
    style: TEXT_COLUMNS.has(h) ? { numFmt: '@' } : {},
  }));
  ws.getRow(1).font = { bold: true };
  const links = { n: 0 };
  for (const l of leads) {
    ws.addRow([
      ...(withWhy ? [l.row.whyNot === null ? null : sanitizeCell(l.row.whyNot)] : []),
      sanitizeCell(l.row.searchCity),
      ...QUALIFIED_COLUMNS.map((col) => cellValue(col, l.cells[col], links)),
    ]);
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
}

function addSummarySheet(wb: ExcelJS.Workbook, input: ExportInput, summary: ExportSummary, states: string[]): void {
  const ws = wb.addWorksheet('Summary');
  ws.columns = [{ width: 44 }, { width: 22 }, { width: 14 }, { width: 14 }];
  const bold = (rowNumber: number) => {
    ws.getRow(rowNumber).font = { bold: true };
  };
  const add = (...cells: (string | number | null)[]) => ws.addRow(cells.map((c) => (typeof c === 'string' ? sanitizeCell(c) : c)));

  add(input.name);
  bold(1);
  add(ruleLine(input.settings));
  add();
  add('States', states.join(', '));
  add('Cities included', summary.citiesIncluded);
  add('Cities', input.areas.map((a) => a.label).join('; '));
  for (const o of input.leftOut ?? []) add('Not included', `${o.label} (${o.status})`);
  add('Search terms', input.settings.terms.join('; '));
  add('Built', summary.builtAt.replace(/\.\d{3}Z$/, 'Z'));
  add();
  bold(add('Tab', 'Leads').number);
  for (const list of LIST_ORDER) add(LEAD_LIST_LABEL[list], summary.counts[list]);
  add();
  bold(add('By state', LEAD_LIST_LABEL.painting, LEAD_LIST_LABEL.check, LEAD_LIST_LABEL.likely).number);
  for (const s of Object.keys(summary.byState)) {
    const c = summary.byState[s] as LeadCounts;
    add(s, c.painting, c.check, c.likely);
  }
  add();
  bold(add(`Filled in (${LEAD_LIST_LABEL.painting} tab)`).number);
  const n = summary.counts.painting;
  add('Owner / decision-maker', `${summary.fill.owner} of ${n}`);
  add('Phone', `${summary.fill.phone} of ${n}`);
  add('Email', `${summary.fill.email} of ${n}`);
  add('Website', `${summary.fill.website} of ${n}`);
}

/** The XLSX (Summary + the three list tabs), the CSV (all lists, List column first), the rows JSON and the summary. */
export async function buildExport(db: Db, base: PpConfig, input: ExportInput): Promise<BuiltExport> {
  const builtAt = input.builtAt ?? new Date();
  const leads = await collectLeads(db, base, input);
  const rows = leads.map((l) => l.row);
  const states = [...new Set(input.areas.map((a) => a.state))];
  const summary = summarise(rows, input.areas.length, builtAt, states);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Painter Promotions lead finder';
  wb.created = builtAt;
  addSummarySheet(wb, input, summary, states);
  for (const list of LIST_ORDER) addListSheet(wb, list, leads.filter((l) => l.row.list === list));
  const xlsx = Buffer.from(await wb.xlsx.writeBuffer());

  const headers = [LIST, WHY_NOT, SEARCH_CITY, ...QUALIFIED_COLUMNS];
  const csvRows: Cell[][] = leads.map((l) => [
    LEAD_LIST_LABEL[l.row.list],
    l.row.whyNot,
    l.row.searchCity,
    ...QUALIFIED_COLUMNS.map((col) => l.cells[col] ?? null),
  ]);
  const csv = Buffer.from(csvText(headers, csvRows), 'utf8');

  return { xlsx, csv, rows, summary };
}

export const EXPORT_HEADERS = {
  csv: [LIST, WHY_NOT, SEARCH_CITY, ...QUALIFIED_COLUMNS],
  painting: [SEARCH_CITY, ...QUALIFIED_COLUMNS],
  check: [SEARCH_CITY, ...QUALIFIED_COLUMNS],
  likely: [WHY_NOT, SEARCH_CITY, ...QUALIFIED_COLUMNS],
} as const;
