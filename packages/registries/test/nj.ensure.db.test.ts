import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll, type Db } from '@pp/core';
import { ensureNjRosterForTown, resetRosterQueue } from '../src/nj/roster-ensure';
import { makeFetcher, stageContext, tempDir } from './helpers';
import { mockRosterFlow } from './nj-mocks';

let db: Db;
let close: () => Promise<void>;
const saved = process.env.PP_DATA_DIR;

beforeAll(() => {
  ({ db, close } = getTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await truncateAll(db);
});
afterEach(() => {
  if (saved === undefined) delete process.env.PP_DATA_DIR;
  else process.env.PP_DATA_DIR = saved;
  resetRosterQueue();
});

describe('ensureNjRosterForTown', () => {
  it('pulls a town once, reuses a roster younger than 7 days, and pulls again when it is older', async () => {
    const dataDir = tempDir();
    process.env.PP_DATA_DIR = dataDir;
    const { fetcher, agent, config, calls } = makeFetcher();
    const ctx = stageContext(db, fetcher, config);

    mockRosterFlow(agent);
    const first = await ensureNjRosterForTown(ctx, 'Edison');
    expect(first).toMatchObject({ town: 'Edison', how: 'pulled', rows: 8 });
    expect(existsSync(path.join(dataDir, 'downloads', 'nj', 'edison-2026-10-25.txt'))).toBe(true);
    const requests = calls().length;
    expect(requests).toBeGreaterThanOrEqual(8);

    const second = await ensureNjRosterForTown(ctx, 'Edison');
    expect(second.how).toBe('reused');
    expect(calls()).toHaveLength(requests);
    const n = await db.$client.query("SELECT count(*)::int AS n FROM registry_records WHERE source_type = 'nj_hic_roster'");
    expect(n.rows[0].n).toBe(8);

    // 26 days later the file is stale: a new pull
    mockRosterFlow(agent);
    const later = await ensureNjRosterForTown({ ...ctx, now: () => new Date('2026-11-20T12:00:00Z') }, 'Edison');
    expect(later.how).toBe('pulled');
    expect(calls().length).toBeGreaterThan(requests);
  });

  it('queues two towns: one flow after the other', async () => {
    process.env.PP_DATA_DIR = tempDir();
    const { fetcher, agent, config } = makeFetcher();
    const ctx = stageContext(db, fetcher, config);
    mockRosterFlow(agent);
    mockRosterFlow(agent);
    const [a, b] = await Promise.all([ensureNjRosterForTown(ctx, 'Edison'), ensureNjRosterForTown(ctx, 'Iselin')]);
    expect([a.how, b.how]).toEqual(['pulled', 'pulled']);
  });
});
