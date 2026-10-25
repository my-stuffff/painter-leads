import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, loadConfig, truncateAll } from '@pp/core';
import { qualifyRun } from '../src/qualify';
import { MASTER_COLUMNS, QUALIFIED_COLUMNS, TAB_NAMES } from '../src/report/columns';
import { generateReport } from '../src/report/stage';
import { verifyReport } from '../src/report/verify';
import { writeWorkbook } from '../src/report/workbook';
import { makeEnv, readSheets, tempDir } from './helpers';
import { buildScenario } from './scenario';
import { prepareRun, seedListing, seedRun } from './seed';

const handle = getTestDb();
const db = handle.db;
const env = makeEnv(db);

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

const masterCol = (name: string): number => MASTER_COLUMNS.indexOf(name as never);

async function masterByName(file: string): Promise<Map<string, unknown[]>> {
  const sheets = await readSheets(file);
  return new Map((sheets['Master list'] as unknown[][]).slice(1).map((r) => [r[masterCol('Company')] as string, r]));
}

describe('the workbook built from a seeded database (REP-01)', () => {
  it('shows each company the way the rules say, and report verify passes on it', async () => {
    const s = await buildScenario(env);
    const by = await masterByName(s.report.xlsxPath);
    expect(by.size).toBe(8);

    const qualified = [...by.values()].filter((r) => r[masterCol('Qualified')] === 'yes').map((r) => r[masterCol('Company')]);
    expect(qualified.sort()).toEqual(['Alpha Painting', 'CertaPro Painters of Edison', 'Epsilon Mobile Painting', 'Zeta Painting']);

    const reason = (n: string): unknown => by.get(n)?.[masterCol('Exclusion reasons')];
    expect(reason('Beta Commercial Painting')).toBe('also commercial');
    expect(reason('Gamma Paint Supply')).toBe('not a painting contractor');
    expect(reason('Delta Painters')).toBe('rating not captured; review count not captured');
    expect(reason('Eta Painting')).toBe('rating below minimum');
    expect(reason('Alpha Painting') ?? '').toBe(''); // an empty string is a blank cell

    // service-area business: pin-based place, no street address, no ZIP
    const sab = by.get('Epsilon Mobile Painting') as unknown[];
    expect(sab[masterCol('Address')]).toBe('location approximate (service-area business)');
    expect(sab[masterCol('ZIP')]).toBeUndefined();
    expect(sab[masterCol('City')]).toBe('Edison');
    expect(sab[masterCol('Google rating')]).toBe(4.7);
    expect(sab[masterCol('Google reviews')]).toBe(10);

    // franchise location is kept as its own row
    expect(by.has('CertaPro Painters of Edison')).toBe(true);
    expect(by.get('CertaPro Painters of Edison')?.[masterCol('Google reviews')]).toBe(99);

    // not captured stays blank, never 0
    const delta = by.get('Delta Painters') as unknown[];
    expect(delta[masterCol('Google rating')]).toBeUndefined();
    expect(delta[masterCol('Google reviews')]).toBeUndefined();

    expect(await verifyReport(db, env.config, s.runId, s.base)).toEqual([]);
  });

  it('six tabs in order; the Qualified tab holds exactly the qualified rows', async () => {
    const s = await buildScenario(env);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(s.report.xlsxPath);
    expect(wb.worksheets.map((w) => w.name)).toEqual([...TAB_NAMES]);
    const sheets = await readSheets(s.report.xlsxPath);
    expect(sheets['Qualified']).toHaveLength(1 + 4);
    expect(sheets['Qualified']?.[0]).toEqual([...QUALIFIED_COLUMNS]);
  });

  it('phone is the Google listing phone in national format; owner/email show their source and confidence', async () => {
    const s = await buildScenario(env);
    const alpha = (await masterByName(s.report.xlsxPath)).get('Alpha Painting') as unknown[];
    expect(alpha[masterCol('Phone')]).toBe('(732) 555-0101');
    expect(alpha[masterCol('Owner / decision-maker')]).toBe('Jane Alpha');
    expect(alpha[masterCol('Owner title')]).toBe('Owner');
    expect(alpha[masterCol('Owner source')]).toBe('Company website');
    expect(alpha[masterCol('Owner confidence')]).toBe('medium');
    expect(alpha[masterCol('Email')]).toBe('info@alphapainting.com');
    expect(alpha[masterCol('Email source')]).toBe('Company website'); // the website row (higher priority) with its confidence tie-break
    expect(alpha[masterCol('Licence/registration no.')]).toBe('13VH00000100');
    expect(alpha[masterCol('Residential status')]).toBe('Residential only');
    expect(alpha[masterCol('First seen')]).toBe('2026-10-25');
  });

  it('ZIP stays a 5-character text cell', async () => {
    const s = await buildScenario(env);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(s.report.xlsxPath);
    const ws = wb.getWorksheet('Master list') as ExcelJS.Worksheet;
    const zipCol = masterCol('ZIP') + 1;
    const alphaRow = ws.getRows(2, ws.rowCount - 1)?.find((r) => r.getCell(1).value === 'Alpha Painting') as ExcelJS.Row;
    expect(alphaRow.getCell(zipCol).value).toBe('08817');
    expect(typeof alphaRow.getCell(zipCol).value).toBe('string');
  });

  it('a scraped value that looks like a formula is guarded in the workbook and in the CSV', async () => {
    const s = await buildScenario(env);
    const zeta = (await masterByName(s.report.xlsxPath)).get('Zeta Painting') as unknown[];
    expect(zeta[masterCol('Owner / decision-maker')]).toBe(`'=HYPERLINK("http://evil.test","click")`);
    const csv = readFileSync(s.report.masterCsvPath, 'utf8');
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"",""click"")"`);
    expect(csv).not.toMatch(/,"=HYPERLINK/);
  });

  it('only http/https URLs become hyperlinks', async () => {
    const s = await buildScenario(env);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(s.report.xlsxPath);
    const ws = wb.getWorksheet('Master list') as ExcelJS.Worksheet;
    const rowOf = (name: string): ExcelJS.Row => ws.getRows(2, ws.rowCount - 1)?.find((r) => r.getCell(1).value === name) as ExcelJS.Row;
    const web = rowOf('Alpha Painting').getCell(masterCol('Website') + 1).value as { text: string; hyperlink: string };
    expect(web).toMatchObject({ hyperlink: 'https://alphapainting.com' });
    const bad = rowOf('Zeta Painting').getCell(masterCol('Website') + 1).value;
    expect(typeof bad).toBe('string');
    expect(bad).toBe('javascript:alert(1)');
    const link = rowOf('Alpha Painting').getCell(masterCol('Google profile link') + 1).value as { hyperlink: string };
    expect(link.hyperlink).toBe('https://www.google.com/maps/place/seed-alpha');
  });

  it('a company found by several searches appears once and is counted once in By city under its own city', async () => {
    const s = await buildScenario(env);
    const sheets = await readSheets(s.report.xlsxPath);
    expect((sheets['Master list'] as unknown[][]).filter((r) => r[0] === 'Alpha Painting')).toHaveLength(1);
    expect(sheets['By city']).toEqual([
      ['City', 'Companies found', 'Qualified', 'With owner', 'With email'],
      ['Edison', 8, 4, 2, 1],
    ]);
  });

  it('Contact completeness counts match the Master rows', async () => {
    const s = await buildScenario(env);
    const sheets = await readSheets(s.report.xlsxPath);
    const master = (sheets['Master list'] as unknown[][]).slice(1);
    const filled = (col: string, onlyQualified = false): number =>
      master.filter((r) => (!onlyQualified || r[masterCol('Qualified')] === 'yes') && r[masterCol(col)] !== undefined && r[masterCol(col)] !== '').length;
    const rows = new Map((sheets['Contact completeness'] as unknown[][]).slice(1).map((r) => [r[0], r]));
    expect(rows.get('Owner')).toEqual(['Owner', filled('Owner / decision-maker'), 25, filled('Owner / decision-maker', true), 50]);
    expect(rows.get('Email')).toEqual(['Email', 1, 12.5, 1, 25]);
    expect(rows.get('Phone')?.[1]).toBe(filled('Phone'));
    expect(rows.get('Website')?.[1]).toBe(filled('Website'));
  });

  it('Summary lists the counts, every exclusion reason, and each source with its switch (Texas Comptroller off)', async () => {
    const s = await buildScenario(env);
    const sheets = await readSheets(s.report.xlsxPath);
    const summary = new Map((sheets['Summary'] as unknown[][]).slice(1).map((r) => [r[0] as string, r[1]]));
    expect(summary.get('Run date')).toBe('2026-10-25');
    expect(summary.get('Area')).toBe('edison_nj');
    expect(summary.get('Qualified')).toBe(4);
    expect(summary.get('Not painting contractors')).toBe(1);
    expect(summary.get('Excluded: also commercial')).toBe(1);
    expect(summary.get('Excluded: rating not captured')).toBe(1);
    expect(String(summary.get('Source: TX Comptroller'))).toContain('switch off');
    expect(String(summary.get('Source: Google Maps'))).toContain('switch on');
    expect(String(summary.get('Source: Google Maps'))).toMatch(/first captured 2026-10-25, last 2026-10-25/);
    expect(summary.has('Note: ZIP codes')).toBe(true);
  });

  it('QUAL-04: raising minRating from 4.7 to 4.8 turns the 4.7 company from qualified to excluded on the next report', async () => {
    const s = await buildScenario(env);
    expect((await masterByName(s.report.xlsxPath)).get('Epsilon Mobile Painting')?.[masterCol('Qualified')]).toBe('yes');

    const stricter = { ...env.config, qualification: { ...env.config.qualification, minRating: 4.8 } };
    await qualifyRun(db, stricter, s.runId);
    const again = await generateReport(db, stricter, s.runId, tempDir());
    const row = (await masterByName(again.xlsxPath)).get('Epsilon Mobile Painting') as unknown[];
    expect(row[masterCol('Qualified')]).toBe('no');
    expect(row[masterCol('Exclusion reasons')]).toBe('rating below minimum');
  });

  it('two reports of the same run have identical cell values and the same row order', async () => {
    const s = await buildScenario(env);
    const second = await generateReport(db, env.config, s.runId, tempDir());
    expect(await readSheets(second.xlsxPath)).toEqual(await readSheets(s.report.xlsxPath));
    expect(readFileSync(second.masterCsvPath, 'utf8')).toBe(readFileSync(s.report.masterCsvPath, 'utf8'));
  });

  it('rows are sorted by state, city, then company name (case-insensitive)', async () => {
    const run = await seedRun(db);
    const common = { phone: '+17325550100' };
    await seedListing(db, env.evidence, run, { key: 'z', name: 'zeta painting', street: '1 A St', city: 'Edison', zip: '08817', ...common });
    await seedListing(db, env.evidence, run, { key: 'a', name: 'Alpha Painting', street: '1 B St', city: 'Edison', zip: '08817', phone: '+17325550101' });
    await seedListing(db, env.evidence, run, { key: 'm', name: 'Middle Painting', street: '1 C St', city: 'Zebra Town', zip: '08820', phone: '+17325550102' });
    await seedListing(db, env.evidence, run, { key: 'b', name: 'beta Painting', street: '1 D St', city: 'Edison', zip: '08837', phone: '+17325550103' });
    await prepareRun(env, run);
    const r = await generateReport(db, env.config, run, tempDir());
    const master = ((await readSheets(r.xlsxPath))['Master list'] as unknown[][]).slice(1).map((x) => x[masterCol('Company')]);
    expect(master).toEqual(['Alpha Painting', 'beta Painting', 'zeta painting', 'Middle Painting']);
  });

  it('CSV columns and rows equal the workbook tabs (REP-02)', async () => {
    const s = await buildScenario(env);
    const sheets = await readSheets(s.report.xlsxPath);
    const master = parse(readFileSync(s.report.masterCsvPath, 'utf8'), { bom: true }) as string[][];
    const qualified = parse(readFileSync(s.report.qualifiedCsvPath, 'utf8'), { bom: true }) as string[][];
    expect(master[0]).toEqual([...MASTER_COLUMNS]);
    expect(qualified[0]).toEqual([...QUALIFIED_COLUMNS]);
    expect(master.slice(1).map((r) => r[0])).toEqual((sheets['Master list'] as unknown[][]).slice(1).map((r) => r[0]));
    expect(qualified).toHaveLength(1 + 4);

    // blanks are empty fields, never null / undefined / 0
    const delta = master.find((r) => r[0] === 'Delta Painters') as string[];
    expect(delta[masterCol('Google rating')]).toBe('');
    expect(delta[masterCol('Google reviews')]).toBe('');
    expect(readFileSync(s.report.masterCsvPath, 'utf8')).not.toMatch(/null|undefined/);
  });
});

