import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll } from '@pp/core';
import { QUALIFIED_COLUMNS, runPilot } from '@pp/pipeline';
import { DEFAULT_JOB_SETTINGS, type LeadRow } from '../src/contract';
import { buildExport, EXPORT_HEADERS, type BuiltExport, type ExportArea } from '../src/export';
import { makeEnv, tempDir, testConfig } from './helpers';

const handle = getTestDb();
const db = handle.db;
let runId = 0;
const edison = (): ExportArea => ({ areaId: 'edison_nj', label: 'Edison, NJ', state: 'NJ', runId });

beforeAll(async () => {
  await truncateAll(db);
  runId = (await runPilot(makeEnv(db), 'edison_nj', { fake: true, outDir: tempDir() })).runId;
});
afterAll(async () => {
  await handle.close();
});

const build = (o: Partial<Parameters<typeof buildExport>[2]> = {}): Promise<BuiltExport> =>
  buildExport(db, testConfig(), { name: 'Edison test', settings: DEFAULT_JOB_SETTINGS, areas: [edison()], ...o });

const names = (rows: LeadRow[], list: LeadRow['list']) =>
  rows
    .filter((r) => r.list === list)
    .map((r) => r.company)
    .sort();

async function sheets(xlsx: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  return wb;
}

describe('job export', () => {
  it('splits the run into the lists and fills LeadRow exactly per the contract', async () => {
    const built = await build({ builtAt: new Date('2026-10-28T10:00:00Z') });
    expect(names(built.rows, 'painting')).toEqual(['Fake Expansion Painting', 'Fake Painting One', 'Fake Service Area Painting']);
    expect(names(built.rows, 'check')).toEqual([]);
    const one = built.rows.find((r) => r.company === 'Fake Painting One') as LeadRow;
    expect(Object.keys(one).sort()).toEqual(
      [
        'companyId', 'runId', 'list', 'whyNot', 'areaId', 'searchCity', 'company', 'owner', 'ownerTitle', 'ownerSource',
        'ownerConfidence', 'phone', 'email', 'emailSource', 'website', 'rating', 'reviews', 'googleUrl', 'category',
        'address', 'city', 'zip', 'state', 'licence', 'residentialStatus', 'firstSeen', 'lastChecked',
      ].sort(),
    );
    expect(one).toMatchObject({ runId, list: 'painting', whyNot: null, areaId: 'edison_nj', searchCity: 'Edison, NJ', state: 'NJ', rating: 4.9, reviews: 25 });
    expect(typeof one.companyId).toBe('number');
    expect(one.website).toBe('https://fakepainting-one.test');
    for (const r of built.rows) {
      for (const v of Object.values(r)) expect(v === '' || v === undefined).toBe(false); // blanks are null
    }
    expect(built.summary).toMatchObject({ builtAt: '2026-10-28T10:00:00.000Z', citiesIncluded: 1, counts: { painting: 3 } });
    expect(built.summary.byState.NJ?.painting).toBe(3);
  });

  it('applies the job thresholds at export time only (companies.qualified untouched)', async () => {
    const before = (await db.$client.query(`SELECT id, qualified FROM companies ORDER BY id`)).rows;
    const loose = await build({ settings: { ...DEFAULT_JOB_SETTINGS, minRating: 4.0 } });
    expect(names(loose.rows, 'painting')).toContain('Fake Painting Two'); // rating 4.1
    const strict = await build({ settings: { ...DEFAULT_JOB_SETTINGS, minReviews: 30 } });
    expect(names(strict.rows, 'painting')).toEqual(['Fake Service Area Painting']); // 40 reviews; the others 20 / 25
    expect((await db.$client.query(`SELECT id, qualified FROM companies ORDER BY id`)).rows).toEqual(before);
  });

  it('keeps a company once across cities (first city in position order wins)', async () => {
    const built = await build({ areas: [edison(), { ...edison(), label: 'Edison again, NJ' }] });
    const single = await build();
    expect(built.rows.length).toBe(single.rows.length);
    expect(new Set(built.rows.map((r) => r.searchCity))).toEqual(new Set(['Edison, NJ']));
  });

  it("judges in-area against each run's own area, not the flag a later run of another city wrote", async () => {
    const one = (await db.$client.query(`SELECT id FROM companies WHERE display_name = 'Fake Painting One'`)).rows[0].id as number;
    await db.$client.query(`UPDATE companies SET in_area = false WHERE id = $1`, [one]);
    try {
      expect(names((await build()).rows, 'painting')).toContain('Fake Painting One');
    } finally {
      await db.$client.query(`UPDATE companies SET in_area = true WHERE id = $1`, [one]);
    }
  });

  it('writes the workbook tabs, headers, frozen header row, hyperlinks and a CSV with BOM and a List column', async () => {
    const built = await build({ leftOut: [{ label: 'Paterson, NJ', status: 'failed' }] });
    const wb = await sheets(built.xlsx);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Painting companies', 'Check first', 'Likely fits']);
    const header = (name: string) => (wb.getWorksheet(name)?.getRow(1).values as unknown[]).slice(1);
    expect(header('Painting companies')).toEqual([...EXPORT_HEADERS.painting]);
    expect(header('Check first')).toEqual(['Search city', ...QUALIFIED_COLUMNS]);
    expect(header('Likely fits')).toEqual(['Why not in main list', 'Search city', ...QUALIFIED_COLUMNS]);
    const ws = wb.getWorksheet('Painting companies') as ExcelJS.Worksheet;
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.getRow(1).font?.bold).toBe(true);
    expect(ws.rowCount).toBe(4);
    const websiteCol = 1 + QUALIFIED_COLUMNS.indexOf('Website') + 1;
    const linkCell = [2, 3, 4].map((r) => ws.getRow(r).getCell(websiteCol).value).find((v) => v && typeof v === 'object');
    expect(linkCell).toMatchObject({ hyperlink: expect.stringMatching(/^https:\/\//) });
    const summary = (wb.getWorksheet('Summary') as ExcelJS.Worksheet).getSheetValues().flat().filter((v) => typeof v === 'string');
    expect(summary).toContain('Residential only, Google rating ≥ 4.7, reviews 10–99. Blank = not found; nothing guessed.');
    expect(summary).toContain('Paterson, NJ (failed)');

    const csv = built.csv.toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(EXPORT_HEADERS.csv.map((h) => `"${h}"`).join(','));
    expect(EXPORT_HEADERS.csv.slice(0, 3)).toEqual(['List', 'Why not in main list', 'Search city']);
    expect(lines.filter((l) => l.startsWith('"Painting companies"'))).toHaveLength(3);
    expect(lines.length - 2).toBe(built.rows.length); // header + trailing CRLF
  });
});
