import { getTestDb, schema, truncateAll, type Db } from '@pp/core';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDetailStage } from '../src/detail';
import { createDiscoverStage } from '../src/discover';
import { FixtureDriver } from '../src/driver/fixture';
import type { CardSnapshot, FixturePage, PageDriver, PlaceSnapshot } from '../src/driver/types';
import {
  createRun,
  createSearches,
  driverFactory,
  fakeCard,
  fakePlace,
  limitedPlace,
  makeClock,
  makeCtx,
  readFixture,
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

const placePage = (place: PlaceSnapshot): FixturePage => ({ kind: 'place', place, landedUrl: place.url });

/** One finished discover search over `cards`, so the listings exist with detail_status pending. */
async function seed(cards: CardSnapshot[], clock: TestClock = makeClock()): Promise<number> {
  const runId = await createRun(db);
  await createSearches(db, runId, [{}]);
  const f = driverFactory([searchPage(cards)]);
  await createDiscoverStage({ driverFactory: f.make, rng: rng() }).run(makeCtx(db, runId, clock), { runId });
  return runId;
}

async function runDetail(
  runId: number,
  pages: FixturePage[],
  o: { clock?: TestClock; retryLimited?: boolean; limit?: number; config?: ReturnType<typeof testConfig> } = {},
) {
  const clock = o.clock ?? makeClock();
  const f = driverFactory(pages);
  const stage = createDetailStage({ driverFactory: f.make, rng: rng() });
  const result = await stage.run(makeCtx(db, runId, clock, o.config), {
    runId,
    ...(o.retryLimited ? { retryLimited: true } : {}),
    ...(o.limit !== undefined ? { limit: o.limit } : {}),
  });
  return { result, clock, drivers: f.drivers };
}

const listingByName = async (name: string) => {
  const [row] = await db.select().from(schema.listings).where(eq(schema.listings.name, name));
  if (!row) throw new Error(`no listing ${name}`);
  return row;
};

describe('detail: a complete place page', () => {
  it('fills every place field with evidence, stores the raw page and marks the listing done', async () => {
    const runId = await seed([fakeCard(1)]);
    const place = fakePlace(1);
    const { result, drivers } = await runDetail(runId, [placePage(place)]);
    expect(result).toEqual({ done: 1, limitedView: 0, failed: 0, stopped: null });
    expect(drivers[0]?.opened).toEqual([expect.stringMatching(/^https:\/\/www\.google\.com\/maps\?cid=\d+&hl=en&gl=us$/)]);
    expect(drivers[0]?.closed).toBe(true);

    const row = await listingByName('Painter 1');
    expect(row).toMatchObject({
      detailStatus: 'done',
      detailAttempts: 1,
      phoneE164: '+17325551001',
      websiteUrl: 'https://painter1.example.com/',
      addressFull: '1 Main St, Edison, NJ 08817-1234',
      street: '1 Main St',
      city: 'Edison',
      state: 'NJ',
      zip: '08817',
      addressStatus: 'captured',
      rating: 4.1,
      reviewCount: 101,
      categories: ['Painter'],
      permanentlyClosed: false,
      closedStatus: 'captured',
    });
    expect(row.placeRaw).toMatchObject({ h1: 'Painter 1' });
    expect(row.lastCheckedAt).toBeInstanceOf(Date);

    const ev = await db.select().from(schema.evidence).where(eq(schema.evidence.listingId, row.id));
    const placeEv = ev.filter((e) => e.extractor === 'maps/place');
    const byField = new Map(placeEv.map((e) => [e.field, e]));
    for (const f of ['company_name', 'phone', 'website', 'address', 'street', 'city', 'state', 'zip', 'rating', 'review_count', 'category', 'permanently_closed']) {
      expect(byField.has(f), f).toBe(true);
    }
    expect(byField.get('rating')).toMatchObject({ value: '4.1', snippet: '4.1 stars', sourceType: 'google_maps', confidence: 'high', sourceUrl: row.profileUrl });
    expect(byField.get('address')?.snippet).toBe('Address: 1 Main St, Edison, NJ 08817-1234');
    expect(byField.get('phone')?.snippet).toBe('Phone: (732) 555-1001');
    expect(byField.get('zip')?.value).toBe('08817');
    const log = await db.select().from(schema.requestLog).orderBy(asc(schema.requestLog.id));
    expect(log.map((l) => l.note)).toEqual(['search', 'place']);
    expect(log[1]).toMatchObject({ outcome: 'ok', source: 'maps' });
  });

  it('a place page overwrites the card value (a re-seen card does not overwrite it back)', async () => {
    const clock = makeClock();
    const runId = await seed([fakeCard(1)], clock);
    await runDetail(runId, [placePage(fakePlace(1, { reviewCountAria: '999 reviews', ratingAria: '5.0 stars ' }))], { clock });
    expect(await listingByName('Painter 1')).toMatchObject({ rating: 5, reviewCount: 999 });

    // Same listing shows up in another search with the old card numbers.
    const [second] = await createSearches(db, runId, [{ zip: '08820', position: 2 }]);
    const f = driverFactory([searchPage([fakeCard(1)])]);
    await createDiscoverStage({ driverFactory: f.make, rng: rng() }).run(makeCtx(db, runId, clock), { runId });
    expect(second).toBeDefined();
    expect(await listingByName('Painter 1')).toMatchObject({ rating: 5, reviewCount: 999, detailStatus: 'done' });
  });

  it('a service-area business (no address button) keeps address NULL with not_shown and the coordinates from the card', async () => {
    const runId = await seed([fakeCard(2)]);
    await runDetail(runId, [placePage(fakePlace(2, { addressAria: null }))]);
    const row = await listingByName('Painter 2');
    expect(row).toMatchObject({
      addressFull: null,
      addressStatus: 'not_shown',
      city: null,
      zip: null,
      detailStatus: 'done',
      coordsStatus: 'captured',
    });
    expect(row.lat).toBeCloseTo(40.5002, 4);
    const ev = await db.select().from(schema.evidence).where(eq(schema.evidence.listingId, row.id));
    expect(ev.some((e) => e.field === 'address' && e.extractor === 'maps/place')).toBe(false);
  });

  it('a complete page whose body text says "limited view" is done, not limited and not blocked', async () => {
    const runId = await seed([fakeCard(3)]);
    const fx = readFixture<Extract<FixturePage, { kind: 'place' }>>('derived-normal-page-mentions-limited-view.json');
    const { result } = await runDetail(runId, [placePage({ ...fx.place, url: fakeCard(3).href })]);
    expect(result).toMatchObject({ done: 1, limitedView: 0, stopped: null });
    const [row] = await db.select().from(schema.listings);
    expect(row).toMatchObject({ detailStatus: 'done', ratingStatus: 'captured', reviewCountStatus: 'captured' });
    // The place heading is the name Google shows for the business, so it replaces the card name.
    expect(row?.name).toBe('CertaPro Painters of Edison, NJ');
  });

  it('marks a page with no name heading failed instead of guessing', async () => {
    const runId = await seed([fakeCard(4)]);
    const { result } = await runDetail(runId, [placePage({ ...fakePlace(4), h1: null })]);
    expect(result).toMatchObject({ done: 0, failed: 1, stopped: null });
    expect(await listingByName('Painter 4')).toMatchObject({ detailStatus: 'failed', detailAttempts: 1 });
    expect((await db.select().from(schema.requestLog).orderBy(asc(schema.requestLog.id)))[1]?.outcome).toBe('http_error');
  });

  it('opens only listings this run reached, and respects --limit', async () => {
    const runId = await seed([1, 2, 3].map((n) => fakeCard(n)));
    const otherRun = await createRun(db);
    await createSearches(db, otherRun, [{ zip: '99999' }]);
    await createDiscoverStage({ driverFactory: driverFactory([searchPage([fakeCard(50)])]).make, rng: rng() }).run(
      makeCtx(db, otherRun, makeClock()),
      { runId: otherRun },
    );
    const { result, drivers } = await runDetail(runId, [1, 2, 3].map((n) => placePage(fakePlace(n))), { limit: 2 });
    expect(result.done).toBe(2);
    expect(drivers[0]?.opened).toHaveLength(2);
    expect((await listingByName('Painter 3')).detailStatus).toBe('pending');
    expect((await listingByName('Painter 50')).detailStatus).toBe('pending');
  });

  it('pauses 4 to 8 seconds between place pages and not after the last', async () => {
    const runId = await seed([1, 2, 3].map((n) => fakeCard(n)));
    const clock = makeClock();
    await runDetail(runId, [1, 2, 3].map((n) => placePage(fakePlace(n))), { clock });
    expect(clock.sleeps).toHaveLength(2);
    for (const s of clock.sleeps) {
      expect(s).toBeGreaterThanOrEqual(4000);
      expect(s).toBeLessThanOrEqual(8000);
    }
  });
});

describe('detail: limited view', () => {
  it('stores rating and review count as NULL with limited_view, and the database refuses a 0', async () => {
    const runId = await seed([fakeCard(5, { ratingAria: null, text: 'Painter 5\nPainter 5\nNo reviews\nPainter · 5 Main St' })]);
    const { result } = await runDetail(runId, [placePage(limitedPlace(5))]);
    expect(result).toMatchObject({ done: 0, limitedView: 1, stopped: null });
    const row = await listingByName('Painter 5');
    expect(row).toMatchObject({
      rating: null,
      reviewCount: null,
      ratingStatus: 'limited_view',
      reviewCountStatus: 'limited_view',
      detailStatus: 'limited_view',
      detailAttempts: 1,
    });
    // The rest of the limited page is still captured.
    expect(row).toMatchObject({ phoneStatus: 'captured', addressStatus: 'captured' });
    expect((await db.select().from(schema.requestLog).orderBy(asc(schema.requestLog.id)))[1]?.outcome).toBe('limited_view');

    await expect(
      db.execute(sql`update listings set rating = 0, review_count = 0 where id = ${row.id}`),
    ).rejects.toThrow();
    const ev = await db.select().from(schema.evidence).where(eq(schema.evidence.listingId, row.id));
    expect(ev.some((e) => e.extractor === 'maps/place' && (e.field === 'rating' || e.field === 'review_count'))).toBe(false);
  });

  it('keeps a rating the card really showed when the place page is limited', async () => {
    const runId = await seed([fakeCard(6)]);
    await runDetail(runId, [placePage(limitedPlace(6))]);
    expect(await listingByName('Painter 6')).toMatchObject({
      rating: 4.6,
      reviewCount: 106,
      ratingStatus: 'captured',
      detailStatus: 'limited_view',
    });
  });

  it('retries a limited-view listing only with retryLimited, then completes it', async () => {
    const runId = await seed([fakeCard(7, { ratingAria: null, text: 'Painter 7\nPainter 7\nNo reviews\nPainter' })]);
    await runDetail(runId, [placePage(limitedPlace(7))]);

    const skipped = await runDetail(runId, [placePage(fakePlace(7))]);
    expect(skipped.drivers).toHaveLength(0);
    expect(skipped.result).toEqual({ done: 0, limitedView: 0, failed: 0, stopped: null });
    expect((await listingByName('Painter 7')).detailStatus).toBe('limited_view');

    const retried = await runDetail(runId, [placePage(fakePlace(7))], { retryLimited: true });
    expect(retried.result).toMatchObject({ done: 1, limitedView: 0 });
    expect(await listingByName('Painter 7')).toMatchObject({
      detailStatus: 'done',
      detailAttempts: 2,
      rating: 4.7,
      ratingStatus: 'captured',
      reviewCount: 107,
    });
  });

  it('gives up retrying after three attempts', async () => {
    const runId = await seed([fakeCard(8, { ratingAria: null, text: 'Painter 8\nPainter 8\nNo reviews\nPainter' })]);
    for (let i = 0; i < 3; i++) await runDetail(runId, [placePage(limitedPlace(8))], { retryLimited: true });
    expect((await listingByName('Painter 8')).detailAttempts).toBe(3);
    const again = await runDetail(runId, [placePage(limitedPlace(8))], { retryLimited: true });
    expect(again.drivers).toHaveLength(0);
  });

  it('five limited views in a row stop the run with limited_view_streak', async () => {
    const cards = [1, 2, 3, 4, 5, 6, 7].map((n) => fakeCard(n));
    const runId = await seed(cards);
    const { result, drivers } = await runDetail(runId, cards.map((_, i) => placePage(limitedPlace(i + 1))));
    expect(result.limitedView).toBe(5);
    expect(result.stopped?.signal).toBe('limited_view_streak');
    expect(drivers[0]?.opened).toHaveLength(5);
    const [run] = await db.select().from(schema.runs);
    expect(run?.status).toBe('blocked');
    expect(run?.stoppedReason).toMatch(/^limited_view_streak: /);
    expect((await listingByName('Painter 6')).detailStatus).toBe('pending');
  });

  it('a complete page in between resets the streak', async () => {
    const cards = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => fakeCard(n));
    const runId = await seed(cards);
    const pages = [1, 2, 3, 4].map((n) => placePage(limitedPlace(n)));
    pages.push(placePage(fakePlace(5)));
    for (const n of [6, 7, 8]) pages.push(placePage(limitedPlace(n)));
    const { result } = await runDetail(runId, pages);
    expect(result).toMatchObject({ done: 1, limitedView: 7, stopped: null });
  });
});

