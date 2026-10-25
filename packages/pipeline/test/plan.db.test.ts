import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, loadConfig, truncateAll } from '@pp/core';
import { planSearches } from '../src/plan';
import { q } from '../src/sql';

const handle = getTestDb();
const db = handle.db;
const config = loadConfig();

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

interface Row {
  term: string;
  zip: string;
  phase: string;
  position: number;
  status: string;
  center_lat: number | null;
}

const rows = (runId: number): Promise<Row[]> =>
  q<Row>(db, `SELECT term, zip, phase, position, status, center_lat FROM searches WHERE run_id = $1 ORDER BY position`, [runId]);

describe('planSearches (D-09 amended)', () => {
  it('edison_nj: 15 searches = 5 terms x 3 ZIPs, term-major', async () => {
    const r = await planSearches(db, config, 'edison_nj');
    expect(r).toMatchObject({ inserted: 15, total: 15 });

    const all = await rows(r.runId);
    expect(all).toHaveLength(15);
    expect(all.map((s) => s.position)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    // all 3 ZIPs of term 1, then term 2 ...
    config.search.terms.forEach((term, ti) => {
      const block = all.slice(ti * 3, ti * 3 + 3);
      expect(block.map((s) => s.term)).toEqual([term, term, term]);
      expect(block.map((s) => s.zip)).toEqual(['08817', '08820', '08837']);
    });
    expect(all.every((s) => s.status === 'pending' && s.phase === 'pilot')).toBe(true);
    expect(all.every((s) => s.center_lat !== null)).toBe(true);
  });

  it('creates the run as planned, with the state and a config snapshot', async () => {
    const r = await planSearches(db, config, 'austin_tx');
    const [run] = await q<{ status: string; state: string; area_id: string; snap: { qualification: { minRating: number } } }>(
      db,
      `SELECT status, state, area_id, config_snapshot AS snap FROM runs WHERE id = $1`,
      [r.runId],
    );
    expect(run).toMatchObject({ status: 'planned', state: 'TX', area_id: 'austin_tx' });
    expect(run?.snap.qualification.minRating).toBe(4.7);
    expect(r.total).toBe(60); // 12 pilot ZIPs x 5 terms
  });

  it('re-planning the same run adds nothing', async () => {
    const first = await planSearches(db, config, 'edison_nj');
    const again = await planSearches(db, config, 'edison_nj', 'pilot', first.runId);
    expect(again).toMatchObject({ runId: first.runId, inserted: 0, total: 15 });
  });

  it('expansion searches use the expansion ZIPs, come after the pilot ones, and are also idempotent', async () => {
    const first = await planSearches(db, config, 'edison_nj');
    const exp = await planSearches(db, config, 'edison_nj', 'expansion', first.runId);
    expect(exp.inserted).toBe(45); // 9 expansion ZCTAs x 5 terms
    const all = await rows(first.runId);
    expect(all).toHaveLength(60);
    expect(all.slice(0, 15).every((s) => s.phase === 'pilot')).toBe(true);
    expect(all.slice(15).every((s) => s.phase === 'expansion')).toBe(true);
    expect(new Set(all.slice(15).map((s) => s.zip)).size).toBe(9);
    expect((await planSearches(db, config, 'edison_nj', 'expansion', first.runId)).inserted).toBe(0);
  });

  it('an area with no expansion ZIPs plans nothing for the expansion phase', async () => {
    const first = await planSearches(db, config, 'austin_tx');
    expect((await planSearches(db, config, 'austin_tx', 'expansion', first.runId)).inserted).toBe(0);
  });

  it('refuses an unknown area', async () => {
    await expect(planSearches(db, config, 'atlantis')).rejects.toThrow(/Unknown area/);
  });
});
