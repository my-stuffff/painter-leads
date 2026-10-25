import { getTestDb, schema, truncateAll, type Db } from '@pp/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDetailStage } from '../src/detail';
import { createDiscoverStage } from '../src/discover';
import type { CardSnapshot, FixturePage } from '../src/driver/types';
import { isTransientNavError } from '../src/transient';
import {
  createRun,
  createSearches,
  driverFactory,
  fakeCard,
  fakePlace,
  makeClock,
  makeCtx,
  rng,
  searchPage,
  SORRY_PAGE,
  testConfig,
  type TestClock,
} from './helpers';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
  ({ db, close } = getTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await truncateAll(db);
});

/** What Playwright throws when page.goto runs out of time. */
const timeoutError = (): Error => {
  const e = new Error('page.goto: Timeout 60000ms exceeded.\nCall log:\n  - navigating to "https://www.google.com/maps/search/x", waiting until "domcontentloaded"');
  e.name = 'TimeoutError';
  return e;
};
const slow: FixturePage = { kind: 'throw', error: timeoutError() };
const netDown = (): FixturePage => ({ kind: 'throw', error: new Error('page.goto: net::ERR_INTERNET_DISCONNECTED at https://www.google.com/maps/search/x') });

async function discover(runId: number, pages: FixturePage[], clock: TestClock) {
  const f = driverFactory(pages);
  const stage = createDiscoverStage({ driverFactory: f.make, rng: rng() });
  const result = await stage.run(makeCtx(db, runId, clock, testConfig()), { runId });
  return { result, drivers: f.drivers };
}

const searchRows = async () => (await db.select().from(schema.searches).orderBy(schema.searches.position));
const runRow = async () => (await db.select().from(schema.runs))[0];

describe('isTransientNavError', () => {
  it('is true for a Playwright TimeoutError and for net::ERR_* messages, false for anything else', () => {
    expect(isTransientNavError(timeoutError())).toBe(true);
    expect(isTransientNavError(new Error('page.goto: net::ERR_CONNECTION_RESET at https://x'))).toBe(true);
    expect(isTransientNavError(new Error('browser crashed'))).toBe(false);
    expect(isTransientNavError(new Error('refusing to navigate outside https://www.google.com/maps: https://evil'))).toBe(false);
    expect(isTransientNavError('net::ERR_FAILED')).toBe(false);
  });
});