describe('the Sources tab (REP-03)', () => {
  it('lists every source row behind a shown value: two rows when two sources agree on the email', async () => {
    const s = await buildScenario(env);
    const sources = ((await readSheets(s.report.xlsxPath))['Sources'] as unknown[][]).slice(1);
    const emailRows = sources.filter((r) => r[0] === 'Alpha Painting' && r[1] === 'Email');
    expect(emailRows).toHaveLength(2);
    expect(emailRows.map((r) => r[3]).sort()).toEqual(['https://alphapainting.com/contact', 'https://newjersey.mylicense.com/seed/1']);
    expect(emailRows.every((r) => r[2] === 'info@alphapainting.com')).toBe(true);
  });

  it('a blank cell has no Sources row, a shown value has at least one', async () => {
    const s = await buildScenario(env);
    const sources = ((await readSheets(s.report.xlsxPath))['Sources'] as unknown[][]).slice(1);
    expect(sources.filter((r) => r[0] === 'Delta Painters' && r[1] === 'Google rating')).toHaveLength(0);
    expect(sources.filter((r) => r[0] === 'Delta Painters' && r[1] === 'Owner / decision-maker')).toHaveLength(0);
    expect(sources.filter((r) => r[0] === 'Alpha Painting' && r[1] === 'Google rating').length).toBeGreaterThanOrEqual(1);
  });

  it('rows are grouped by company, then by field in Master column order', async () => {
    const s = await buildScenario(env);
    const sources = ((await readSheets(s.report.xlsxPath))['Sources'] as unknown[][]).slice(1);
    const companyOrder = [...new Set(sources.map((r) => r[0] as string))];
    expect(companyOrder).toEqual([...companyOrder].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)));
    for (const company of companyOrder) {
      const fields = sources.filter((r) => r[0] === company).map((r) => MASTER_COLUMNS.indexOf(r[1] as never));
      expect(fields.every((f) => f >= 0)).toBe(true);
      expect(fields).toEqual([...fields].sort((a, b) => a - b));
    }
  });

  it('every row has a source URL, a capture time and a confidence', async () => {
    const s = await buildScenario(env);
    const sources = ((await readSheets(s.report.xlsxPath))['Sources'] as unknown[][]).slice(1);
    expect(sources.length).toBeGreaterThan(20);
    for (const r of sources) {
      expect(String(r[3])).toMatch(/^https?:\/\//);
      expect(String(r[4])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(['high', 'medium', 'low']).toContain(r[5]);
    }
  });
});

