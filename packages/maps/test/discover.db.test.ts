import { getTestDb, schema, truncateAll, type Db } from '@pp/core';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDiscoverStage } from '../src/discover';
import type { FixturePage } from '../src/driver/types';
import { parseCard } from '../src/parse/card';
import {
  createRun,
  createSearches,
  driverFactory,
  fakeCard,
  fakePlace,
  makeClock,
  makeCtx,
  readFixture,
  rng,
  sdCards,
  searchPage,
  SORRY_PAGE,
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

async function runDiscover(runId: number, pages: FixturePage[], opts: { clock?: ReturnType<typeof makeClock> } = {}) {
  const clock = opts.clock ?? makeClock();
  const f = driverFactory(pages);
  const stage = createDiscoverStage({ driverFactory: f.make, rng: rng() });
  const result = await stage.run(makeCtx(db, runId, clock), { runId });
  return { result, clock, drivers: f.drivers };
}

describe('discover: one search from a recorded snapshot', () => {
  it('stores listings, search_hits and evidence for the 82 San Diego cards', async () => {
    const runId = await createRun(db);
    const [searchId] = await createSearches(db, runId, [{ zip: '08817' }]);
    const cards = sdCards();
    const { result, drivers } = await runDiscover(runId, [searchPage(cards, { landedUrl: 'https://www.google.com/maps/search/x/@1,2,13z' })]);

    const expectedIds = new Set(cards.map((c) => parseCard(c).placeId));
    expect(result).toMatchObject({ searchesDone: 1, searchesRemaining: 0, cardsSeen: 82, newListings: expectedIds.size, stopped: null });
    expect(drivers[0]?.closed).toBe(true);

    const listings = await db.select().from(schema.listings);
    expect(listings).toHaveLength(expectedIds.size);
    const hits = await db.select().from(schema.searchHits).where(eq(schema.searchHits.searchId, searchId as number));
    expect(hits).toHaveLength(expectedIds.size);
    expect(Math.min(...hits.map((h) => h.position))).toBe(1);
    expect(hits.every((h) => h.isNew)).toBe(true);

    const [search] = await db.select().from(schema.searches).where(eq(schema.searches.id, searchId as number));
    expect(search).toMatchObject({
      status: 'done',
      cardsFound: 82,
      newPlaceIds: expectedIds.size,
      endReached: true,
      attempts: 1,
      landedUrl: 'https://www.google.com/maps/search/x/@1,2,13z',
    });
    expect(search?.query).toBe('house painter 08817');
    expect(search?.url).toContain('https://www.google.com/maps/search/house%20painter%2008817/');
    expect(search?.startedAt).toBeInstanceOf(Date);
    expect(search?.finishedAt).toBeInstanceOf(Date);

    const log = await db.select().from(schema.requestLog);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ source: 'maps', host: 'www.google.com', outcome: 'ok', note: 'search', runId });
  });

  it('replays the live smoke search (116 cards) with website links and provenance on every value', async () => {
    const smoke = readFixture<Extract<FixturePage, { kind: 'search' }>>('smoke-1-search.json');
    const runId = await createRun(db);
    await createSearches(db, runId, [{ zip: '08817' }]);
    const { result } = await runDiscover(runId, [smoke as FixturePage]);
    const unique = new Set(smoke.cards.map((c) => parseCard(c).placeId));
    expect(result).toMatchObject({ cardsSeen: 116, newListings: unique.size, stopped: null });

    const [certapro] = await db.select().from(schema.listings).where(eq(schema.listings.name, 'CertaPro Painters of Edison, NJ'));
    expect(certapro).toMatchObject({ rating: 4.6, reviewCount: 224, phoneE164: '+17322046020', websiteStatus: 'captured' });
    expect(certapro?.websiteUrl).toContain('https://certapro.com/edison/');
    const ev = await db.select().from(schema.evidence).where(eq(schema.evidence.listingId, certapro?.id as number));
    expect(ev.find((e) => e.field === 'website')).toMatchObject({ extractor: 'maps/card', sourceType: 'google_maps' });

    const withoutEvidence = await db.execute(
      sql`select count(*)::int as n from listings l where not exists (select 1 from evidence e where e.listing_id = l.id and e.field = 'company_name')`,
    );
    expect((withoutEvidence.rows[0] as { n: number }).n).toBe(0);
  });

  it('gives every captured card value an evidence row with its source, snippet and extractor', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}]);
    await runDiscover(runId, [searchPage(sdCards())]);

    const [lifetime] = await db.select().from(schema.listings).where(eq(schema.listings.name, 'Lifetime Custom Painting Inc'));
    expect(lifetime).toMatchObject({
      rating: 4.9,
      reviewCount: 306,
      phoneE164: '+16193148622',
      street: '3601 30th St',
      categories: ['Painter'],
      ratingStatus: 'captured',
      reviewCountStatus: 'captured',
      phoneStatus: 'captured',
      coordsStatus: 'captured',
      detailStatus: 'pending',
    });
    expect(lifetime?.profileUrl).toMatch(/^https:\/\/www\.google\.com\/maps\?cid=\d+$/);
    expect(lifetime?.cardRaw).toMatchObject({ name: 'Lifetime Custom Painting Inc' });

    const ev = await db.select().from(schema.evidence).where(eq(schema.evidence.listingId, lifetime?.id as number));
    const byField = new Map(ev.map((e) => [e.field, e]));
    for (const field of ['company_name', 'place_id', 'cid', 'lat', 'lng', 'category', 'street', 'rating', 'review_count', 'phone', 'permanently_closed']) {
      expect(byField.has(field), field).toBe(true);
    }
    expect(byField.get('rating')).toMatchObject({
      value: '4.9',
      sourceType: 'google_maps',
      sourceUrl: lifetime?.profileUrl,
      snippet: '4.9 stars 306 Reviews',
      extractor: 'maps/card',
      confidence: 'high',
      status: 'accepted',
    });
    expect(byField.get('phone')?.snippet).toContain('(619) 314-8622');
    expect(byField.get('phone')?.value).toBe('+16193148622');
    expect(byField.get('place_id')?.snippet).toContain('!19sChIJ');
    expect(ev.every((e) => e.extractorVersion.length > 0 && e.capturedAt instanceof Date && e.snippet.length > 0)).toBe(true);
  });

  it('stores the card without a star label as NULL with not_on_card, never 0', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}]);
    await runDiscover(runId, [searchPage(sdCards())]);

    const [row] = await db.select().from(schema.listings).where(eq(schema.listings.name, 'Local San Diego Painters'));
    expect(row).toMatchObject({ rating: null, reviewCount: null, ratingStatus: 'not_on_card', reviewCountStatus: 'not_on_card' });
    const nulls = await db
      .select()
      .from(schema.listings)
      .where(and(isNull(schema.listings.rating), eq(schema.listings.ratingStatus, 'not_on_card')));
    expect(nulls).toHaveLength(1);
    const ev = await db.select().from(schema.evidence).where(eq(schema.evidence.listingId, row?.id as number));
    expect(ev.some((e) => e.field === 'rating' || e.field === 'review_count')).toBe(false);
  });

  it('keeps names as shown in NFC and the same place id twice in one feed as one listing', async () => {
    const runId = await createRun(db);
    const [searchId] = await createSearches(db, runId, [{}]);
    const accent = fakeCard(1, { name: 'José Pintura' });
    const { result } = await runDiscover(runId, [searchPage([accent, fakeCard(2), fakeCard(2)])]);
    expect(result.cardsSeen).toBe(3);
    const rows = await db.select().from(schema.listings);
    expect(rows.map((r) => r.name).sort()).toEqual(['José Pintura', 'Painter 2']);
    const hits = await db.select().from(schema.searchHits).where(eq(schema.searchHits.searchId, searchId as number));
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.position).sort()).toEqual([1, 2]);
    const [search] = await db.select().from(schema.searches);
    expect(search).toMatchObject({ cardsFound: 3, newPlaceIds: 2 });
  });

  it('records a feed that stops at the 120-card cap with end_reached false, and one that shows the end text as true', async () => {
    const runId = await createRun(db);
    const [capId, endId] = await createSearches(db, runId, [{}, {}]);
    const cap = Array.from({ length: 120 }, (_, i) => fakeCard(i + 1));
    const short = Array.from({ length: 7 }, (_, i) => fakeCard(1000 + i));
    await runDiscover(runId, [searchPage(cap, { endReached: false }), searchPage(short, { endReached: true })]);
    const rows = await db.select().from(schema.searches);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(capId as number)).toMatchObject({ cardsFound: 120, endReached: false, status: 'done' });
    expect(byId.get(endId as number)).toMatchObject({ cardsFound: 7, endReached: true, status: 'done' });
  });

  it('records a search with zero cards as done with cards_found 0 (not an error, not a block)', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}]);
    const { result } = await runDiscover(runId, [searchPage([], { endReached: false })]);
    expect(result).toMatchObject({ searchesDone: 1, cardsSeen: 0, newListings: 0, stopped: null });
    const [search] = await db.select().from(schema.searches);
    expect(search).toMatchObject({ status: 'done', cardsFound: 0, endReached: false, blockSignal: null });
    const [run] = await db.select().from(schema.runs);
    expect(run?.status).toBe('running');
  });

  it('parses a search that lands directly on one place page as one listing', async () => {
    const runId = await createRun(db);
    const [searchId] = await createSearches(db, runId, [{}]);
    const place = fakePlace(5);
    const { result } = await runDiscover(runId, [{ kind: 'place', place, landedUrl: place.url }]);
    expect(result).toMatchObject({ searchesDone: 1, cardsSeen: 1, newListings: 1 });
    const rows = await db.select().from(schema.listings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Painter 5',
      phoneE164: '+17325551005',
      addressStatus: 'captured',
      city: 'Edison',
      zip: '08817',
      detailStatus: 'done',
    });
    const hits = await db.select().from(schema.searchHits).where(eq(schema.searchHits.searchId, searchId as number));
    expect(hits).toMatchObject([{ position: 1, isNew: true }]);
    const [search] = await db.select().from(schema.searches);
    expect(search).toMatchObject({ status: 'done', cardsFound: 1 });
  });

  it('marks a page with no feed, no place panel and no block as failed', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}]);
    const { result } = await runDiscover(runId, [{ kind: 'other', landedUrl: 'https://www.google.com/maps/search/x', signals: {} }]);
    expect(result.stopped).toBeNull();
    const [search] = await db.select().from(schema.searches);
    expect(search?.status).toBe('failed');
    const log = await db.select().from(schema.requestLog);
    expect(log[0]?.outcome).toBe('http_error');
  });

  it('stops after three pages in a row with no feed and no place panel', async () => {
    const runId = await createRun(db);
    await createSearches(db, runId, [{}, {}, {}, {}]);
    const page: FixturePage = { kind: 'other', signals: {} };
    const { result, drivers } = await runDiscover(runId, [page, page, page, searchPage([fakeCard(1)])]);
    expect(result.stopped?.signal).toBe('unusual_traffic');
    expect(drivers[0]?.opened).toHaveLength(3);
    const [run] = await db.select().from(schema.runs);
    expect(run?.status).toBe('blocked');
  });
});

