import path from 'node:path';
import { REPO_ROOT, type CommandContext } from '@pp/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureDriver } from '../src/driver/fixture';
import type { CardSnapshot, FixturePage, OpenResult, PageDriver, PageSignals, PlaceSnapshot, ScrollResult } from '../src/driver/types';
import { parseCard } from '../src/parse/card';
import { withLocale } from '../src/parse/url';
import { probeCommand, readProbeInput, readProbeSettings } from '../src/probe/command';
import {
  buildRamp,
  parsePauseRange,
  parseRampJson,
  StepMonitor,
  summarizeStep,
  type ProbeRecord,
  type ProbeStep,
} from '../src/probe/ramp';
import { probeOne, runProbe, type ProbeRunOptions } from '../src/probe/run';
import { buildTextSearchUrl } from '../src/query';
import { fakeCard, fakePlace, limitedPlace, makeClock, rng, searchPage, SORRY_PAGE, testConfig } from './helpers';

/** Hands out pages from one shared script, so several workers (pages) see one request sequence. */
class ScriptedDriver implements PageDriver {
  private inner = new FixtureDriver([]);
  constructor(
    readonly worker: number,
    private readonly script: { next(url: string): FixturePage; opened: string[] },
  ) {}
  async open(url: string): Promise<OpenResult> {
    this.script.opened.push(url);
    this.inner = new FixtureDriver([this.script.next(url)]);
    return this.inner.open(url);
  }
  scrollFeed(): Promise<ScrollResult> {
    return this.inner.scrollFeed();
  }
  snapshotCards(): Promise<CardSnapshot[]> {
    return this.inner.snapshotCards();
  }
  snapshotPlace(): Promise<PlaceSnapshot> {
    return this.inner.snapshotPlace();
  }
  pageSignals(): Promise<PageSignals> {
    return this.inner.pageSignals();
  }
  async close(): Promise<void> {}
}

const cards = (n: number, from = 1): CardSnapshot[] => Array.from({ length: n }, (_, i) => fakeCard(from + i));
const okSearch = (): FixturePage => searchPage(cards(3));
const okPlace = (n = 1): FixturePage => ({ kind: 'place', place: fakePlace(n) });
const limited = (n = 1): FixturePage => ({ kind: 'place', place: limitedPlace(n) });

function setup(pageFor: (n: number, url: string) => FixturePage, over: Partial<ProbeRunOptions> = {}) {
  const clock = makeClock();
  const lines: object[] = [];
  const script = {
    opened: [] as string[],
    count: 0,
    next(url: string): FixturePage {
      this.count++;
      return pageFor(this.count, url);
    },
  };
  const drivers: ScriptedDriver[] = [];
  const opts: ProbeRunOptions = {
    mode: 'search',
    steps: [
      { name: 'A', pauseMs: [4000, 8000], concurrency: 1, requests: 5 },
      { name: 'B', pauseMs: [2000, 4000], concurrency: 1, requests: 5 },
      { name: 'C', pauseMs: [1000, 2000], concurrency: 1, requests: 5 },
    ],
    queries: ['q1', 'q2', 'q3', 'q4'],
    maxRequests: 100,
    scrolls: 3,
    limitedStreak: 5,
    errorStreak: 5,
    harvest: { maxSearches: 10, pauseMs: [10000, 20000] },
    recovery: { checks: 0, waitMs: 15 * 60_000 },
    driver: async (w) => {
      const d = new ScriptedDriver(w, script);
      drivers.push(d);
      return d;
    },
    sleep: clock.sleep,
    now: clock.now,
    rng: rng(),
    emit: (l) => lines.push(l),
    ...over,
  };
  const requests = (): ProbeRecord[] => lines.filter((l): l is ProbeRecord => (l as ProbeRecord).type === 'request');
  return { opts, clock, lines, script, drivers, requests };
}