describe('discover: a slow page is a retry, not a crash', () => {
  it('(a) one timeout then success: waits 30-60 s, retries the same URL once, the search is done and the run goes on', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{ zip: '08820' }]);
    const clock = makeClock();
    const { result, drivers } = await discover(runId, [slow, searchPage([fakeCard(1), fakeCard(2)])], clock);

    expect(result).toMatchObject({ searchesDone: 1, searchesRemaining: 0, cardsSeen: 2, newListings: 2, stopped: null });
    const opened = drivers.flatMap((d) => d.opened);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toBe(opened[0]);
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(30_000);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(60_000);
    expect((await searchRows())[0]).toMatchObject({ status: 'done', cardsFound: 2 });
    expect((await runRow())?.status).toBe('running');
    expect((await db.select().from(schema.requestLog)).map((l) => l.outcome).sort()).toEqual(['ok', 'timeout']);
  });

  it('a net::ERR_* error is retried the same way', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}]);
    const { result } = await discover(runId, [netDown(), searchPage([fakeCard(1)])], makeClock());
    expect(result).toMatchObject({ searchesDone: 1, stopped: null });
    expect((await db.select().from(schema.requestLog)).map((l) => l.outcome).sort()).toEqual(['http_error', 'ok']);
  });

  it('(b) two timeouts on one search: it stays pending, writes no evidence, the next search runs, the run is not failed', async () => {
    const runId = await createRun(db);
    const [s1, s2, s3] = (await createSearches(db, runId, [{ zip: '08817' }, { zip: '08820' }, { zip: '08837' }])) as [number, number, number];
    const clock = makeClock();
    const { result, drivers } = await discover(runId, [slow, slow, searchPage([fakeCard(1)]), searchPage([fakeCard(2)])], clock);

    expect(result).toMatchObject({ searchesDone: 2, searchesRemaining: 1, stopped: null });
    const rows = new Map((await searchRows()).map((r) => [r.id, r]));
    expect(rows.get(s1)).toMatchObject({ status: 'pending', cardsFound: null, finishedAt: null });
    expect(rows.get(s2)?.status).toBe('done');
    expect(rows.get(s3)?.status).toBe('done');
    expect((await runRow())?.status).toBe('running');
    expect(drivers[0]?.closed).toBe(true);
    // 08817 was opened twice (first try + retry) and nothing was stored for it.
    const opened = drivers.flatMap((d) => d.opened);
    expect(opened.filter((u) => u.includes('08817'))).toHaveLength(2);
    expect(await db.select().from(schema.listings)).toHaveLength(2);
    expect(await db.select().from(schema.evidence).where(eq(schema.evidence.field, 'review_count'))).toHaveLength(2);
    expect((await db.select().from(schema.requestLog)).filter((l) => l.outcome === 'timeout')).toHaveLength(2);

    // Resume picks the pending search up again and finishes it.
    const resumed = await discover(runId, [searchPage([fakeCard(3)])], makeClock());
    expect(resumed.result).toMatchObject({ searchesDone: 1, searchesRemaining: 0, stopped: null });
    expect(new Map((await searchRows()).map((r) => [r.id, r])).get(s1)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('(c) three searches in a row that fail twice stop the run like a daily cap: status stopped, signal daily_cap, resumable', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}, {}, {}, {}]);
    const clock = makeClock();
    const { result, drivers } = await discover(runId, [slow, slow, netDown(), slow, slow, slow, searchPage([fakeCard(1)])], clock);

    expect(result.stopped?.signal).toBe('daily_cap');
    expect(result.stopped?.detail).toMatch(/network/i);
    expect(result).toMatchObject({ searchesDone: 0, searchesRemaining: 4 });
    expect(drivers.flatMap((d) => d.opened)).toHaveLength(6); // the fourth search is never opened
    expect((await searchRows()).map((r) => r.status)).toEqual(['pending', 'pending', 'pending', 'pending']);
    const run = await runRow();
    expect(run?.status).toBe('stopped');
    expect(run?.stoppedReason).toMatch(/^daily_cap: /);
    expect(run?.finishedAt).not.toBeNull();
    expect(await db.select().from(schema.listings)).toHaveLength(0);
    expect(drivers[0]?.closed).toBe(true);

    const resumed = await discover(runId, [1, 2, 3, 4].map((n) => searchPage([fakeCard(n)])), makeClock());
    expect(resumed.result).toMatchObject({ searchesDone: 4, searchesRemaining: 0, stopped: null });
    expect((await runRow())?.status).toBe('running');
  });

  it('a success between failures resets the count: fail, ok, fail, ok, fail does not stop the run', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}, {}, {}, {}, {}]);
    const pages = [slow, slow, searchPage([fakeCard(1)]), slow, slow, searchPage([fakeCard(2)]), slow, slow];
    const { result } = await discover(runId, pages, makeClock());
    expect(result).toMatchObject({ searchesDone: 2, searchesRemaining: 3, stopped: null });
    expect((await runRow())?.status).toBe('running');
  });

  it('(d) a block page still stops the run at once, with no retry and no pause', async () => {
    const runId = await createRun(db);
    const [s1] = (await createSearches(db, runId, [{}, {}])) as [number, number];
    const clock = makeClock();
    const { result, drivers } = await discover(runId, [SORRY_PAGE, searchPage([fakeCard(1)])], clock);
    expect(result.stopped?.signal).toBe('sorry');
    expect(drivers.flatMap((d) => d.opened)).toHaveLength(1);
    expect(clock.sleeps).toHaveLength(0);
    expect((await searchRows()).find((r) => r.id === s1)).toMatchObject({ status: 'blocked', blockSignal: 'sorry' });
    expect((await runRow())?.status).toBe('blocked');
  });

  it('a block page that answers the retry stops the run as a block', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}]);
    const { result, drivers } = await discover(runId, [slow, SORRY_PAGE], makeClock());
    expect(result.stopped?.signal).toBe('sorry');
    expect(drivers.flatMap((d) => d.opened)).toHaveLength(2);
    expect((await runRow())?.status).toBe('blocked');
  });

  it('an error that is not a timeout or network error still ends the stage as before', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}]);
    const clock = makeClock();
    await expect(discover(runId, [{ kind: 'throw', error: new Error('browser crashed') }], clock)).rejects.toThrow('browser crashed');
    expect(clock.sleeps).toHaveLength(0);
  });
});

