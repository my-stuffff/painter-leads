import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll } from '@pp/core';
import { chooseSample, drawSample, type Candidate } from '../src/accuracy/sample';
import { TRUTH_FIELDS } from '../src/accuracy/truth';
import { q } from '../src/sql';
import { makeEnv, tempDir } from './helpers';
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

const pop = (q: number, nq: number, np: number): Candidate[] => [
  ...Array.from({ length: q }, (_, i) => ({ companyId: 1 + i, stratum: 'qualified' as const })),
  ...Array.from({ length: nq }, (_, i) => ({ companyId: 1000 + i, stratum: 'non_qualified' as const })),
  ...Array.from({ length: np }, (_, i) => ({ companyId: 2000 + i, stratum: 'non_painter' as const })),
];
const opts = { perState: 50, minQualified: 25, maxNonPainters: 5, seed: 42 };

describe('chooseSample (pure)', () => {
  it('the same seed gives the identical sample in the identical order; another seed another sample', () => {
    const a = chooseSample(pop(30, 60, 10), opts);
    expect(chooseSample(pop(30, 60, 10), opts)).toEqual(a);
    expect(chooseSample([...pop(30, 60, 10)].reverse(), opts)).toEqual(a); // input order does not matter
    expect(chooseSample(pop(30, 60, 10), { ...opts, seed: 43 })).not.toEqual(a);
  });

  it('with more than 25 qualified: 25 qualified, 5 non-painters, the rest non-qualified painters', () => {
    const s = chooseSample(pop(40, 100, 20), opts);
    const n = (st: string): number => s.filter((c) => c.stratum === st).length;
    expect([s.length, n('qualified'), n('non_painter'), n('non_qualified')]).toEqual([50, 25, 5, 20]);
  });

  it('with 10 qualified: all 10, plus 40 others of which at most 5 are non-painters', () => {
    const s = chooseSample(pop(10, 100, 20), opts);
    const n = (st: string): number => s.filter((c) => c.stratum === st).length;
    expect(s).toHaveLength(50);
    expect(n('qualified')).toBe(10);
    expect(n('non_painter')).toBeLessThanOrEqual(5);
    expect(n('non_painter') + n('non_qualified')).toBe(40);
    expect(new Set(s.map((c) => c.companyId)).size).toBe(50);
  });

  it('a small population is sampled whole, and spare qualified companies fill a short non-qualified pool', () => {
    expect(chooseSample(pop(3, 4, 1), opts)).toHaveLength(8);
    const s = chooseSample(pop(40, 5, 0), opts);
    expect(s).toHaveLength(45); // 25 qualified + 5 others, then 15 more qualified up to the limit of what exists
    expect(s.filter((c) => c.stratum === 'qualified').length).toBe(40);
    expect(chooseSample([], opts)).toEqual([]);
  });

  it('the drawn order carries no stratum (qualified companies are not listed first)', () => {
    const s = chooseSample(pop(25, 40, 5), opts);
    const firstQualifiedBlock = s.slice(0, 25).every((c) => c.stratum === 'qualified');
    expect(firstQualifiedBlock).toBe(false);
  });
});

async function seedPopulation(runId: number, qualified: number, others: number, supplies: number): Promise<void> {
  let phone = 1000;
  const next = (): string => `+1732555${String(phone++)}`;
  for (let i = 0; i < qualified; i++) {
    await seedListing(db, env.evidence, runId, { key: `q${i}`, name: `Qualified Painting ${i}`, rating: 4.8, reviews: 20 + (i % 70), phone: next(), street: `${i} Q St`, city: 'Edison', zip: '08817' });
  }
  for (let i = 0; i < others; i++) {
    await seedListing(db, env.evidence, runId, { key: `o${i}`, name: `Other Painting ${i}`, rating: 4.0, reviews: 30, phone: next(), street: `${i} O St`, city: 'Edison', zip: '08820' });
  }
  for (let i = 0; i < supplies; i++) {
    await seedListing(db, env.evidence, runId, { key: `s${i}`, name: `Paint Supply ${i}`, categories: ['Paint store'], rating: 4.9, reviews: 30, phone: next(), street: `${i} S St`, city: 'Edison', zip: '08837' });
  }
}