describe('empty and interrupted reports', () => {
  it('a run with zero qualified companies still produces all six tabs with headers and zero counts', async () => {
    const run = await seedRun(db);
    await seedListing(db, env.evidence, run, { key: 'g', name: 'Only Paint Supply', categories: ['Paint store'], rating: 4.9, reviews: 20, phone: '+17325550100', street: '1 A St', city: 'Edison', zip: '08817' });
    await prepareRun(env, run);
    const r = await generateReport(db, env.config, run, tempDir());
    expect(r.counts.qualified).toBe(0);
    const sheets = await readSheets(r.xlsxPath);
    expect(Object.keys(sheets)).toEqual([...TAB_NAMES]);
    expect(sheets['Qualified']).toEqual([[...QUALIFIED_COLUMNS]]);
    expect((sheets['Contact completeness'] as unknown[][])[1]).toEqual(['Owner', 0, 0, 0, 0]);
    expect(await verifyReport(db, env.config, run, path.dirname(path.dirname(r.xlsxPath)))).toEqual([]);
  });

  it('a run with no companies at all also produces six tabs', async () => {
    const run = await seedRun(db);
    const r = await generateReport(db, env.config, run, tempDir());
    const sheets = await readSheets(r.xlsxPath);
    expect(Object.keys(sheets)).toEqual([...TAB_NAMES]);
    expect(sheets['Master list']).toHaveLength(1);
    expect(sheets['By city']).toHaveLength(1);
  });

  it('the workbook is written to a temp file and renamed: an interrupted write leaves no half file and keeps the old one', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'x', 'run.xlsx');
    const model = { companies: [], sources: [], byCity: [], completeness: [], summary: [] };
    await writeWorkbook(file, model);
    const before = readFileSync(file);

    await expect(
      writeWorkbook(file, model, {
        write: async (_wb, tmp) => {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(tmp, 'half a workbook');
          throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');

    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const fresh = path.join(dir, 'y', 'new.xlsx');
    await expect(
      writeWorkbook(fresh, model, { write: async () => { throw new Error('boom'); } }),
    ).rejects.toThrow('boom');
    expect(existsSync(fresh)).toBe(false);
  });

  it('uses the thresholds of the config it was given (sanity: the shipped config is 4.7 / 10 / 99)', () => {
    expect(loadConfig().qualification).toMatchObject({ minRating: 4.7, minReviews: 10, maxReviews: 99 });
  });
});