describe('detail: blocks, back-off and the daily cap', () => {
  it('stops on a /sorry/ page, marks the listing blocked, and backs off until the clock allows a retry', async () => {
    const runId = await seed([1, 2].map((n) => fakeCard(n)));
    const clock = makeClock();
    const first = await runDetail(runId, [SORRY_PAGE, placePage(fakePlace(2))], { clock });
    expect(first.result.stopped?.signal).toBe('sorry');
    expect(first.drivers[0]?.opened).toHaveLength(1);
    expect((await listingByName('Painter 1')).detailStatus).toBe('blocked');
    expect((await listingByName('Painter 2')).detailStatus).toBe('pending');
    const [run] = await db.select().from(schema.runs);
    expect(run).toMatchObject({ status: 'blocked' });
    expect((await db.select().from(schema.requestLog).orderBy(asc(schema.requestLog.id)))[1]?.outcome).toBe('sorry');

    // Immediately again: returns the recorded signal without opening a page.
    clock.advanceMinutes(10);
    const early = await runDetail(runId, [placePage(fakePlace(1))], { clock });
    expect(early.drivers).toHaveLength(0);
    expect(early.result.stopped).toMatchObject({ signal: 'sorry' });

    // After the back-off: the blocked listing and the rest are processed.
    clock.advanceMinutes(60);
    const later = await runDetail(runId, [placePage(fakePlace(1)), placePage(fakePlace(2))], { clock });
    expect(later.result).toMatchObject({ done: 2, stopped: null });
    const [after] = await db.select().from(schema.runs);
    expect(after).toMatchObject({ status: 'running', stoppedReason: null });
  });

  it('stops with daily_cap before any navigation once today holds the place-page cap', async () => {
    const config = testConfig({ dailyCap: { searches: 150, placePages: 2 } });
    const clock = makeClock();
    const runId = await seed([1, 2, 3].map((n) => fakeCard(n)), clock);
    for (let i = 0; i < 2; i++) {
      await db.insert(schema.requestLog).values({
        at: clock.now(),
        source: 'maps',
        host: 'www.google.com',
        method: 'GET',
        url: 'https://www.google.com/maps?cid=1',
        outcome: 'ok',
        runId,
        note: 'place',
      });
    }
    const { result, drivers } = await runDetail(runId, [1, 2, 3].map((n) => placePage(fakePlace(n))), { clock, config });
    expect(result.stopped?.signal).toBe('daily_cap');
    expect(result.done).toBe(0);
    expect(drivers.flatMap((d) => d.opened)).toHaveLength(0);
    const [run] = await db.select().from(schema.runs);
    expect(run?.status).toBe('stopped');
  });
});

