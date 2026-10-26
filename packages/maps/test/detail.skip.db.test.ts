import { getTestDb, schema, truncateAll, type Db, type Logger } from '@pp/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDetailStage } from '../src/detail';
import { createDiscoverStage } from '../src/discover';
import type { CardSnapshot, FixturePage } from '../src/driver/types';
import { createRun, createSearches, driverFactory, fakeCard, fakePlace, makeClock, makeCtx, rng, searchPage } from './helpers';

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

const placePage = (n: number): FixturePage => ({ kind: 'place', place: fakePlace(n), landedUrl: fakePlace(n).url });

/** A card whose map pin is (lat, lng); the default fake pins sit inside Edison. */
const pinned = (n: number, lat: number, lng: number): CardSnapshot => {
  const c = fakeCard(n);
  return { ...c, href: c.href.replace(/!3d[-\d.]+!4d[-\d.]+/, `!3d${lat}!4d${lng}`) };
};
const unpinned = (n: number): CardSnapshot => {
  const c = fakeCard(n);
  return { ...c, href: c.href.replace(/!3d[-\d.]+!4d[-\d.]+/, '') };
};

// Edison's polygons end near 40.47 N; these pins are measured against data/geo (see pin-skip.test.ts).
const FAR = { lat: 40.2, lng: -74.4 }; // about 30 km from every Edison ZIP
const NEAR_OUTSIDE = { lat: 40.47, lng: -74.45 }; // about 3.9 km outside the polygons
const EXPANSION_ONLY = { lat: 40.568, lng: -74.248 }; // inside expansion ZIP 07064, about 7 km from the pilot ZIPs

function capturingLog(): { log: Logger; lines: { obj: unknown; msg: string }[] } {
  const lines: { obj: unknown; msg: string }[] = [];
  const rec = (obj: unknown, msg?: string) => lines.push({ obj, msg: msg ?? '' });
  const log = { info: rec, warn: rec, error: rec, debug: rec, trace: rec, fatal: rec } as unknown as Logger;
  return { log, lines };
}

async function seed(cards: CardSnapshot[]): Promise<number> {
  const clock = makeClock();
  const runId = await createRun(db);
  await createSearches(db, runId, [{}]);
  const f = driverFactory([searchPage(cards)]);
  await createDiscoverStage({ driverFactory: f.make, rng: rng() }).run(makeCtx(db, runId, clock), { runId });
  return runId;
}

async function runDetail(runId: number, pages: FixturePage[], limit?: number) {
  const clock = makeClock();
  const f = driverFactory(pages);
  const { log, lines } = capturingLog();
  const ctx = { ...makeCtx(db, runId, clock), log };
  const result = await createDetailStage({ driverFactory: f.make, rng: rng() }).run(ctx, {
    runId,
    ...(limit !== undefined ? { limit } : {}),
  });
  return { result, opened: f.drivers.flatMap((d) => d.opened), lines };
}

const statusOf = async (name: string) => {
  const [row] = await db.select().from(schema.listings).where(eq(schema.listings.name, name));
  if (!row) throw new Error(`no listing ${name}`);
  return row;
};

describe('detail: card pin far outside the pilot area', () => {
  it('does not open the place page, leaves the listing pending and says why', async () => {
    const runId = await seed([pinned(1, FAR.lat, FAR.lng), fakeCard(2)]);
    const { result, opened, lines } = await runDetail(runId, [placePage(2)]);
    expect(result).toEqual({ done: 1, limitedView: 0, failed: 0, stopped: null });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(`cid=`);
    const far = await statusOf('Painter 1');
    expect(far).toMatchObject({ detailStatus: 'pending', detailAttempts: 0, lastCheckedAt: null });
    expect((await statusOf('Painter 2')).detailStatus).toBe('done');
    const said = lines.find((l) => /outside pilot area \(card pin \d+(\.\d)? km away\)/.test(l.msg));
    expect(said).toBeDefined();
    expect(said?.obj).toMatchObject({ listingId: far.id });
  });

  it('logs no request for the skipped listing, so the daily cap is not used up', async () => {
    const runId = await seed([pinned(1, FAR.lat, FAR.lng), pinned(3, FAR.lat + 0.01, FAR.lng)]);
    const { result, opened } = await runDetail(runId, []);
    expect(result).toEqual({ done: 0, limitedView: 0, failed: 0, stopped: null });
    expect(opened).toEqual([]);
    const requests = await db.select().from(schema.requestLog);
    expect(requests.filter((r) => r.note === 'place')).toEqual([]);
  });

  it('does not let a skipped listing use up the run limit', async () => {
    const runId = await seed([pinned(1, FAR.lat, FAR.lng), fakeCard(2)]);
    const { result } = await runDetail(runId, [placePage(2)], 1);
    expect(result.done).toBe(1);
    expect((await statusOf('Painter 2')).detailStatus).toBe('done');
  });
});

describe('detail: card pin that is not clearly outside', () => {
  it('opens a pin outside the polygon but within the threshold', async () => {
    const runId = await seed([pinned(1, NEAR_OUTSIDE.lat, NEAR_OUTSIDE.lng)]);
    const { result, opened } = await runDetail(runId, [placePage(1)]);
    expect(result.done).toBe(1);
    expect(opened).toHaveLength(1);
  });

  it('opens a listing whose card has no pin', async () => {
    const runId = await seed([unpinned(1)]);
    expect((await statusOf('Painter 1')).coordsStatus).not.toBe('captured');
    const { result, opened } = await runDetail(runId, [placePage(1)]);
    expect(result.done).toBe(1);
    expect(opened).toHaveLength(1);
  });

  it('opens a pin inside an expansion ZIP even when it is far from the pilot ZIPs', async () => {
    const runId = await seed([pinned(1, EXPANSION_ONLY.lat, EXPANSION_ONLY.lng)]);
    const { result, opened } = await runDetail(runId, [placePage(1)]);
    expect(result.done).toBe(1);
    expect(opened).toHaveLength(1);
  });
});
