import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getTestDb,
  truncateAll,
  type CommandContext,
  type Fetcher,
  type RegistryMatchInput,
  type SiteEnrichResult,
  type Stage,
  type StageRegistry,
} from '@pp/core';
import { pilotCommands } from '../src/commands';
import { reprocessRun } from '../src/reprocess';
import { runPilot } from '../src/run';
import { q } from '../src/sql';
import { resolveStages } from '../src/stages';
import { makeEnv, readSheets, tempDir } from './helpers';

const handle = getTestDb();
const db = handle.db;

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

const ONE = 'Fake Painting One'; // painter, 4.9 stars, 25 reviews: qualifies
const NEVER = 'Fake Painting Two'; // painter whose registry lookup never ran (empty status)
const DEPOT = 'Fake Paint Depot'; // "Paint store": not a painter, 4.8 stars, 30 reviews

const idOf = async (name: string): Promise<number> =>
  Number((await q<{ id: number }>(db, `SELECT id FROM companies WHERE display_name = $1`, [name]))[0]?.id);

/** Changes the Google categories of a company's listing, evidence rows included (the filter reads both). */
async function setCategory(name: string, category: string): Promise<void> {
  const id = await idOf(name);
  await q(db, `UPDATE listings SET categories = ARRAY[$2]::text[] WHERE company_id = $1`, [id, category]);
  await q(
    db,
    `UPDATE evidence SET value = $2 WHERE field = 'category' AND listing_id IN (SELECT id FROM listings WHERE company_id = $1)`,
    [id, category],
  );
}

async function finished(): Promise<{ runId: number; out: string; env: ReturnType<typeof makeEnv> }> {
  const env = makeEnv(db);
  const out = tempDir();
  const first = await runPilot(env, 'edison_nj', { fake: true, outDir: out });
  return { runId: first.runId, out, env };
}

const onTab = async (file: string, tab: string, company: string): Promise<boolean> => {
  const rows = (await readSheets(file))[tab] as unknown[][];
  return rows.slice(1).some((r) => r[0] === company);
};

describe('reprocess re-applies the painter filter', () => {
  it('a company whose category is now "Painting studio" becomes not_painter and leaves Qualified, with its reason', async () => {
    const { runId, out, env } = await finished();
    expect(await onTab(`${out}/${runId}/edison_nj.xlsx`, 'Qualified', ONE)).toBe(true);

    await setCategory(ONE, 'Painting studio');
    const result = await reprocessRun(env, runId, { fake: true, outDir: out });

    const row = (await q<{ painter_status: string; painter_reason: string; qualified: boolean; exclusion_reasons: string[] }>(
      db,
      `SELECT painter_status, painter_reason, qualified, exclusion_reasons FROM companies WHERE display_name = $1`,
      [ONE],
    ))[0];
    expect(row).toMatchObject({ painter_status: 'not_painter', qualified: false });
    expect(row?.painter_reason).toContain('Painting studio');
    expect(row?.exclusion_reasons).toEqual(['not a painting contractor']);

    expect(await onTab(result.report.xlsxPath, 'Qualified', ONE)).toBe(false);
    const master = (await readSheets(result.report.xlsxPath))['Master list'] as unknown[][];
    const masterRow = master.find((r) => r[0] === ONE);
    expect(masterRow?.at(-1)).toBe('not a painting contractor');
    const sources = (await readSheets(result.report.xlsxPath))['Sources'] as unknown[][];
    expect(sources.some((r) => r[0] === ONE && String(r[2]).includes('Painting studio'))).toBe(true);
  });

  it('does not plan any new search (the area and its expansion are left as they were)', async () => {
    const { runId, out, env } = await finished();
    const searches = (): Promise<{ n: string }[]> => q(db, `SELECT COUNT(*) AS n FROM searches WHERE run_id = $1`, [runId]);
    const before = await searches();
    await reprocessRun(env, runId, { fake: true, outDir: out });
    expect(await searches()).toEqual(before);
  });

  it('a company that becomes a painter is enriched from the cache where pages exist', async () => {
    const { runId, out, env } = await finished();
    await setCategory(DEPOT, 'Painter');
    expect((await q<{ painter_status: string }>(db, `SELECT painter_status FROM companies WHERE display_name = $1`, [DEPOT]))[0]?.painter_status).toBe('not_painter');

    const fake = resolveStages({ fake: true });
    const seen: string[] = [];
    const siteEnrich: Stage<Parameters<StageRegistry['site-enrich']['run']>[1], SiteEnrichResult> = {
      name: 'site-enrich',
      async run(ctx, company) {
        seen.push(company.name);
        if (company.name !== DEPOT) return fake['site-enrich'].run(ctx, company);
        return {
          companyId: company.companyId,
          status: 'ok',
          pages: [{ url: 'https://depot.test/', sha256: 'a'.repeat(64), rendered: false }],
          emails: 0,
          owners: 0,
          licenceNumbers: [],
          residentialSignals: 0,
        };
      },
    };
    const result = await reprocessRun(env, runId, { fake: true, outDir: out, stages: { ...fake, 'site-enrich': siteEnrich } });

    expect(seen).toContain(DEPOT);
    const row = (await q<{ painter_status: string; site_status: string | null; residential_status: string | null }>(
      db,
      `SELECT painter_status, site_status, residential_status FROM companies WHERE display_name = $1`,
      [DEPOT],
    ))[0];
    expect(row).toMatchObject({ painter_status: 'painter', site_status: 'ok', residential_status: 'residential_only' });
    expect(await onTab(result.report.xlsxPath, 'Qualified', DEPOT)).toBe(true);
  });

  it('a company that becomes a painter with no cached pages keeps site_status null, is not qualified, and says why', async () => {
    const { runId, out, env } = await finished();
    await setCategory(DEPOT, 'Painter');

    const fake = resolveStages({ fake: true });
    const classified: string[] = [];
    const stages: StageRegistry = {
      ...fake,
      'site-enrich': {
        name: 'site-enrich',
        async run(ctx, company) {
          if (company.name !== DEPOT) return fake['site-enrich'].run(ctx, company);
          // what the real stage answers when the offline cache has none of the site's pages
          return { companyId: company.companyId, status: 'fetch_failed', pages: [], emails: 0, owners: 0, licenceNumbers: [], residentialSignals: 0 };
        },
      },
      classify: {
        name: 'classify',
        async run(ctx, input) {
          classified.push(input.company.name);
          return fake.classify.run(ctx, input);
        },
      },
    };
    const result = await reprocessRun(env, runId, { fake: true, outDir: out, stages });

    const row = (await q<{ site_status: string | null; qualified: boolean; exclusion_reasons: string[]; residential_status: string | null; residential_reason: string | null }>(
      db,
      `SELECT site_status, qualified, exclusion_reasons, residential_status, residential_reason FROM companies WHERE display_name = $1`,
      [DEPOT],
    ))[0];
    expect(row?.site_status).toBeNull();
    expect(row?.qualified).toBe(false);
    expect(row?.exclusion_reasons).toEqual(['residential status unclear']);
    expect(row?.residential_status).toBeNull();
    expect(row?.residential_reason).toMatch(/not in the page cache/);
    expect(classified).not.toContain(DEPOT);
    expect(await onTab(result.report.xlsxPath, 'Qualified', DEPOT)).toBe(false);
  });
});

