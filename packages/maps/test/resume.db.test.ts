import { getTestDb, schema, truncateAll, type Db } from '@pp/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDiscoverStage } from '../src/discover';
import type { FixturePage } from '../src/driver/types';
import {
  createRun,
  createSearches,
  driverFactory,
  fakeCard,
  makeClock,
  makeCtx,
  rng,
  searchPage,
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

async function discover(runId: number, pages: FixturePage[], clock: TestClock) {
  const f = driverFactory(pages);
  const stage = createDiscoverStage({ driverFactory: f.make, rng: rng() });
  const promise = stage.run(makeCtx(db, runId, clock, testConfig()), { runId });
  return { promise, drivers: f.drivers };
}

describe('discover resume (DISC-04)', () => {
  it('after a crash on search 2 it skips search 1, completes 2 and 3, and never duplicates a listing', async () => {
    const runId = await createRun(db);
    const [s1, s2, s3] = (await createSearches(db, runId, [{ zip: '08817' }, { zip: '08820' }, { zip: '08837' }])) as [number, number, number];
    const clock = makeClock();
    const shared = fakeCard(1);

    const crash = await discover(runId, [searchPage([shared, fakeCard(2)]), { kind: 'throw', error: new Error('browser crashed') }], clock);
    await expect(crash.promise).rejects.toThrow('browser crashed');
    const rows = async () => new Map((await db.select().from(schema.searches)).map((r) => [r.id, r]));
    expect((await rows()).get(s1)?.status).toBe('done');
    expect((await rows()).get(s2)).toMatchObject({ status: 'running', attempts: 1 });
    expect((await rows()).get(s3)?.status).toBe('pending');
    expect(crash.drivers[0]?.closed).toBe(true);

    const log = await db.select().from(schema.requestLog);
    expect(log.map((l) => l.outcome).sort()).toEqual(['http_error', 'ok']);

    const resumedClock = makeClock();
    const resume = await discover(runId, [searchPage([fakeCard(3)]), searchPage([shared, fakeCard(4)])], resumedClock);
    const result = await resume.promise;

    expect(result).toMatchObject({ searchesDone: 2, searchesRemaining: 0, cardsSeen: 3, newListings: 2, stopped: null });
    const opened = resume.drivers.flatMap((d) => d.opened);
    expect(opened).toHaveLength(2);
    expect(opened[0]).toContain('08820');
    expect(opened[1]).toContain('08837');
    expect(opened.some((u) => u.includes('08817'))).toBe(false);
    expect((await rows()).get(s2)).toMatchObject({ status: 'done', attempts: 2 });
    expect((await rows()).get(s3)).toMatchObject({ status: 'done', attempts: 1 });

    expect(await db.select().from(schema.listings)).toHaveLength(4);
    const sharedRow = (await db.select().from(schema.listings).where(eq(schema.listings.name, 'Painter 1')))[0];
    const hits = await db.select().from(schema.searchHits).where(eq(schema.searchHits.listingId, sharedRow?.id as number));
    expect(hits).toHaveLength(2);
    const bySearch = new Map(hits.map((h) => [h.searchId, h]));
    expect(bySearch.get(s1)?.isNew).toBe(true);
    expect(bySearch.get(s3)?.isNew).toBe(false);
    expect((await rows()).get(s3)).toMatchObject({ cardsFound: 2, newPlaceIds: 1 });
    expect((await db.select().from(schema.runs))[0]?.status).toBe('running');
  });

  it('a search left running after a crash between "listing stored" and "search done" re-runs without duplicating rows', async () => {
    const runId = await createRun(db);
    const [s1] = (await createSearches(db, runId, [{}])) as [number];
    const clock = makeClock();
    const cards = [1, 2, 3].map((n) => fakeCard(n));
    await (await discover(runId, [searchPage(cards)], clock)).promise;
    const counts = async () => ({
      listings: (await db.select().from(schema.listings)).length,
      hits: (await db.select().from(schema.searchHits)).length,
      evidence: (await db.select().from(schema.evidence)).length,
    });
    const before = await counts();
    expect(before.listings).toBe(3);

    await db.update(schema.searches).set({ status: 'running', finishedAt: null }).where(eq(schema.searches.id, s1));
    const again = await (await discover(runId, [searchPage(cards)], clock)).promise;
    expect(again.searchesDone).toBe(1);
    expect(await counts()).toEqual(before);
    expect((await db.select().from(schema.searches))[0]).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('records a changed rating as new evidence on a re-read (the old row stays)', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}]);
    const clock = makeClock();
    await (await discover(runId, [searchPage([fakeCard(1)])], clock)).promise;
    await db.update(schema.searches).set({ status: 'pending' });
    await (await discover(runId, [searchPage([fakeCard(1, { ratingAria: '4.9 stars 500 Reviews', text: 'Painter 1\nPainter 1\n4.9(500)\nPainter · 1 Main St\nOpen · Closes 5 PM · (732) 555-1001' })])], clock)).promise;
    const ev = await db.select().from(schema.evidence).where(eq(schema.evidence.field, 'review_count'));
    expect(ev.map((e) => e.value).sort()).toEqual(['101', '500']);
    expect((await db.select().from(schema.listings))[0]).toMatchObject({ rating: 4.9, reviewCount: 500 });
  });
});

