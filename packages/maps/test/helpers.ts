import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLogger,
  DbEvidenceStore,
  loadConfig,
  schema,
  type Db,
  type Fetcher,
  type PpConfig,
  type StageContext,
} from '@pp/core';
import type { CardSnapshot, FixturePage, PlaceSnapshot } from '../src/driver/types';
import { FixtureDriver } from '../src/driver/fixture';
import { seededRng } from '../src/throttle';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(here, 'fixtures');

export function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
}

export function sdCards(): CardSnapshot[] {
  return readFixture<CardSnapshot[]>('sd-house-painter-cards.json');
}

process.env.PP_LOG_LEVEL ??= 'silent';

export function testConfig(over: Partial<PpConfig['maps']> = {}): PpConfig {
  const base = loadConfig();
  return { ...base, maps: { ...base.maps, ...over } };
}

export interface TestClock {
  now(): Date;
  advanceMinutes(m: number): void;
  sleeps: number[];
  sleep(ms: number): Promise<void>;
}

export function makeClock(start = '2026-10-25T12:00:00Z'): TestClock {
  let t = Date.parse(start);
  const sleeps: number[] = [];
  return {
    now: () => new Date(t),
    advanceMinutes: (m) => {
      t += m * 60_000;
    },
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

export function makeCtx(db: Db, runId: number, clock: TestClock, config: PpConfig = testConfig()): StageContext {
  return {
    runId,
    config,
    db,
    evidence: new DbEvidenceStore(db),
    fetcher: {} as Fetcher,
    log: createLogger('maps-test'),
    now: clock.now,
    sleep: clock.sleep,
  };
}

export async function createRun(db: Db, over: Partial<typeof schema.runs.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(schema.runs)
    .values({ areaId: 'edison_nj', state: 'NJ', status: 'planned', configSnapshot: {}, ...over })
    .returning({ id: schema.runs.id });
  if (!row) throw new Error('run insert failed');
  return row.id;
}

export async function createSearches(
  db: Db,
  runId: number,
  specs: { zip?: string; term?: string; status?: string; position?: number; blockSignal?: string; finishedAt?: Date }[],
): Promise<number[]> {
  const ids: number[] = [];
  let i = 0;
  for (const s of specs) {
    i++;
    const zip = s.zip ?? `0881${i}`;
    const term = s.term ?? 'house painter';
    const [row] = await db
      .insert(schema.searches)
      .values({
        runId,
        areaId: 'edison_nj',
        zip,
        term,
        position: s.position ?? i,
        query: `${term} ${zip}`,
        status: s.status ?? 'pending',
        blockSignal: s.blockSignal ?? null,
        finishedAt: s.finishedAt ?? null,
      })
      .returning({ id: schema.searches.id });
    if (!row) throw new Error('search insert failed');
    ids.push(row.id);
  }
  return ids;
}

/** A synthetic card that parses cleanly. `n` makes the ids and the name unique. */
export function fakeCard(n: number, over: Partial<CardSnapshot> = {}): CardSnapshot {
  const hex = n.toString(16).padStart(4, '0');
  const name = `Painter ${n}`;
  return {
    name,
    href: `https://www.google.com/maps/place/Painter+${n}/data=!4m7!3m6!1s0x80dbf959fc5c18d3:0x2452b5fb1a89${hex}!8m2!3d40.${5000 + n}!4d-74.${3000 + n}!16s%2Fg%2F11gmz${n}!19sChIJfake${n}`,
    ratingAria: `4.${n % 10} stars ${100 + n} Reviews`,
    text: `${name}\n${name}\n4.${n % 10}(${100 + n})\nPainter · ${n} Main St\nOpen · Closes 5 PM · (732) 555-${String(1000 + n).slice(-4)}\n\nWebsite\n\nDirections`,
    websiteHref: `https://painter${n}.example.com/`,
    ...over,
  };
}

export const searchPage = (cards: CardSnapshot[], over: Partial<Extract<FixturePage, { kind: 'search' }>> = {}): FixturePage => ({
  kind: 'search',
  cards,
  endReached: true,
  ...over,
});

export const SORRY_PAGE: FixturePage = {
  kind: 'other',
  landedUrl: 'https://www.google.com/sorry/index?continue=https://www.google.com/maps/search/x',
  status: 429,
  signals: { hasRecaptcha: true, bodyHasUnusualTraffic: true },
};

/** A complete place snapshot for a fake card. */
export function fakePlace(n: number, over: Partial<PlaceSnapshot> = {}): PlaceSnapshot {
  const c = fakeCard(n);
  return {
    url: c.href,
    h1: `Painter ${n}`,
    phoneItemId: `phone:tel:+1732555${String(1000 + n).slice(-4)}`,
    phoneAria: `Phone: (732) 555-${String(1000 + n).slice(-4)} `,
    authorityHref: `https://painter${n}.example.com/`,
    addressAria: `Address: ${n} Main St, Edison, NJ 08817-1234 `,
    ratingAria: `4.${n % 10} stars `,
    reviewCountAria: `${100 + n} reviews`,
    reviewsTabPresent: true,
    categoryTexts: ['Painter'],
    closedText: 'Open ⋅ Closes 5 PM',
    bodyHasLimitedViewText: false,
    ...over,
  };
}

export const limitedPlace = (n: number): PlaceSnapshot =>
  fakePlace(n, { reviewCountAria: null, reviewsTabPresent: false, ratingAria: null, bodyHasLimitedViewText: true });

export function driverFactory(pages: FixturePage[]): { make: () => Promise<FixtureDriver>; drivers: FixtureDriver[] } {
  const drivers: FixtureDriver[] = [];
  return {
    drivers,
    make: async () => {
      const d = new FixtureDriver(pages);
      drivers.push(d);
      return d;
    },
  };
}

export const rng = (): (() => number) => seededRng(42);