/** The decimal cid Google Maps puts in `?cid=` for a fake card's place. */
const cidOf = (n: number): string => BigInt(`0x2452b5fb1a89${n.toString(16).padStart(4, '0')}`).toString();

/** Drivers that serve each page by the cid in the opened URL, so the order workers open pages in does not matter. */
function byCidFactory(pages: Map<string, FixturePage>) {
  const drivers: { opened: string[]; closed: boolean }[] = [];
  const make = async (): Promise<PageDriver> => {
    const log = { opened: [] as string[], closed: false };
    drivers.push(log);
    let current = new FixtureDriver([]);
    return {
      async open(url) {
        log.opened.push(url);
        const page = pages.get(/cid=(\d+)/.exec(url)?.[1] ?? '');
        if (!page) throw new Error(`no page for ${url}`);
        current = new FixtureDriver([page]);
        return current.open(url);
      },
      scrollFeed: () => current.scrollFeed(),
      snapshotCards: () => current.snapshotCards(),
      snapshotPlace: () => current.snapshotPlace(),
      pageSignals: () => current.pageSignals(),
      async close() {
        log.closed = true;
      },
    };
  };
  return { make, drivers };
}

const placesFor = (ns: number[]) => new Map(ns.map((n) => [cidOf(n), placePage(fakePlace(n))]));

