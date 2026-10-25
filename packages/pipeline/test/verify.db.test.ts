import { rmSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll, type CommandContext } from '@pp/core';
import { verifyCommandSpec } from '../src/commands';
import { MASTER_COLUMNS } from '../src/report/columns';
import { verifyReport } from '../src/report/verify';
import { makeEnv } from './helpers';
import { buildScenario, type Scenario } from './scenario';

const handle = getTestDb();
const db = handle.db;
const env = makeEnv(db);

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

async function edit(s: Scenario, fn: (wb: ExcelJS.Workbook) => void): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(s.report.xlsxPath);
  fn(wb);
  await wb.xlsx.writeFile(s.report.xlsxPath);
}

const masterCol = (name: string): number => MASTER_COLUMNS.indexOf(name as never) + 1;

function ctxFor(s: Scenario, lines: string[]): CommandContext {
  return {
    config: () => ({ ...env.config, report: { ...env.config.report, outDir: s.base } }),
    db: async () => db,
    fetcher: async () => undefined as never,
    evidence: async () => env.evidence,
    log: env.log,
    out: (l) => lines.push(l),
  };
}

describe('report verify (REP-03)', () => {
  it('passes on a correct workbook (exit 0)', async () => {
    const s = await buildScenario(env);
    expect(await verifyReport(db, env.config, s.runId, s.base)).toEqual([]);
    const lines: string[] = [];
    expect(await verifyCommandSpec.run(ctxFor(s, lines), [String(s.runId)], {})).toBe(0);
    expect(lines).toEqual(['report verify: ok']);
  });

  it('fails when a shown email has no Sources row (exit 1)', async () => {
    const s = await buildScenario(env);
    await edit(s, (wb) => {
      const ws = wb.getWorksheet('Sources') as ExcelJS.Worksheet;
      for (let r = ws.rowCount; r >= 2; r--) {
        if (ws.getRow(r).getCell(1).value === 'Alpha Painting' && ws.getRow(r).getCell(2).value === 'Email') ws.spliceRows(r, 1);
      }
    });
    const v = await verifyReport(db, env.config, s.runId, s.base);
    expect(v.some((x) => x.includes('Alpha Painting') && x.includes('"Email"') && x.includes('no Sources row'))).toBe(true);
    const lines: string[] = [];
    expect(await verifyCommandSpec.run(ctxFor(s, lines), [String(s.runId)], {})).toBe(1);
    expect(lines.some((l) => l.startsWith('violation: '))).toBe(true);
  });

  it('fails when a header is reordered (exit 1)', async () => {
    const s = await buildScenario(env);
    await edit(s, (wb) => {
      const ws = wb.getWorksheet('Master list') as ExcelJS.Worksheet;
      const a = ws.getRow(1).getCell(2).value;
      ws.getRow(1).getCell(2).value = ws.getRow(1).getCell(3).value;
      ws.getRow(1).getCell(3).value = a;
    });
    const v = await verifyReport(db, env.config, s.runId, s.base);
    expect(v.some((x) => x.includes('tab "Master list"') && x.includes('header row'))).toBe(true);
    expect(await verifyCommandSpec.run(ctxFor(s, []), [String(s.runId)], {})).toBe(1);
  });

  it('fails on a rating of 0 whose listing rating was not captured (exit 1)', async () => {
    const s = await buildScenario(env);
    await edit(s, (wb) => {
      const ws = wb.getWorksheet('Master list') as ExcelJS.Worksheet;
      for (let r = 2; r <= ws.rowCount; r++) {
        if (ws.getRow(r).getCell(1).value === 'Delta Painters') ws.getRow(r).getCell(masterCol('Google rating')).value = 0;
      }
    });
    const v = await verifyReport(db, env.config, s.runId, s.base);
    expect(v.some((x) => x.includes('Delta Painters') && x.includes('rating is 0'))).toBe(true);
    expect(await verifyCommandSpec.run(ctxFor(s, []), [String(s.runId)], {})).toBe(1);
  });

  it('fails on an unguarded formula prefix, a numeric ZIP, and a non-qualified row without reasons', async () => {
    const s = await buildScenario(env);
    await edit(s, (wb) => {
      const ws = wb.getWorksheet('Master list') as ExcelJS.Worksheet;
      for (let r = 2; r <= ws.rowCount; r++) {
        const name = ws.getRow(r).getCell(1).value;
        if (name === 'Zeta Painting') ws.getRow(r).getCell(masterCol('Owner / decision-maker')).value = '=1+1';
        if (name === 'Alpha Painting') ws.getRow(r).getCell(masterCol('ZIP')).value = 8817;
        if (name === 'Eta Painting') ws.getRow(r).getCell(masterCol('Exclusion reasons')).value = '';
      }
    });
    const v = await verifyReport(db, env.config, s.runId, s.base);
    expect(v.some((x) => x.includes('starts like a formula') || x.includes('is a formula'))).toBe(true);
    expect(v.some((x) => x.includes('ZIP is not a 5-character text cell'))).toBe(true);
    expect(v.some((x) => x.includes('Eta Painting') && x.includes('no exclusion reasons'))).toBe(true);
  });

  it('fails when a CSV header differs from the tab header, and when a CSV is missing', async () => {
    const s = await buildScenario(env);
    const { readFileSync, writeFileSync } = await import('node:fs');
    const text = readFileSync(s.report.masterCsvPath, 'utf8').replace('"Owner title"', '"Owner role"');
    writeFileSync(s.report.masterCsvPath, text);
    expect((await verifyReport(db, env.config, s.runId, s.base)).some((x) => x.includes('master.csv: header'))).toBe(true);

    rmSync(s.report.qualifiedCsvPath);
    expect((await verifyReport(db, env.config, s.runId, s.base)).some((x) => x.includes('qualified.csv not found'))).toBe(true);
  });

  it('reports a missing workbook instead of crashing', async () => {
    const s = await buildScenario(env);
    rmSync(s.report.xlsxPath);
    const v = await verifyReport(db, env.config, s.runId, s.base);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain(path.basename(s.report.xlsxPath));
  });
});
