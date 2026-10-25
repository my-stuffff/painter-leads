import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_BLOCKED, getTestDb, truncateAll } from '@pp/core';
import { createDbFakeStages } from '../src/fake-stages';
import { runPilot } from '../src/run';
import { resolveStages } from '../src/stages';
import { q } from '../src/sql';
import {
  BY_CITY_COLUMNS,
  COMPLETENESS_COLUMNS,
  MASTER_COLUMNS,
  QUALIFIED_COLUMNS,
  SOURCES_COLUMNS,
  SUMMARY_COLUMNS,
  TAB_NAMES,
} from '../src/report/columns';
import { makeEnv, readSheets, sheetNames, tempDir } from './helpers';

const handle = getTestDb();
const db = handle.db;

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

describe('pp pilot run --fake-stages, end to end on a real database', () => {
  it('goes from planned searches to a six-tab workbook and two CSVs', async () => {
    const out = tempDir();
    const env = makeEnv(db);
    const outcome = await runPilot(env, 'edison_nj', { fake: true, outDir: out });

    expect(outcome).toMatchObject({ exitCode: 0, status: 'done', stopped: null });
    const report = outcome.report!;
    expect(report.xlsxPath).toBe(path.join(out, String(outcome.runId), 'edison_nj.xlsx'));
    expect(env.lines.join('\n')).toContain(report.xlsxPath);
    expect(env.lines.join('\n')).toContain(report.masterCsvPath);

    expect(await sheetNames(report.xlsxPath)).toEqual([...TAB_NAMES]);

    const sheets = await readSheets(report.xlsxPath);
    expect(sheets['Qualified']?.[0]).toEqual([...QUALIFIED_COLUMNS]);
    expect(sheets['Master list']?.[0]).toEqual([...MASTER_COLUMNS]);
    expect(sheets['By city']?.[0]).toEqual([...BY_CITY_COLUMNS]);
    expect(sheets['Contact completeness']?.[0]).toEqual([...COMPLETENESS_COLUMNS]);
    expect(sheets['Summary']?.[0]).toEqual([...SUMMARY_COLUMNS]);
    expect(sheets['Sources']?.[0]).toEqual([...SOURCES_COLUMNS]);

    for (const file of [report.masterCsvPath, report.qualifiedCsvPath]) {
      expect(readFileSync(file, 'utf8').charCodeAt(0)).toBe(0xfeff);
    }
    const headerLine = (file: string): string => readFileSync(file, 'utf8').slice(1).split('\r\n')[0] as string;
    expect(headerLine(report.masterCsvPath)).toBe(MASTER_COLUMNS.map((h) => `"${h}"`).join(','));
    expect(headerLine(report.qualifiedCsvPath)).toBe(QUALIFIED_COLUMNS.map((h) => `"${h}"`).join(','));

    const [run] = await q<{ status: string; finished_at: Date | null }>(db, `SELECT status, finished_at FROM runs WHERE id = $1`, [outcome.runId]);
    expect(run?.status).toBe('done');
    expect(run?.finished_at).not.toBeNull();
  });

  it('the workbook shows the fake companies the way the rules say', async () => {
    const outcome = await runPilot(makeEnv(db), 'edison_nj', { fake: true, outDir: tempDir() });
    const sheets = await readSheets(outcome.report!.xlsxPath);
    const master = sheets['Master list'] as unknown[][];
    const col = (name: string): number => MASTER_COLUMNS.indexOf(name as never);
    const byName = new Map(master.slice(1).map((r) => [r[col('Company')] as string, r] as const));

    const qualified = master
      .slice(1)
      .filter((r) => r[col('Qualified')] === 'yes')
      .map((r) => r[col('Company')]);
    expect(qualified.sort()).toEqual(['Fake Expansion Painting', 'Fake Painting One', 'Fake Service Area Painting']);
    expect(sheets['Qualified']).toHaveLength(1 + 3);

    expect(byName.get('Fake Painting Two')?.[col('Exclusion reasons')]).toBe('rating below minimum');
    expect(byName.get('Fake Paint Depot')?.[col('Exclusion reasons')]).toBe('not a painting contractor');
    expect(byName.get('Fake Painters Limited View')?.[col('Exclusion reasons')]).toBe('rating not captured; review count not captured');
    expect(byName.get('Fake Painters Limited View')?.[col('Google rating')]).toBeUndefined();
    expect(byName.get('Fake Commercial Coatings')?.[col('Exclusion reasons')]).toBe('also commercial');

    const one = byName.get('Fake Painting One') as unknown[];
    expect(one[col('Phone')]).toMatch(/^\(\d{3}\) \d{3}-\d{4}$/);
    expect(one[col('ZIP')]).toBe('08817');
    expect(one[col('Owner / decision-maker')]).toBe('Jane Fake');
    expect(one[col('Email source')]).toBe('Company website');

    const sab = byName.get('Fake Service Area Painting') as unknown[];
    expect(sab[col('Address')]).toBe('location approximate (service-area business)');
    expect(sab[col('ZIP')]).toBeUndefined();
    expect(sab[col('City')]).toBe('Edison');
  });

  it('the expansion ZIPs are searched only because Edison yielded fewer than 60 painting companies', async () => {
    const env = makeEnv(db);
    const outcome = await runPilot(env, 'edison_nj', { fake: true, outDir: tempDir() });
    const [n] = await q<{ n: string }>(db, `SELECT COUNT(*) AS n FROM searches WHERE run_id = $1 AND phase = 'expansion'`, [outcome.runId]);
    expect(Number(n?.n)).toBe(45);
    expect(env.lines.join('\n')).toMatch(/expansion searches added/);
  });

  it('a block stops the run with exit code 3 and a resume continues without re-running done searches', async () => {
    const env = makeEnv(db);
    const stages = resolveStages({ fake: true, fakeOptions: { blockAfterSearches: 4 } });
    const first = await runPilot(env, 'edison_nj', { stages, outDir: tempDir() });
    expect(first.exitCode).toBe(EXIT_BLOCKED);
    expect(first.status).toBe('blocked');

    const [mid] = await q<{ status: string; reason: string | null }>(db, `SELECT status, stopped_reason AS reason FROM runs WHERE id = $1`, [first.runId]);
    expect(mid?.status).toBe('blocked');
    expect(mid?.reason).toContain('sorry');
    const doneBefore = await q<{ id: number; attempts: number }>(db, `SELECT id, attempts FROM searches WHERE run_id = $1 AND status = 'done' ORDER BY id`, [first.runId]);
    expect(doneBefore).toHaveLength(4);

    const second = await runPilot(env, 'edison_nj', { stages, runId: first.runId, outDir: tempDir() });
    expect(second).toMatchObject({ exitCode: 0, status: 'done', runId: first.runId });
    const after = await q<{ id: number; attempts: number }>(db, `SELECT id, attempts FROM searches WHERE run_id = $1 AND id = ANY($2::int[]) ORDER BY id`, [first.runId, doneBefore.map((d) => d.id)]);
    expect(after).toEqual(doneBefore); // finished searches were not run again
  });

  it('a stage nobody provides fails loudly instead of being skipped', () => {
    expect(() => resolveStages({ modules: [] })).toThrow('stage discover not provided (package maps not merged yet)');
    expect(() => resolveStages({ modules: [{ name: 'maps', commands: [], replayers: {}, stages: createDbFakeStages() }] })).toThrow(
      'stage site-enrich not provided (package sites not merged yet)',
    );
  });

  it('refuses to resume a run under another area', async () => {
    const env = makeEnv(db);
    const first = await runPilot(env, 'edison_nj', { fake: true, outDir: tempDir() });
    await expect(runPilot(env, 'austin_tx', { fake: true, runId: first.runId, outDir: tempDir() })).rejects.toThrow(/is for edison_nj/);
  });
});
