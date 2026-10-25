import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll } from '@pp/core';
import { emptySummary } from '../src/accuracy/compare';
import { computeFillRates, fillRateLines, writeFillRates } from '../src/fillrates';
import { makeEnv } from './helpers';
import { buildScenario } from './scenario';

const handle = getTestDb();
const db = handle.db;
const env = makeEnv(db);

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

describe('fill rates (ACC-03)', () => {
  it('counts owner / email / phone / website over the painting companies and over the qualified ones', async () => {
    const s = await buildScenario(env);
    const r = await computeFillRates(db, env.config, s.runId, s.base);
    expect(r).toMatchObject({ state: 'NJ', area: 'edison_nj', paintingCompanies: 7, qualified: 4 });
    expect(r.fields['owner']).toEqual({
      painting: { count: 2, of: 7, pct: 28.6 },
      qualified: { count: 2, of: 4, pct: 50 },
      missedFindableShare: null,
    });
    expect(r.fields['email']?.painting).toEqual({ count: 1, of: 7, pct: 14.3 });
    expect(r.fields['phone']?.painting).toEqual({ count: 7, of: 7, pct: 100 });
    expect(r.fields['phone']?.qualified).toEqual({ count: 4, of: 4, pct: 100 });
    expect(r.fields['website']?.painting.count).toBe(3);
  });

  it('adds the share of findable values that were missed when a compare result exists', async () => {
    const s = await buildScenario(env);
    const doc = emptySummary('NJ');
    doc.counts['owner_name']!.shown = { correct: 7, wrong: 1, unverifiable: 0 };
    doc.missed['owner_name'] = 2;
    doc.counts['email']!.shown = { correct: 4, wrong: 0, unverifiable: 0 };
    const dir = path.join(s.base, String(s.runId), 'accuracy', 'NJ');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(doc));

    const r = await computeFillRates(db, env.config, s.runId, s.base);
    expect(r.fields['owner']?.missedFindableShare).toBe(30); // 3 of 10 findable owners not found correctly
    expect(r.fields['email']?.missedFindableShare).toBe(0);
    expect(r.fields['phone']?.missedFindableShare).toBeNull(); // nothing compared for phone
  });

  it('prints a table and writes fillrates.json for the run', async () => {
    const s = await buildScenario(env);
    const r = await computeFillRates(db, env.config, s.runId, s.base);
    const lines = fillRateLines(r);
    expect(lines[0]).toContain('7 painting companies, 4 qualified');
    expect(lines.some((l) => l.includes('owner') && l.includes('2/7 (28.6%)'))).toBe(true);
    const file = await writeFillRates(env.config, r, s.base);
    expect(JSON.parse(readFileSync(file, 'utf8')).fields.owner.painting.count).toBe(2);
  });

  it('an empty run gives zero counts, not a division by zero', async () => {
    const s = await buildScenario(env);
    await db.$client.query(`UPDATE listings SET company_id = NULL`);
    const r = await computeFillRates(db, env.config, s.runId, s.base);
    expect(r.paintingCompanies).toBe(0);
    expect(r.fields['owner']?.painting).toEqual({ count: 0, of: 0, pct: 0 });
  });
});
