import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT_BLOCKED, getTestDb, truncateAll, type Fetcher } from '@pp/core';
import { offlineFetcher, reprocessRun } from '../src/reprocess';
import { runPilot } from '../src/run';
import { resolveStages } from '../src/stages';
import { q } from '../src/sql';
import { makeEnv, readSheets, tempDir } from './helpers';

const handle = getTestDb();
const db = handle.db;

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

describe('resume', () => {
  it('a block in the middle of the expansion searches resumes from there and never repeats finished searches', async () => {
    const env = makeEnv(db);
    const stages = resolveStages({ fake: true, fakeOptions: { blockAfterSearches: 20 } });
    const first = await runPilot(env, 'edison_nj', { stages, outDir: tempDir() });
    expect(first.exitCode).toBe(EXIT_BLOCKED);

    const phases = await q<{ phase: string; status: string; n: string }>(
      db,
      `SELECT phase, status, COUNT(*) AS n FROM searches WHERE run_id = $1 GROUP BY phase, status ORDER BY phase, status`,
      [first.runId],
    );
    expect(phases).toContainEqual({ phase: 'pilot', status: 'done', n: '15' });
    expect(phases.some((p) => p.phase === 'expansion' && p.status === 'blocked')).toBe(true);

    const second = await runPilot(env, 'edison_nj', { stages, runId: first.runId, outDir: tempDir() });
    expect(second).toMatchObject({ exitCode: 0, status: 'done' });
    const left = await q<{ n: string }>(db, `SELECT COUNT(*) AS n FROM searches WHERE run_id = $1 AND status <> 'done'`, [first.runId]);
    expect(Number(left[0]?.n)).toBe(0);
    const total = await q<{ n: string }>(db, `SELECT COUNT(*) AS n FROM searches WHERE run_id = $1`, [first.runId]);
    expect(Number(total[0]?.n)).toBe(60); // no search was planned twice
  });

  it('a second run of the same area reuses the listings and does not duplicate companies or evidence', async () => {
    const env = makeEnv(db);
    const a = await runPilot(env, 'austin_tx', { fake: true, outDir: tempDir() });
    const count = async (from: string): Promise<number> =>
      Number((await q<{ n: string }>(db, `SELECT COUNT(*) AS n FROM ${from}`))[0]?.n);
    const companiesA = await count('companies');
    const listingsA = await count('listings');
    const otherEvidenceA = await count(`evidence WHERE extractor <> 'pipeline/classify'`);

    const b = await runPilot(env, 'austin_tx', { fake: true, outDir: tempDir() });
    expect(b.runId).not.toBe(a.runId);
    expect(await count('companies')).toBe(companiesA);
    expect(await count('listings')).toBe(listingsA);
    expect(await count(`evidence WHERE extractor <> 'pipeline/classify'`)).toBe(otherEvidenceA);
    // classification signals were replaced (old ones superseded), not piled up
    const painters = await count(`companies WHERE painter_status = 'painter' AND in_area IS NOT FALSE`);
    expect(await count(`evidence WHERE extractor = 'pipeline/classify' AND status = 'accepted'`)).toBe(painters);
  });
});