describe('discover: block handling', () => {
  it('stops on a /sorry/ redirect: search blocked, run blocked, nothing further requested', async () => {
    const runId = await createRun(db);
    const [first, second] = await createSearches(db, runId, [{}, {}]);
    const clock = makeClock();
    const { result, drivers } = await runDiscover(runId, [SORRY_PAGE, searchPage([fakeCard(1)])], { clock });

    expect(result.stopped).toMatchObject({ signal: 'sorry', searchId: first });
    expect(result.searchesDone).toBe(0);
    expect(result.searchesRemaining).toBe(2);
    expect(drivers[0]?.opened).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);

    const rows = await db.select().from(schema.searches);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(first as number)).toMatchObject({ status: 'blocked', blockSignal: 'sorry' });
    expect(byId.get(first as number)?.landedUrl).toContain('/sorry/');
    expect(byId.get(second as number)?.status).toBe('pending');

    const [run] = await db.select().from(schema.runs);
    expect(run?.status).toBe('blocked');
    expect(run?.stoppedReason).toMatch(/^sorry: /);
    const log = await db.select().from(schema.requestLog);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ outcome: 'sorry', note: 'search', status: 429 });
    expect(await db.select().from(schema.listings)).toHaveLength(0);
  });

  it('stops on a reCAPTCHA page and on the unusual-traffic page, but not on a normal page that mentions it', async () => {
    const captcha: FixturePage = { kind: 'other', landedUrl: 'https://www.google.com/maps/search/x', signals: { hasRecaptcha: true } };
    const unusual: FixturePage = { kind: 'other', signals: { bodyHasUnusualTraffic: true } };
    for (const [page, signal, outcome] of [
      [captcha, 'captcha', 'captcha'],
      [unusual, 'unusual_traffic', 'blocked'],
    ] as const) {
      await truncateAll(db);
      const runId = await createRun(db);
      await createSearches(db, runId, [{}]);
      const { result } = await runDiscover(runId, [page]);
      expect(result.stopped?.signal).toBe(signal);
      expect((await db.select().from(schema.requestLog))[0]?.outcome).toBe(outcome);
    }

    await truncateAll(db);
    const runId = await createRun(db);
    await createSearches(db, runId, [{}]);
    const normal = searchPage([fakeCard(1)], { signals: { bodyHasUnusualTraffic: true } });
    const { result } = await runDiscover(runId, [normal]);
    expect(result.stopped).toBeNull();
    expect(result.searchesDone).toBe(1);
  });
});
