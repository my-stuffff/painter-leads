import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FixtureDriver } from '../src/driver/fixture';
import type { CardSnapshot, FixturePage } from '../src/driver/types';
import { localityShare, runSmoke, SmokeBudgetError } from '../src/smoke';
import { fakeCard, fakePlace, makeClock, readFixture, rng, searchPage, SORRY_PAGE, testConfig } from './helpers';

type SearchFixture = Extract<FixturePage, { kind: 'search' }>;

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'pp-smoke-'));
  const budgetPath = path.join(dir, 'smoke-budget.json');
  const clock = makeClock();
  const run = (pages: FixturePage[], o: { places?: number; save?: boolean; zip?: string; form?: 'zip_text' | 'viewport' } = {}) => {
    const driver = new FixtureDriver(pages);
    const promise = runSmoke({
      config: testConfig(),
      zip: o.zip ?? '08817',
      term: 'house painter',
      form: o.form ?? 'zip_text',
      places: o.places ?? 0,
      saveFixturesDir: o.save ? path.join(dir, 'out') : undefined,
      worker: 'maps',
      budgetPath,
      driverFactory: async () => driver,
      sleep: clock.sleep,
      rng: rng(),
    });
    return { driver, promise };
  };
  const budget = () => JSON.parse(readFileSync(budgetPath, 'utf8')) as Record<string, { searches: number; placePages: number }>;
  return { dir, run, budget, clock };
}

describe('smoke budget (D-15: at most 3 live searches and 6 place pages per worker)', () => {
  it('spends the budget before the request and refuses once 3 searches are used', async () => {
    const { run, budget } = setup();
    for (let i = 1; i <= 3; i++) {
      const { promise } = run([searchPage([fakeCard(i)])]);
      const report = await promise;
      expect(report.searchNumber).toBe(i);
      expect(budget().maps?.searches).toBe(i);
    }
    const { driver, promise } = run([searchPage([fakeCard(9)])]);
    await expect(promise).rejects.toThrow(SmokeBudgetError);
    expect(driver.opened).toHaveLength(0);
    expect(budget().maps).toEqual({ searches: 3, placePages: 0 });
  });

  it('refuses to open more place pages than the budget has left', async () => {
    const { run, budget } = setup();
    const cards = [1, 2, 3, 4, 5, 6, 7].map((n) => fakeCard(n));
    const pages: FixturePage[] = [searchPage(cards), ...cards.map((_, i): FixturePage => ({ kind: 'place', place: fakePlace(i + 1) }))];
    const a = run(pages, { places: 6 });
    const first = await a.promise;
    expect(first.placesOpened).toHaveLength(6);
    expect(budget().maps).toEqual({ searches: 1, placePages: 6 });
    const b = run([searchPage(cards)], { places: 1 });
    await expect(b.promise).rejects.toThrow(/allows 0 more place pages/);
    expect(b.driver.opened).toHaveLength(0);
    expect(budget().maps?.searches).toBe(1);
  });

  it('a block stops the smoke at once and still counts the search', async () => {
    const { run, budget } = setup();
    const { driver, promise } = run([SORRY_PAGE, searchPage([fakeCard(1)])], { places: 2, save: true });
    const report = await promise;
    expect(report.blocked).toBe('sorry');
    expect(report.cardCount).toBe(0);
    expect(driver.opened).toHaveLength(1);
    expect(budget().maps).toEqual({ searches: 1, placePages: 0 });
    expect(driver.closed).toBe(true);
  });

  it('saves the search and place snapshots as replayable fixture files, with pauses between navigations', async () => {
    const { run, dir, clock } = setup();
    const cards = [1, 2, 3].map((n) => fakeCard(n, n === 2 ? { text: 'Painter 2\nPainter 2\n4.1(10)\nPainter\nOpen · (732) 555-1002' } : {}));
    const pages: FixturePage[] = [searchPage(cards), { kind: 'place', place: fakePlace(1) }, { kind: 'place', place: fakePlace(2) }];
    const { promise } = run(pages, { places: 2, save: true });
    const report = await promise;
    const files = readdirSync(path.join(dir, 'out')).sort();
    expect(files).toEqual(['smoke-1-search.json', 'smoke-place-1.json', 'smoke-place-2.json']);
    const saved = JSON.parse(readFileSync(path.join(dir, 'out', 'smoke-1-search.json'), 'utf8')) as SearchFixture;
    expect(saved.kind).toBe('search');
    expect(saved.cards).toHaveLength(3);
    expect(report.savedFixtures).toHaveLength(3);
    // The first place is the first card, the second is the street-less (service-area style) card.
    expect(report.placesOpened.map((p) => p.name)).toEqual(['Painter 1', 'Painter 2']);
    expect(clock.sleeps).toHaveLength(2);
    for (const s of clock.sleeps) expect(s >= 4000 && s <= 8000).toBe(true);
  });

  it('the viewport form uses the Gazetteer centroid of the ZIP', async () => {
    const { run } = setup();
    const { driver, promise } = run([searchPage([fakeCard(1)])], { form: 'viewport' });
    await promise;
    expect(driver.opened[0]).toBe('https://www.google.com/maps/search/house%20painter/@40.514655,-74.393104,13z?hl=en&gl=us');
  });
});

describe('localityShare on the live smoke searches (query form decision)', () => {
  const cards = (f: string) => readFixture<SearchFixture>(f).cards as CardSnapshot[];

  it('smoke 1 (zip_text, 08817): 116 cards, 69 in area or neighbour ring, 31 in Edison ZCTAs, 16 in 08817', () => {
    const l = localityShare(testConfig(), '08817', cards('smoke-1-search.json'));
    expect(l).toMatchObject({ area: 'edison_nj', cardsWithCoords: 116, inAreaOrNeighbourRing: 69, inAreaZctas: 31, inTargetZip: 16 });
    expect(l.shareInAreaOrRing).toBeCloseTo(0.5948, 3);
  });

  it('smoke 2 (viewport, 08817): 77 cards, 56 / 14 / 4', () => {
    const l = localityShare(testConfig(), '08817', cards('smoke-2-search.json'));
    expect(l).toMatchObject({ cardsWithCoords: 77, inAreaOrNeighbourRing: 56, inAreaZctas: 14, inTargetZip: 4 });
    expect(l.shareInAreaOrRing).toBeCloseTo(0.7273, 3);
  });

  // 100 in area or ring when measured; 102 once the ZCTA file held every ZCTA touching the 24 whole cities, 105 with the
  // 292-city catalog ("area or ring" = inside any ZCTA polygon in the file; the Edison counts rose the same way).
  it('smoke 3 (zip_text, Austin 78701): 119 cards with coordinates, 105 / 84 / 14', () => {
    const l = localityShare(testConfig(), '78701', cards('smoke-3-search.json'));
    expect(l).toMatchObject({ area: 'austin_tx', cardsWithCoords: 119, inAreaOrNeighbourRing: 105, inAreaZctas: 84, inTargetZip: 14 });
  });
});