describe('discover back-off after a block', () => {
  it('returns the recorded signal without opening anything until blockBackoffMinutes have passed, then retries', async () => {
    const clock = makeClock();
    const runId = await createRun(db, { status: 'blocked', stoppedReason: 'captcha: search blocked', finishedAt: clock.now() });
    const [blocked, next] = (await createSearches(db, runId, [
      { status: 'blocked', blockSignal: 'captcha', finishedAt: clock.now() },
      {},
    ])) as [number, number];

    clock.advanceMinutes(30);
    const early = await discover(runId, [searchPage([fakeCard(1)])], clock);
    const earlyResult = await early.promise;
    expect(early.drivers).toHaveLength(0);
    expect(earlyResult.stopped).toMatchObject({ signal: 'captcha', searchId: blocked });
    expect(earlyResult).toMatchObject({ searchesDone: 0, searchesRemaining: 2 });
    expect((await db.select().from(schema.runs))[0]?.status).toBe('blocked');
    expect((await db.select().from(schema.searches).where(eq(schema.searches.id, blocked)))[0]?.status).toBe('blocked');

    clock.advanceMinutes(31); // 61 minutes since the block; the config back-off is 60
    const later = await discover(runId, [searchPage([fakeCard(1)]), searchPage([fakeCard(2)])], clock);
    const laterResult = await later.promise;
    expect(laterResult).toMatchObject({ searchesDone: 2, searchesRemaining: 0, stopped: null });
    const rows = new Map((await db.select().from(schema.searches)).map((r) => [r.id, r]));
    expect(rows.get(blocked)).toMatchObject({ status: 'done', blockSignal: null, attempts: 1 });
    expect(rows.get(next)?.status).toBe('done');
    expect((await db.select().from(schema.runs))[0]).toMatchObject({ status: 'running', stoppedReason: null });
  });

  it('a search that is blocked again after the retry stops the run again and keeps the new finish time', async () => {
    const clock = makeClock();
    const runId = await createRun(db);
    await createSearches(db, runId, [{ status: 'blocked', blockSignal: 'sorry', finishedAt: new Date(clock.now().getTime() - 2 * 3600_000) }]);
    const page: FixturePage = { kind: 'other', landedUrl: 'https://www.google.com/sorry/index', signals: {} };
    const r = await (await discover(runId, [page], clock)).promise;
    expect(r.stopped?.signal).toBe('sorry');
    const [search] = await db.select().from(schema.searches);
    expect(search?.finishedAt?.getTime()).toBe(clock.now().getTime());
    // Back off again straight away.
    const again = await discover(runId, [searchPage([fakeCard(1)])], clock);
    expect(again.drivers).toHaveLength(0);
    expect((await again.promise).stopped?.signal).toBe('sorry');
  });
});

describe('discover pacing', () => {
  it('sleeps 10 to 20 seconds between searches and not after the last', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}, {}, {}, {}]);
    const clock = makeClock();
    await (await discover(runId, [1, 2, 3, 4].map((n) => searchPage([fakeCard(n)])), clock)).promise;
    expect(clock.sleeps).toHaveLength(3);
    for (const s of clock.sleeps) {
      expect(s).toBeGreaterThanOrEqual(10000);
      expect(s).toBeLessThanOrEqual(20000);
    }
  });

  it('processes searches in position order (term-major order from the planner)', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [
      { zip: '08820', term: 'interior painter', position: 3 },
      { zip: '08817', term: 'house painter', position: 1 },
      { zip: '08837', term: 'house painter', position: 2 },
    ]);
    const clock = makeClock();
    const d = await discover(runId, [1, 2, 3].map((n) => searchPage([fakeCard(n)])), clock);
    await d.promise;
    const urls = d.drivers.flatMap((x) => x.opened);
    expect(urls.map((u) => /(\d{5})/.exec(decodeURIComponent(u))?.[1])).toEqual(['08817', '08837', '08820']);
  });
});
