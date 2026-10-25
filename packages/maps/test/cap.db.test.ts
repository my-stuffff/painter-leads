import { getTestDb, schema, truncateAll, type Db } from '@pp/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { remainingToday, requestsToday, startOfLocalDay } from '../src/cap';
import { collectStatus } from '../src/status';
import { createDetailStage } from '../src/detail';
import { createDiscoverStage } from '../src/discover';
import type { FixturePage } from '../src/driver/types';
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
  testConfig,
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

async function logRows(n: number, at: Date, over: Partial<typeof schema.requestLog.$inferInsert> = {}) {
  for (let i = 0; i < n; i++) {
    await db.insert(schema.requestLog).values({
      at,
      source: 'maps',
      host: 'www.google.com',
      method: 'GET',
      url: 'https://www.google.com/maps/search/x',
      outcome: 'ok',
      note: 'search',
      ...over,
    });
  }
}

describe('daily cap', () => {
  it('counts only today\'s maps rows of the same kind', async () => {
    const clock = makeClock();
    const now = clock.now();
    await logRows(3, now);
    await logRows(2, now, { note: 'place' });
    await logRows(4, new Date(startOfLocalDay(now).getTime() - 3600_000)); // yesterday
    await logRows(5, now, { source: 'websites', note: 'search' });
    await logRows(1, now, { note: 'dctest:laptop' });
    expect(await requestsToday(db, 'search', now)).toBe(3);
    expect(await requestsToday(db, 'place', now)).toBe(2);
    expect(await remainingToday(db, 'search', 150, now)).toBe(147);
    expect(await remainingToday(db, 'place', 2, now)).toBe(0);
    expect(await remainingToday(db, 'search', 2, now)).toBe(0);
  });

  it('discover stops with daily_cap before any navigation when today already holds the search cap', async () => {
    const clock = makeClock();
    const runId = await createRun(db);
    await createSearches(db, runId, [{}, {}]);
    await logRows(150, clock.now(), { runId });
    const f = driverFactory([searchPage([fakeCard(1)])]);
    const ctx = makeCtx(db, runId, clock, testConfig());
    expect(ctx.config.maps.dailyCap.searches).toBe(150);
    const result = await createDiscoverStage({ driverFactory: f.make, rng: rng() }).run(ctx, { runId });
    expect(result.stopped?.signal).toBe('daily_cap');
    expect(result).toMatchObject({ searchesDone: 0, searchesRemaining: 2 });
    expect(f.drivers).toHaveLength(0);
    expect(clock.sleeps).toEqual([]);
    const [run] = await db.select().from(schema.runs);
    expect(run).toMatchObject({ status: 'stopped' });
    expect(run?.stoppedReason).toMatch(/^daily_cap: /);
    const searches = await db.select().from(schema.searches);
    expect(searches.every((s) => s.status === 'pending')).toBe(true);
  });

  it('stops part-way through a run when the cap is reached, and finishes the rest the next day', async () => {
    const config = testConfig({ dailyCap: { searches: 2, placePages: 900 } });
    const clock = makeClock();
    const runId = await createRun(db);
    await createSearches(db, runId, [{}, {}, {}]);
    const pages: FixturePage[] = [1, 2, 3].map((n) => searchPage([fakeCard(n)]));
    const f = driverFactory(pages);
    const result = await createDiscoverStage({ driverFactory: f.make, rng: rng() }).run(makeCtx(db, runId, clock, config), { runId });
    expect(result).toMatchObject({ searchesDone: 2, searchesRemaining: 1 });
    expect(result.stopped?.signal).toBe('daily_cap');
    expect(f.drivers[0]?.opened).toHaveLength(2);
    expect(await requestsToday(db, 'search', clock.now())).toBe(2);

    clock.advanceMinutes(24 * 60);
    const f2 = driverFactory([searchPage([fakeCard(3)])]);
    const next = await createDiscoverStage({ driverFactory: f2.make, rng: rng() }).run(makeCtx(db, runId, clock, config), { runId });
    expect(next).toMatchObject({ searchesDone: 1, searchesRemaining: 0, stopped: null });
  });

  it('the detail stage stops the same way on the place-page cap', async () => {
    const clock = makeClock();
    const runId = await createRun(db);
    await createSearches(db, runId, [{}]);
    await createDiscoverStage({ driverFactory: driverFactory([searchPage([1, 2, 3].map((n) => fakeCard(n)))]).make, rng: rng() }).run(
      makeCtx(db, runId, clock),
      { runId },
    );
    const config = testConfig({ dailyCap: { searches: 150, placePages: 2 } });
    const f = driverFactory([1, 2, 3].map((n): FixturePage => ({ kind: 'place', place: fakePlace(n) })));
    const result = await createDetailStage({ driverFactory: f.make, rng: rng() }).run(makeCtx(db, runId, clock, config), { runId });
    expect(result).toMatchObject({ done: 2 });
    expect(result.stopped?.signal).toBe('daily_cap');
    expect(f.drivers[0]?.opened).toHaveLength(2);
    expect(await requestsToday(db, 'place', clock.now())).toBe(2);
  });
});

describe('maps status', () => {
  it('reports searches by status, listings by detail status, uncaptured counts, requests today vs caps and the last block', async () => {
    const clock = makeClock();
    const runId = await createRun(db);
    await createSearches(db, runId, [{}, {}]);
    const noStars = fakeCard(2, { ratingAria: null, text: 'Painter 2\nPainter 2\nNo reviews\nPainter' });
    const pages: FixturePage[] = [
      searchPage([fakeCard(1), noStars]),
      { kind: 'other', landedUrl: 'https://www.google.com/sorry/index', signals: {} },
    ];
    const f = driverFactory(pages);
    await createDiscoverStage({ driverFactory: f.make, rng: rng() }).run(makeCtx(db, runId, clock), { runId });

    const s = await collectStatus(db, runId, testConfig(), clock.now());
    expect(s).toMatchObject({
      runId,
      runStatus: 'blocked',
      searches: { done: 1, blocked: 1 },
      listingsByDetailStatus: { pending: 2 },
      nullRatingByStatus: { not_on_card: 1 },
      nullReviewCountByStatus: { not_on_card: 1 },
      requestsToday: { searches: 2, placePages: 0 },
      caps: { searches: 150, placePages: 900 },
      lastBlockSignal: 'sorry',
    });
    expect(s.stoppedReason).toMatch(/^sorry: /);
  });
});
