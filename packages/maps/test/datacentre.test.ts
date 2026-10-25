import { EXIT_BLOCKED, type CommandContext } from '@pp/core';
import { describe, expect, it } from 'vitest';
import type { LoggedRequest } from '../src/cap';
import { commands } from '../src/commands';
import { runDatacentreTest } from '../src/datacentre';
import { FixtureDriver } from '../src/driver/fixture';
import type { FixturePage } from '../src/driver/types';
import { fakeCard, fakePlace, limitedPlace, makeClock, rng, searchPage, SORRY_PAGE, testConfig } from './helpers';

const placePage = (n: number, limited = false): FixturePage => ({
  kind: 'place',
  place: limited ? limitedPlace(n) : fakePlace(n),
});

const cards = (n: number) => Array.from({ length: n }, (_, i) => fakeCard(n * 100 + i));

describe('runDatacentreTest', () => {
  it('prints attempted vs ok vs blocked vs limited counts, without a database', async () => {
    const clock = makeClock();
    const driver = new FixtureDriver([
      searchPage(cards(1)),
      placePage(1),
      searchPage(cards(2)),
      placePage(2, true),
      searchPage(cards(3)),
      placePage(3),
    ]);
    const summary = await runDatacentreTest({
      label: 'laptop',
      config: testConfig(),
      searches: 3,
      places: 3,
      driver,
      sleep: clock.sleep,
      rng: rng(),
    });
    expect(summary).toMatchObject({
      label: 'laptop',
      attempted: { searches: 3, places: 3 },
      ok: 5,
      blocked: { sorry: 0, captcha: 0, unusual_traffic: 0 },
      limitedView: 1,
      cardsPerSearch: [1, 2, 3],
      stoppedOn: null,
    });
    expect(summary.msPerSearch).toHaveLength(3);
    expect(summary.avgCardsPerSearch).toBe(2);
    expect(driver.opened[0]).toBe('https://www.google.com/maps/search/house%20painter%2078701/?hl=en&gl=us');
    expect(driver.opened[1]).toMatch(/^https:\/\/www\.google\.com\/maps\?cid=\d+&hl=en&gl=us$/);
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
  });

  it('uses the normal throttle: place pause before each place page, search pause between searches', async () => {
    const clock = makeClock();
    const driver = new FixtureDriver([searchPage(cards(1)), placePage(1), searchPage(cards(2)), placePage(2)]);
    await runDatacentreTest({ label: 'x', config: testConfig(), searches: 2, places: 2, driver, sleep: clock.sleep, rng: rng() });
    expect(clock.sleeps).toHaveLength(3);
    const [p1, s1, p2] = clock.sleeps as [number, number, number];
    for (const p of [p1, p2]) expect(p >= 4000 && p <= 8000).toBe(true);
    expect(s1 >= 10000 && s1 <= 20000).toBe(true);
  });

  it('stops at the first block and counts it', async () => {
    const clock = makeClock();
    const driver = new FixtureDriver([searchPage(cards(1)), placePage(1), SORRY_PAGE, searchPage(cards(3))]);
    const summary = await runDatacentreTest({ label: 'railway', config: testConfig(), searches: 5, places: 5, driver, sleep: clock.sleep, rng: rng() });
    expect(summary.attempted).toEqual({ searches: 2, places: 1 });
    expect(summary.blocked).toEqual({ sorry: 1, captcha: 0, unusual_traffic: 0 });
    expect(summary.stoppedOn).toBe('sorry');
    expect(summary.ok).toBe(2);
    expect(driver.pagesLeft).toBe(1);
  });

  it('counts a captcha on a place page', async () => {
    const captcha: FixturePage = { kind: 'other', signals: { hasRecaptcha: true } };
    const driver = new FixtureDriver([searchPage(cards(1)), captcha]);
    const summary = await runDatacentreTest({ label: 'x', config: testConfig(), searches: 2, places: 2, driver, sleep: makeClock().sleep, rng: rng() });
    expect(summary.blocked.captcha).toBe(1);
    expect(summary.attempted).toEqual({ searches: 1, places: 1 });
  });

  it('writes request_log entries tagged dctest:<label> only when a sink is given', async () => {
    const rows: LoggedRequest[] = [];
    const driver = new FixtureDriver([searchPage(cards(1)), placePage(1)]);
    await runDatacentreTest({
      label: 'laptop',
      config: testConfig(),
      searches: 1,
      places: 1,
      driver,
      sleep: makeClock().sleep,
      rng: rng(),
      log: async (r) => {
        rows.push(r);
      },
    });
    expect(rows.map((r) => [r.note, r.outcome, r.runId])).toEqual([
      ['dctest:laptop', 'ok', null],
      ['dctest:laptop', 'ok', null],
    ]);
  });
});

describe('Maps commands that need a live browser', () => {
  const ctx = (): CommandContext => ({
    config: () => testConfig(),
    db: async () => {
      throw new Error('the database must not be touched');
    },
    fetcher: async () => {
      throw new Error('no fetcher');
    },
    evidence: async () => {
      throw new Error('no evidence');
    },
    log: { info() {}, warn() {}, error() {} } as unknown as CommandContext['log'],
    out() {},
  });

  it('datacentre-test lists its options and refuses without PP_LIVE=1, before any database or browser use', async () => {
    const spec = commands.find((c) => c.name === 'maps datacentre-test');
    expect(spec?.options?.map((o) => o.flags)).toEqual(
      expect.arrayContaining(['--label <name>', '--searches <n>', '--places <n>', '--no-db', '--out <file>']),
    );
    await expect(spec?.run(ctx(), [], { label: 'x', db: false })).rejects.toThrow(/PP_LIVE=1/);
  });

  it('smoke, discover and detail refuse without PP_LIVE=1 too', async () => {
    for (const name of ['maps smoke', 'maps discover', 'maps detail']) {
      const c = commands.find((x) => x.name === name);
      await expect(c?.run(ctx(), [], { zip: '08817', term: 'x', run: '1' })).rejects.toThrow(/PP_LIVE=1/);
    }
    expect(EXIT_BLOCKED).toBe(3);
  });
});
