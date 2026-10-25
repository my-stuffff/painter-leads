import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, loadConfig, truncateAll } from '@pp/core';
import { mergeRun } from '../src/merge';
import { planSearches } from '../src/plan';
import { q } from '../src/sql';
import { computeYields, writeYieldCsv } from '../src/yields';
import { makeEnv, tempDir } from './helpers';
import { seedListing, seedRun } from './seed';

const handle = getTestDb();
const db = handle.db;
const env = makeEnv(db);
const config = loadConfig();

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

describe('pilot yields (D-09)', () => {
  it('counts a new company only where it was first seen, in term-major order', async () => {
    const run = await seedRun(db);
    await planSearches(db, config, 'edison_nj', 'pilot', run);
    const searches = await q<{ id: number; term: string; zip: string; position: number }>(
      db,
      `SELECT id, term, zip, position FROM searches WHERE run_id = $1 ORDER BY position`,
      [run],
    );
    const term1 = config.search.terms[0] as string;
    const term2 = config.search.terms[1] as string;
    const find = (term: string, zip: string): number => (searches.find((s) => s.term === term && s.zip === zip) as { id: number }).id;

    const l = new Map<string, number>();
    for (const key of ['c1', 'c2', 'c3', 'c4']) l.set(key, await seedListing(db, env.evidence, run, { key, name: `Company ${key}` }));
    const hit = async (searchId: number, keys: string[]): Promise<void> => {
      let pos = 1;
      for (const k of keys) await q(db, `INSERT INTO search_hits (search_id, listing_id, position) VALUES ($1, $2, $3)`, [searchId, l.get(k), pos++]);
      await q(db, `UPDATE searches SET status = 'done', cards_found = $2 WHERE id = $1`, [searchId, keys.length]);
    };
    await hit(find(term1, '08817'), ['c1', 'c2']);
    await hit(find(term1, '08820'), ['c2', 'c3']);
    await hit(find(term2, '08817'), ['c1', 'c4']);
    await mergeRun(db, env.evidence, config, run);

    const y = await computeYields(db, run);
    const byTerm = new Map(y.terms.map((t) => [t.key, t]));
    expect(byTerm.get(term1)).toEqual({ key: term1, searches: 3, cards: 4, newCompanies: 3 });
    expect(byTerm.get(term2)).toEqual({ key: term2, searches: 3, cards: 2, newCompanies: 1 });
    const byZip = new Map(y.zips.map((z) => [z.key, z]));
    expect(byZip.get('08817')).toMatchObject({ newCompanies: 3 }); // c1, c2 (term 1) and c4 (term 2)
    expect(byZip.get('08820')).toMatchObject({ newCompanies: 1 }); // c3
    expect(byZip.get('08837')).toMatchObject({ newCompanies: 0 });

    // the new-company figures add up to the number of companies
    const total = y.terms.reduce((s, t) => s + t.newCompanies, 0);
    expect(total).toBe(4);
    expect(y.zips.reduce((s, z) => s + z.newCompanies, 0)).toBe(4);
  });

  it('merged listings count as one company', async () => {
    const run = await seedRun(db);
    await planSearches(db, config, 'edison_nj', 'pilot', run);
    const [s1, s2] = await q<{ id: number }>(db, `SELECT id FROM searches WHERE run_id = $1 ORDER BY position LIMIT 2`, [run]);
    const a = await seedListing(db, env.evidence, run, { key: 'a', name: 'Acme Painting', phone: '+17325550100' });
    const b = await seedListing(db, env.evidence, run, { key: 'b', name: 'Acme Painting', phone: '+17325550100' });
    await q(db, `INSERT INTO search_hits (search_id, listing_id, position) VALUES ($1, $2, 1)`, [s1?.id, a]);
    await q(db, `INSERT INTO search_hits (search_id, listing_id, position) VALUES ($1, $2, 1)`, [s2?.id, b]);
    await mergeRun(db, env.evidence, config, run);
    const y = await computeYields(db, run);
    expect(y.terms.reduce((s, t) => s + t.newCompanies, 0)).toBe(1);
  });

  it('writes yield.csv with kind, key, searches, cards, new_companies', async () => {
    const run = await seedRun(db);
    await planSearches(db, config, 'edison_nj', 'pilot', run);
    const dir = tempDir();
    const file = await writeYieldCsv(dir, await computeYields(db, run));
    const rows = parse(readFileSync(file, 'utf8'), { bom: true }) as string[][];
    expect(rows[0]).toEqual(['kind', 'key', 'searches', 'cards', 'new_companies']);
    expect(rows).toHaveLength(1 + config.search.terms.length + 3);
    expect(rows[1]).toEqual(['term', config.search.terms[0], '3', '0', '0']);
  });
});