// ---- --live-registries ------------------------------------------------------------------------------------------

interface Spy {
  stages: StageRegistry;
  registryCalls: string[];
  /** For each registries-match call: the `offline` flag the stage's fetcher put on its request. */
  registryOffline: (boolean | undefined)[];
  siteOffline: (boolean | undefined)[];
}

/** A fetcher that never goes anywhere: it answers every GET with the `offline` flag it was asked with. */
function spyFetcher(): Fetcher {
  return {
    get: vi.fn(async (_u: string, o: { offline?: boolean }) => ({ offline: o.offline }) as never),
    post: vi.fn(async () => ({}) as never),
    session: vi.fn(() => ({ get: vi.fn(), post: vi.fn(), cookies: () => ({}) })),
    download: vi.fn(),
    robotsAllowed: vi.fn(async () => true),
    readCached: vi.fn(async () => null),
    storeRendered: vi.fn(),
    assertPublicUrl: vi.fn(async () => {}),
  } as unknown as Fetcher;
}

const offlineOf = async (f: Fetcher, source: 'websites' | 'nj_hic'): Promise<boolean | undefined> =>
  ((await f.get('https://spy.test/', { source } as never)) as unknown as { offline?: boolean }).offline;

function spyStages(): Spy {
  const fake = resolveStages({ fake: true });
  const registryCalls: string[] = [];
  const registryOffline: (boolean | undefined)[] = [];
  const siteOffline: (boolean | undefined)[] = [];
  const stages: StageRegistry = {
    ...fake,
    'site-enrich': {
      name: 'site-enrich',
      async run(ctx, company) {
        siteOffline.push(await offlineOf(ctx.fetcher, 'websites'));
        return fake['site-enrich'].run(ctx, company);
      },
    },
    'registries-match': {
      name: 'registries-match',
      async run(ctx, input: RegistryMatchInput) {
        registryCalls.push(input.company.name);
        registryOffline.push(await offlineOf(ctx.fetcher, 'nj_hic'));
        return { companyId: input.company.companyId, status: { cslb: 'matched' }, owners: 0, evidenceIds: [] };
      },
    },
  };
  return { stages, registryCalls, registryOffline, siteOffline };
}