describe('reprocess', () => {
  it('retires earlier website evidence as superseded, re-extracts, and rewrites the report', async () => {
    const env = makeEnv(db);
    const out = tempDir();
    const first = await runPilot(env, 'edison_nj', { fake: true, outDir: out });
    const emails = await q<{ id: number; status: string }>(db, `SELECT id, status FROM evidence WHERE field = 'email' ORDER BY id`);
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((e) => e.status === 'accepted')).toBe(true);

    const result = await reprocessRun(env, first.runId, { fake: true, outDir: out });
    expect(result.superseded).toBeGreaterThan(0);

    const rejected = await q<{ reject_reason: string }>(db, `SELECT reject_reason FROM evidence WHERE field = 'email' AND status = 'rejected'`);
    expect(rejected.length).toBe(emails.length);
    expect(rejected.every((r) => r.reject_reason === 'superseded')).toBe(true);
    const fresh = await q<{ id: number }>(db, `SELECT id FROM evidence WHERE field = 'email' AND status = 'accepted'`);
    expect(fresh.length).toBe(emails.length);
    expect(Math.min(...fresh.map((f) => f.id))).toBeGreaterThan(Math.max(...emails.map((e) => e.id)));

    const sheets = await readSheets(result.report.xlsxPath);
    const master = sheets['Master list'] as unknown[][];
    expect(master.some((r) => String(r[6]).startsWith('info@fake'))).toBe(true);
  });

  it('only the chosen steps are retired: classify alone leaves website evidence alone', async () => {
    const env = makeEnv(db);
    const out = tempDir();
    const first = await runPilot(env, 'edison_nj', { fake: true, outDir: out });
    const before = await q<{ n: string }>(db, `SELECT COUNT(*) AS n FROM evidence WHERE source_type = 'website' AND status = 'accepted' AND extractor = 'fake-site'`);
    const result = await reprocessRun(env, first.runId, { fake: true, outDir: out, steps: new Set(['classify']) });
    expect(result.superseded).toBe(0);
    const after = await q<{ n: string }>(db, `SELECT COUNT(*) AS n FROM evidence WHERE source_type = 'website' AND status = 'accepted' AND extractor = 'fake-site'`);
    expect(after[0]?.n).toBe(before[0]?.n);
    // classification signals were replaced, not piled up
    const signals = await q<{ n: string }>(db, `SELECT COUNT(*) AS n FROM evidence WHERE field = 'residential_signal' AND status = 'accepted'`);
    const painters = await q<{ n: string }>(db, `SELECT COUNT(*) AS n FROM companies WHERE painter_status = 'painter' AND in_area IS NOT FALSE`);
    expect(Number(signals[0]?.n)).toBe(Number(painters[0]?.n));
  });
});

describe('offlineFetcher', () => {
  it('forces every request to be answered from the cache only', async () => {
    const calls: { kind: string; offline: unknown }[] = [];
    const base = {
      get: vi.fn(async (_u: string, o: { offline?: boolean }) => {
        calls.push({ kind: 'get', offline: o.offline });
        return {} as never;
      }),
      post: vi.fn(async (_u: string, _f: unknown, o: { offline?: boolean }) => {
        calls.push({ kind: 'post', offline: o.offline });
        return {} as never;
      }),
      session: vi.fn(() => ({
        get: async (_u: string, o?: { offline?: boolean }) => {
          calls.push({ kind: 'session.get', offline: o?.offline });
          return {} as never;
        },
        post: async (_u: string, _f: unknown, o?: { offline?: boolean }) => {
          calls.push({ kind: 'session.post', offline: o?.offline });
          return {} as never;
        },
        cookies: () => ({}),
      })),
      download: vi.fn(async (_u: string, _d: string, o: { offline?: boolean }) => {
        calls.push({ kind: 'download', offline: o.offline });
        return { path: '', bytes: 0, sha256: '' };
      }),
      robotsAllowed: vi.fn(async () => false),
      readCached: vi.fn(async () => null),
      storeRendered: vi.fn(async () => ({ sha256: '', cachePath: '' })),
      assertPublicUrl: vi.fn(async () => {
        throw new Error('would resolve DNS');
      }),
    } as unknown as Fetcher;

    const f = offlineFetcher(base);
    await f.get('https://a.test', { source: 'websites', offline: false });
    await f.post('https://a.test', {}, { source: 'websites' });
    const s = f.session('x', 'websites');
    await s.get('https://a.test');
    await s.post('https://a.test', {});
    await f.download('https://a.test', 'x', { source: 'websites' });
    expect(calls.map((c) => c.offline)).toEqual([true, true, true, true, true]);
    expect(await f.robotsAllowed('https://a.test', 'websites')).toBe(true); // no robots.txt request while offline
    await expect(f.assertPublicUrl('https://a.test')).resolves.toBeUndefined(); // no DNS lookup while offline
  });
});