describe('drawSample on a finished run (ACC-01)', () => {
  it('refuses a run that is not finished (frozen)', async () => {
    const run = await seedRun(db);
    await seedPopulation(run, 3, 3, 1);
    await prepareRun(env, run);
    await expect(drawSample(db, env.config, run, 42, tempDir())).rejects.toThrow(/running; sample only a finished/);
  });

  it('with 10 qualified: all 10 plus 40 others, at most 5 non-painters; the seed is stored and the draw repeats', async () => {
    const run = await seedRun(db);
    await seedPopulation(run, 10, 60, 8);
    await prepareRun(env, run);
    await q(db, `UPDATE runs SET status = 'done' WHERE id = $1`, [run]);

    const base = tempDir();
    const a = await drawSample(db, env.config, run, 42, base);
    expect(a.samples).toHaveLength(50);
    const n = (s: string): number => a.samples.filter((x) => x.stratum === s).length;
    expect(n('qualified')).toBe(10);
    expect(n('non_painter')).toBe(5);
    expect(n('non_qualified')).toBe(35);
    expect(a.samples.map((s) => s.sampleId)).toEqual(Array.from({ length: 50 }, (_, i) => `NJ-${String(i + 1).padStart(3, '0')}`));

    const stored = await q<{ sample_id: string; seed: number; stratum: string; company_id: number }>(
      db,
      `SELECT sample_id, seed, stratum, company_id FROM accuracy_samples WHERE run_id = $1 ORDER BY sample_id`,
      [run],
    );
    expect(stored).toHaveLength(50);
    expect(stored.every((r) => r.seed === 42)).toBe(true);

    const again = await drawSample(db, env.config, run, 42, tempDir());
    expect(again.samples.map((s) => [s.sampleId, s.companyId])).toEqual(a.samples.map((s) => [s.sampleId, s.companyId]));
    expect(await q(db, `SELECT 1 FROM accuracy_samples WHERE run_id = $1`, [run])).toHaveLength(50); // replaced, not doubled

    const other = await drawSample(db, env.config, run, 43, tempDir());
    expect(other.samples.map((s) => s.companyId)).not.toEqual(a.samples.map((s) => s.companyId));
  });

  it('the blind checker file has exactly sample_id, company and google_profile_link; the key and truth form are apart', async () => {
    const run = await seedRun(db);
    await seedPopulation(run, 4, 6, 2);
    await prepareRun(env, run);
    await q(db, `UPDATE runs SET status = 'done' WHERE id = $1`, [run]);
    const r = await drawSample(db, env.config, run, 7, tempDir());

    const sample = parse(readFileSync(r.files.sample, 'utf8'), { bom: true }) as string[][];
    expect(sample[0]).toEqual(['sample_id', 'company', 'google_profile_link']);
    expect(sample).toHaveLength(1 + r.samples.length);
    for (const row of sample.slice(1)) {
      expect(row).toHaveLength(3);
      expect(row[2]).toMatch(/^https:\/\/www\.google\.com\/maps\/place\//);
    }
    // nothing the system knows leaks into the checker's file
    const text = readFileSync(r.files.sample, 'utf8');
    for (const leak of ['qualified', 'non_painter', '4.8', '4.0', '+1732', 'Edison', '08817', 'stratum']) expect(text).not.toContain(leak);

    const key = parse(readFileSync(r.files.key, 'utf8'), { bom: true }) as string[][];
    expect(key[0]).toEqual(['sample_id', 'company_id', 'stratum', 'seed']);
    const template = parse(readFileSync(r.files.truthTemplate, 'utf8'), { bom: true }) as string[][];
    expect(template[0]).toEqual(['sample_id', 'field', 'value', 'source_url', 'checked_at', 'notes']);
    expect(template).toHaveLength(1 + r.samples.length * TRUTH_FIELDS.length);
    expect(template.slice(1).every((row) => row[2] === '')).toBe(true);
  });

  it('companies outside the area are not sampled', async () => {
    const run = await seedRun(db);
    await seedPopulation(run, 3, 2, 0);
    await seedListing(db, env.evidence, run, { key: 'far', name: 'Far Painting', rating: 4.9, reviews: 30, phone: '+17325559000', street: '1 B', city: 'New York', zip: '10001', state: 'NY' });
    await prepareRun(env, run);
    await q(db, `UPDATE runs SET status = 'done' WHERE id = $1`, [run]);
    const r = await drawSample(db, env.config, run, 1, tempDir());
    expect(r.samples.map((s) => s.company)).not.toContain('Far Painting');
    expect(r.samples).toHaveLength(5);
  });
});