/** Everyone matched, except: one errored, one with skipped NJ towns, and one never looked up (empty). */
async function registryStates(): Promise<{ errored: number; skipped: number; matched: number; ids: Record<string, number> }> {
  const names = { errored: ONE, skipped: 'Fake Service Area Painting', matched: 'Fake Commercial Coatings' };
  const ids: Record<string, number> = {};
  await q(db, `UPDATE companies SET registry_status = '{"nj_hic":"matched","nj_hic_active":true}'::jsonb`);
  await q(db, `UPDATE companies SET registry_status = '{}'::jsonb WHERE display_name = $1`, [NEVER]);
  for (const n of Object.values(names)) ids[n] = await idOf(n);
  await q(db, `UPDATE companies SET registry_status = $2::jsonb WHERE id = $1`, [ids[names.errored], JSON.stringify({ nj_hic: 'error' })]);
  await q(db, `UPDATE companies SET registry_status = $2::jsonb WHERE id = $1`, [ids[names.skipped], JSON.stringify({ nj_hic: 'matched', nj_roster_skipped: ['Edison'] })]);
  await q(db, `UPDATE companies SET registry_status = $2::jsonb WHERE id = $1`, [ids[names.matched], JSON.stringify({ nj_hic: 'matched', nj_hic_active: true })]);
  return { errored: ids[names.errored] as number, skipped: ids[names.skipped] as number, matched: ids[names.matched] as number, ids };
}

const registryEvidenceStatus = async (companyId: number): Promise<string[]> =>
  (await q<{ status: string }>(db, `SELECT status FROM evidence WHERE company_id = $1 AND source_type = 'nj_hic_roster' ORDER BY id`, [companyId])).map((r) => r.status);

describe('pilot reprocess --live-registries', () => {
  const livePrior = process.env.PP_LIVE;
  const restore = (): void => {
    if (livePrior === undefined) delete process.env.PP_LIVE;
    else process.env.PP_LIVE = livePrior;
  };

  it('without the flag the registries stage gets the offline fetcher, like every other stage (all companies re-run)', async () => {
    const { runId, out, env: plain } = await finished();
    const spy = spyStages();
    await reprocessRun({ ...plain, fetcher: spyFetcher() }, runId, { fake: true, outDir: out, stages: spy.stages });
    expect(spy.registryCalls.length).toBeGreaterThan(3);
    expect(spy.registryOffline.every((o) => o === true)).toBe(true);
    expect(spy.siteOffline.every((o) => o === true)).toBe(true);
  });

  it('with the flag only the registries stage gets the live fetcher; an errored, town-skipped or never-looked-up company is retried, a matched one is not', async () => {
    process.env.PP_LIVE = '1';
    try {
      const { runId, out, env: plain } = await finished();
      const { errored, skipped, matched } = await registryStates();
      const store = plain.evidence;
      const roster = (companyId: number) =>
        store.record({
          companyId,
          field: 'owner_name',
          value: 'Owner Fake',
          sourceType: 'nj_hic_roster',
          sourceUrl: 'https://njconsumeraffairs.test/roster',
          capturedAt: new Date('2026-10-25T12:00:00Z'),
          snippet: 'Owner Fake, Fake Painting',
          extractor: 'seed',
          extractorVersion: '0',
          confidence: 'high',
        });
      await roster(errored);
      await roster(matched);

      const spy = spyStages();
      const result = await reprocessRun({ ...plain, fetcher: spyFetcher() }, runId, {
        fake: true,
        outDir: out,
        stages: spy.stages,
        liveRegistries: true,
      });

      expect(spy.registryCalls.sort()).toEqual([ONE, NEVER, 'Fake Service Area Painting'].sort());
      expect(spy.registryOffline.every((o) => o === undefined || o === false)).toBe(true);
      expect(spy.registryOffline.length).toBe(3);
      expect(spy.siteOffline.length).toBeGreaterThan(0);
      expect(spy.siteOffline.every((o) => o === true)).toBe(true);

      // the retried company's old registry evidence is superseded, the matched company's is untouched
      expect(await registryEvidenceStatus(errored)).toEqual(['rejected']);
      expect(await registryEvidenceStatus(matched)).toEqual(['accepted']);
      expect(result.superseded).toBeGreaterThan(0);

      const status = async (id: number): Promise<Record<string, unknown>> =>
        (await q<{ registry_status: Record<string, unknown> }>(db, `SELECT registry_status FROM companies WHERE id = $1`, [id]))[0]?.registry_status ?? {};
      expect((await status(errored)).cslb).toBe('matched'); // the retry's answer was merged in
      expect(await status(matched)).toEqual({ nj_hic: 'matched', nj_hic_active: true });
      expect(await status(skipped)).toMatchObject({ cslb: 'matched' });
    } finally {
      restore();
    }
  });

  it('refuses without PP_LIVE=1, with a clear message, before touching anything', async () => {
    delete process.env.PP_LIVE;
    const { runId, out, env: plain } = await finished();
    const spy = spyStages();
    await expect(
      reprocessRun(plain, runId, { fake: true, outDir: out, stages: spy.stages, liveRegistries: true }),
    ).rejects.toThrow(/--live-registries.*PP_LIVE=1/);
    expect(spy.registryCalls).toEqual([]);

    const spec = pilotCommands.find((c) => c.name === 'pilot reprocess');
    expect(spec?.options?.some((o) => o.flags === '--live-registries')).toBe(true);
    const noDb = { db: () => Promise.reject(new Error('should not be reached')) } as unknown as CommandContext;
    await expect(spec?.run(noDb, [String(runId)], { liveRegistries: true })).rejects.toThrow(/PP_LIVE=1/);
  });
});