describe('detail: several place pages at once (maps.placeConcurrency)', () => {
  it('opens every listing exactly once across the workers and closes every driver', async () => {
    const ns = [1, 2, 3, 4, 5, 6, 7];
    const runId = await seed(ns.map((n) => fakeCard(n)));
    const f = byCidFactory(placesFor(ns));
    const stage = createDetailStage({ driverFactory: f.make, rng: rng() });
    const result = await stage.run(makeCtx(db, runId, makeClock(), testConfig({ placeConcurrency: 3 })), { runId });

    expect(result).toEqual({ done: 7, limitedView: 0, failed: 0, stopped: null });
    expect(f.drivers).toHaveLength(3);
    expect(f.drivers.every((d) => d.closed)).toBe(true);
    const opened = f.drivers.flatMap((d) => d.opened);
    expect(opened).toHaveLength(7);
    expect(new Set(opened).size).toBe(7);
    const rows = await db.select().from(schema.listings).orderBy(asc(schema.listings.id));
    expect(rows.map((r) => r.detailStatus)).toEqual(Array(7).fill('done'));
  });

  it('a block seen by one worker stops them all and leaves the rest pending', async () => {
    const ns = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const runId = await seed(ns.map((n) => fakeCard(n)));
    const pages = placesFor(ns);
    pages.set(cidOf(2), SORRY_PAGE);
    const f = byCidFactory(pages);
    const stage = createDetailStage({ driverFactory: f.make, rng: rng() });
    const result = await stage.run(makeCtx(db, runId, makeClock(), testConfig({ placeConcurrency: 3 })), { runId });

    expect(result.stopped).not.toBeNull();
    expect(f.drivers.every((d) => d.closed)).toBe(true);
    expect(f.drivers.flatMap((d) => d.opened).length).toBeLessThan(ns.length);
    expect((await listingByName('Painter 2')).detailStatus).toBe('blocked');
    const pending = await db.select().from(schema.listings).where(eq(schema.listings.detailStatus, 'pending'));
    expect(pending.length).toBeGreaterThan(0);
  });
});