describe('buildRamp', () => {
  it('starts at the local pace with one page, halves the pause each step and doubles pages at the end', () => {
    const steps = buildRamp({ basePauseMs: [4000, 8000], maxConcurrency: 8, steps: 6, stepRequests: 25 });
    expect(steps.map((s) => [s.name, s.concurrency, s.pauseMs])).toEqual([
      ['A', 1, [4000, 8000]],
      ['B', 1, [2000, 4000]],
      ['C', 1, [1000, 2000]],
      ['D', 2, [500, 1000]],
      ['E', 4, [250, 500]],
      ['F', 8, [125, 250]],
    ]);
    expect(steps.every((s) => s.requests === 25)).toBe(true);
  });

  it('ends exactly at a concurrency that is not a power of two, and stays at 1 page when asked', () => {
    expect(buildRamp({ basePauseMs: [1000, 1000], maxConcurrency: 3, steps: 5, stepRequests: 1 }).map((s) => s.concurrency)).toEqual([
      1, 1, 1, 2, 3,
    ]);
    expect(buildRamp({ basePauseMs: [1000, 1000], maxConcurrency: 1, steps: 4, stepRequests: 1 }).map((s) => s.concurrency)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(buildRamp({ basePauseMs: [1000, 2000], maxConcurrency: 8, steps: 1, stepRequests: 1 })).toEqual([
      { name: 'A', pauseMs: [1000, 2000], concurrency: 1, requests: 1 },
    ]);
  });

  it('parses PAUSE_MS and a RAMP override, and rejects bad ones', () => {
    expect(parsePauseRange('4000-8000')).toEqual([4000, 8000]);
    expect(parsePauseRange(' 500 ')).toEqual([500, 500]);
    expect(() => parsePauseRange('8000-4000')).toThrow(/below min/);
    expect(() => parsePauseRange('fast')).toThrow(/PAUSE_MS/);
    expect(parseRampJson('[{"pauseMs":[100,200],"concurrency":2,"requests":10}]')).toEqual([
      { name: 'A', pauseMs: [100, 200], concurrency: 2, requests: 10 },
    ]);
    expect(() => parseRampJson('[{"pauseMs":[200,100],"concurrency":2,"requests":10}]')).toThrow(/RAMP step 0/);
    expect(() => parseRampJson('[]')).toThrow(/non-empty/);
  });
});

describe('StepMonitor', () => {
  it('stops at once on any block page', () => {
    for (const signal of ['sorry', 'captcha', 'unusual_traffic', 'http_403'] as const) {
      const m = new StepMonitor({ limitedStreak: 5, errorStreak: 5 });
      expect(m.record('ok')).toBeNull();
      expect(m.record(signal)).toMatchObject({ reason: 'blocked', signal });
      expect(m.record('ok')).toMatchObject({ reason: 'blocked' });
    }
  });

  it('stops on N limited views in a row; an ok page resets the streak', () => {
    const m = new StepMonitor({ limitedStreak: 3, errorStreak: 5 });
    for (const o of ['limited_view', 'limited_view', 'ok', 'limited_view', 'limited_view'] as const) expect(m.record(o)).toBeNull();
    expect(m.record('limited_view')).toMatchObject({ reason: 'limited_streak' });
  });

  it('stops on N errors or unreadable pages in a row, and a streak of 0 never stops', () => {
    const m = new StepMonitor({ limitedStreak: 5, errorStreak: 2 });
    expect(m.record('error')).toBeNull();
    expect(m.record('empty')).toMatchObject({ reason: 'error_streak' });
    const off = new StepMonitor({ limitedStreak: 0, errorStreak: 0 });
    for (let i = 0; i < 50; i++) expect(off.record(i % 2 ? 'error' : 'limited_view')).toBeNull();
  });
});

describe('summarizeStep', () => {
  it('reports shares, blocks by kind and the effective hourly rate from wall time', () => {
    const step: ProbeStep = { name: 'B', pauseMs: [1, 2], concurrency: 2, requests: 10 };
    const rec = (outcome: ProbeRecord['outcome'], ms = 1000): ProbeRecord => ({
      type: 'request', t: '', step: 'B', kind: 'place', outcome, ms, status: 200, worker: 0, seq: 0,
    });
    const recs = [rec('ok'), rec('ok'), rec('ok'), rec('ok'), rec('ok'), rec('ok'), rec('limited_view'), rec('limited_view'), rec('error'), rec('sorry', 3000)];
    const s = summarizeStep(step, 'place', recs, 60_000, { reason: 'blocked', signal: 'sorry', detail: 'block page: sorry' }, false);
    expect(s).toMatchObject({
      requests: 10, ok: 6, okPct: 60, limited: 2, limitedPct: 20, blocked: 1, blockedBy: { sorry: 1 }, errors: 1,
      avgMs: 1200, effectivePerHour: 600, stoppedBy: 'blocked',
    });
    expect(summarizeStep(step, 'place', [], 0, null, true)).toMatchObject({ requests: 0, effectivePerHour: null, stoppedBy: 'budget' });
  });
});

describe('probeOne classifies with the pipeline code', () => {
  const one = (page: FixturePage, kind: 'search' | 'place') => probeOne(new FixtureDriver([page]), kind, kind === 'search' ? 'q' : 'https://www.google.com/maps?cid=1', 3);

  it('search: ok with its cards and place links; a list with no cards or an unknown page is empty', async () => {
    const r = await one(searchPage(cards(4)), 'search');
    expect(r).toMatchObject({ outcome: 'ok', cards: 4, status: 200 });
    expect(r.placeUrls?.[0]).toBe(withLocale(parseCard(fakeCard(1)).profileUrl));
    expect((await one(searchPage([]), 'search')).outcome).toBe('empty');
    expect((await one({ kind: 'place', place: fakePlace(1) }, 'search')).outcome).toBe('ok');
    expect((await one({ kind: 'other', landedUrl: 'https://consent.google.com/x', signals: {} }, 'search')).outcome).toBe('empty');
  });

  it('place: ok, limited view, block pages, http 403 and thrown errors', async () => {
    expect((await one(okPlace(), 'place')).outcome).toBe('ok');
    expect((await one(limited(), 'place')).outcome).toBe('limited_view');
    expect((await one(SORRY_PAGE, 'place')).outcome).toBe('sorry');
    expect((await one({ kind: 'other', signals: { hasRecaptcha: true } }, 'place')).outcome).toBe('captcha');
    expect((await one({ kind: 'other', status: 403, signals: {} }, 'place')).outcome).toBe('http_403');
    const err = await one({ kind: 'throw', error: new Error('Timeout 60000ms exceeded\nstack') }, 'place');
    expect(err).toMatchObject({ outcome: 'error', detail: 'Timeout 60000ms exceeded' });
  });
});

describe('runProbe', () => {
  it('runs every step when nothing blocks, wraps the query list, and picks the fastest clean step', async () => {
    const { opts, lines, script, requests } = setup(() => okSearch());
    const result = await runProbe(opts);
    expect(requests()).toHaveLength(15);
    expect(script.opened.slice(0, 5)).toEqual(['q1', 'q2', 'q3', 'q4', 'q1'].map(buildTextSearchUrl));
    expect(result.steps.map((s) => [s.step, s.requests, s.stoppedBy])).toEqual([
      ['A', 5, 'completed'],
      ['B', 5, 'completed'],
      ['C', 5, 'completed'],
    ]);
    expect(result.stop).toBeNull();
    expect(result.fastestClean?.step).toBe('C');
    // Wall time is the pauses (the fake clock does not move during a request): 5 pauses of 1-2 s.
    expect(result.steps[2]?.effectivePerHour).toBeGreaterThanOrEqual(1800);
    expect(result.steps[2]?.effectivePerHour).toBeLessThanOrEqual(3600);
    expect(result.verdict).toMatch(/Never blocked/);
    expect(lines[lines.length - 1]).toBe(result);
  });

  it('stops the ramp at the step that hit a block page and runs no faster step', async () => {
    const { opts, requests } = setup((n) => (n === 8 ? SORRY_PAGE : okSearch()));
    const result = await runProbe(opts);
    expect(requests()).toHaveLength(8);
    expect(result.stoppedAt).toBe('B');
    expect(result.stop).toMatchObject({ reason: 'blocked', signal: 'sorry' });
    expect(result.steps.map((s) => s.step)).toEqual(['A', 'B']);
    expect(result.steps[1]).toMatchObject({ requests: 3, ok: 2, blocked: 1, blockedBy: { sorry: 1 }, stoppedBy: 'blocked' });
    expect(result.fastestClean?.step).toBe('A');
    expect(result.verdict).toMatch(/Stopped at step B/);
  });

  it('after a stop, waits and re-checks until a request is ok again', async () => {
    const { opts, clock, requests } = setup((n) => (n >= 2 && n <= 4 ? SORRY_PAGE : okSearch()), {
      recovery: { checks: 4, waitMs: 15 * 60_000 },
    });
    const result = await runProbe(opts);
    // request 2 blocks step A; recovery checks 1-2 hit sorry (requests 3, 4), check 3 is ok (request 5).
    expect(result.recovery.map((r) => r.outcome)).toEqual(['sorry', 'sorry', 'ok']);
    expect(result.recoveredAfterMinutes).toBe(45);
    expect(clock.sleeps.filter((ms) => ms === 15 * 60_000)).toHaveLength(3);
    expect(requests().map((r) => r.step)).toEqual(['A', 'A', 'recovery-1', 'recovery-2', 'recovery-3']);
    expect(result.verdict).toMatch(/Recovered/);
  });

  it('place mode: harvests place links from its own searches, then ramps place pages until a limited-view streak', async () => {
    const { opts, script, requests } = setup(
      (n, url) => {
        if (url.includes('/maps/search/')) return searchPage(cards(8, n * 100));
        return n >= 9 ? limited(n) : okPlace(n);
      },
      { mode: 'place', limitedStreak: 3 },
    );
    const result = await runProbe(opts);
    // 15 places are needed for the 3 steps; each search gives 8, so 2 harvest searches are enough.
    expect(result.steps[0]).toMatchObject({ step: 'harvest', kind: 'search', requests: 2, stoppedBy: 'completed' });
    expect(script.opened[2]).toBe(withLocale(parseCard(fakeCard(100)).profileUrl));
    expect(result.stoppedAt).toBe('B');
    expect(result.stop).toMatchObject({ reason: 'limited_streak' });
    expect(result.steps[2]).toMatchObject({ step: 'B', kind: 'place', ok: 1, limited: 3 });
    expect(requests().filter((r) => r.kind === 'place')).toHaveLength(9);
    expect(result.fastestClean?.step).toBe('A');
  });

  it('place mode with ready place links skips the harvest', async () => {
    const places = ['https://www.google.com/maps?cid=1', 'https://www.google.com/maps?cid=2'];
    const { opts, script } = setup(() => okPlace(), { mode: 'place', places, steps: [{ name: 'A', pauseMs: [0, 0], concurrency: 1, requests: 3 }] });
    const result = await runProbe(opts);
    expect(result.steps.map((s) => s.step)).toEqual(['A']);
    expect(script.opened).toEqual([places[0], places[1], places[0]]);
  });

  it('a harvest that hits a block ends the probe before any place page', async () => {
    const { opts, requests } = setup(() => SORRY_PAGE, { mode: 'place' });
    const result = await runProbe(opts);
    expect(result.stoppedAt).toBe('harvest');
    expect(requests()).toHaveLength(1);
    expect(result.fastestClean).toBeNull();
  });

  it('never sends more than MAX_REQUESTS, and marks the step cut short as "budget"', async () => {
    const { opts, requests } = setup(() => okSearch(), { maxRequests: 7 });
    const result = await runProbe(opts);
    expect(requests()).toHaveLength(7);
    expect(result.steps.map((s) => [s.step, s.requests, s.stoppedBy])).toEqual([
      ['A', 5, 'completed'],
      ['B', 2, 'budget'],
    ]);
    expect(result.totalRequests).toBe(7);
  });

  it('runs a step on as many pages as its concurrency, sharing one request count', async () => {
    const { opts, drivers, requests } = setup(() => okSearch(), {
      steps: [{ name: 'A', pauseMs: [10, 20], concurrency: 3, requests: 9 }],
    });
    await runProbe(opts);
    expect(drivers).toHaveLength(3);
    expect(requests()).toHaveLength(9);
    expect(new Set(requests().map((r) => r.worker))).toEqual(new Set([0, 1, 2]));
  });

  it('stops a step on an error streak (timeouts)', async () => {
    const { opts } = setup((n) => (n > 2 ? { kind: 'throw', error: new Error('Timeout') } : okSearch()), { errorStreak: 3 });
    const result = await runProbe(opts);
    expect(result.stoppedAt).toBe('A');
    expect(result.stop).toMatchObject({ reason: 'error_streak' });
    expect(result.steps[0]).toMatchObject({ requests: 5, ok: 2, errors: 3 });
  });
});

describe('probe settings and command', () => {
  const config = testConfig();

  it('defaults to the local pace from pp.config.json and reads the env knobs', () => {
    const search = readProbeSettings({}, config);
    expect(search.mode).toBe('search');
    expect(search.steps[0]?.pauseMs).toEqual(config.maps.searchPauseMs);
    expect(search.steps).toHaveLength(6);
    expect(search.steps[5]?.concurrency).toBe(4);
    expect(search.limitedStreak).toBe(config.maps.limitedViewStreakStop);
    expect(search.scrolls).toBe(config.maps.maxScrolls);
    expect(search.inputFile).toBe(path.join(REPO_ROOT, 'ops', 'probe', 'queries.json'));

    const place = readProbeSettings(
      { PROBE_MODE: 'place', PAUSE_MS: '3000-6000', CONCURRENCY: '8', STEPS: '4', STEP_REQUESTS: '40', MAX_REQUESTS: '500', SCROLLS: '0', RECOVERY_MINUTES: '5' },
      config,
    );
    expect(place.steps.map((s) => [s.concurrency, s.pauseMs, s.requests])).toEqual([
      [1, [3000, 6000], 40],
      [2, [1500, 3000], 40],
      [4, [750, 1500], 40],
      [8, [375, 750], 40],
    ]);
    expect(place).toMatchObject({ mode: 'place', maxRequests: 500, scrolls: 0, recovery: { waitMs: 300_000 } });
    expect(readProbeSettings({ RAMP: '[{"pauseMs":[0,0],"concurrency":16,"requests":5}]' }, config).steps).toEqual([
      { name: 'A', pauseMs: [0, 0], concurrency: 16, requests: 5 },
    ]);
    expect(() => readProbeSettings({ PROBE_MODE: 'both' }, config)).toThrow(/PROBE_MODE/);
    expect(() => readProbeSettings({ CONCURRENCY: '0' }, config)).toThrow(/CONCURRENCY/);
  });

  it('the baked query file holds 300 distinct city searches', () => {
    const input = readProbeInput(path.join(REPO_ROOT, 'ops', 'probe', 'queries.json'));
    expect(input.queries).toHaveLength(300);
    expect(new Set(input.queries).size).toBe(300);
    expect(input.queries.every((q) => /^(house painter|painting contractor) in [^,]+, [A-Z]{2}$/.test(q))).toBe(true);
    expect(input.places).toBeUndefined();
  });

  describe('command', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });
    const ctx = (out: string[]): CommandContext =>
      ({
        config: () => config,
        db: async () => {
          throw new Error('the database must not be touched');
        },
        out: (l: string) => out.push(l),
      }) as unknown as CommandContext;

    it('--dry-run prints the settings and ramp and sends nothing; a real run refuses without PP_LIVE=1', async () => {
      delete process.env.PP_LIVE;
      const out: string[] = [];
      await probeCommand.run(ctx(out), [], { dryRun: true });
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0] as string)).toMatchObject({ type: 'start', mode: 'search', input: { queries: 300 } });
      await expect(probeCommand.run(ctx([]), [], {})).rejects.toThrow(/PP_LIVE=1/);
    });
  });
});