describe('detail: a slow place page is a retry, not a crash', () => {
  const placePage = (n: number): FixturePage => ({ kind: 'place', place: fakePlace(n), landedUrl: fakePlace(n).url });

  async function seed(cards: CardSnapshot[]): Promise<number> {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}]);
    const f = driverFactory([searchPage(cards)]);
    await createDiscoverStage({ driverFactory: f.make, rng: rng() }).run(makeCtx(db, runId, makeClock()), { runId });
    return runId;
  }

  async function detail(runId: number, pages: FixturePage[], clock: TestClock = makeClock()) {
    const f = driverFactory(pages);
    const stage = createDetailStage({ driverFactory: f.make, rng: rng() });
    const result = await stage.run(makeCtx(db, runId, clock, testConfig()), { runId });
    return { result, drivers: f.drivers, clock };
  }

  const listingRows = async () => await db.select().from(schema.listings).orderBy(schema.listings.id);

  it('(a) one timeout then success: the same place page is retried once after 30-60 s and the listing is done', async () => {
    const runId = await seed([fakeCard(1)]);
    const { result, drivers, clock } = await detail(runId, [slow, placePage(1)]);
    expect(result).toMatchObject({ done: 1, failed: 0, stopped: null });
    const opened = drivers.flatMap((d) => d.opened);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toBe(opened[0]);
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(30_000);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(60_000);
    expect((await listingRows())[0]?.detailStatus).toBe('done');
    expect((await runRow())?.status).toBe('running');
  });

  it('(b) two timeouts on one place page: that listing stays pending with its card data intact, the next one runs, the run is not failed', async () => {
    const runId = await seed([fakeCard(1), fakeCard(2)]);
    const before = await listingRows();
    const { result } = await detail(runId, [slow, slow, placePage(2)]);

    expect(result).toMatchObject({ done: 1, failed: 0, stopped: null });
    const rows = await listingRows();
    expect(rows[0]).toMatchObject({ detailStatus: 'pending', rating: before[0]?.rating, reviewCount: before[0]?.reviewCount });
    expect(rows[0]?.reviewCount).not.toBe(0);
    expect(rows[1]?.detailStatus).toBe('done');
    expect((await runRow())?.status).toBe('running');
    expect((await db.select().from(schema.requestLog)).filter((l) => l.note === 'place' && l.outcome === 'timeout')).toHaveLength(2);

    const resumed = await detail(runId, [placePage(1)]);
    expect(resumed.result).toMatchObject({ done: 1, stopped: null });
    expect((await listingRows())[0]?.detailStatus).toBe('done');
  });

  it('(c) three place pages in a row that fail twice stop the run like a daily cap, resumable', async () => {
    const runId = await seed([1, 2, 3, 4].map((n) => fakeCard(n)));
    const { result, drivers } = await detail(runId, [slow, slow, slow, slow, netDown(), slow, placePage(4)]);
    expect(result.stopped?.signal).toBe('daily_cap');
    expect(result.stopped?.detail).toMatch(/network/i);
    expect(drivers.flatMap((d) => d.opened)).toHaveLength(6);
    expect((await listingRows()).map((l) => l.detailStatus)).toEqual(['pending', 'pending', 'pending', 'pending']);
    const run = await runRow();
    expect(run?.status).toBe('stopped');
    expect(run?.stoppedReason).toMatch(/^daily_cap: /);

    const resumed = await detail(runId, [1, 2, 3, 4].map(placePage));
    expect(resumed.result).toMatchObject({ done: 4, stopped: null });
  });

  it('(d) a block page still stops the run at once, with no retry', async () => {
    const runId = await seed([fakeCard(1), fakeCard(2)]);
    const { result, drivers, clock } = await detail(runId, [SORRY_PAGE, placePage(2)]);
    expect(result.stopped?.signal).toBe('sorry');
    expect(drivers.flatMap((d) => d.opened)).toHaveLength(1);
    expect(clock.sleeps).toHaveLength(0);
    expect((await listingRows())[0]?.detailStatus).toBe('blocked');
    expect((await runRow())?.status).toBe('blocked');
  });
});
