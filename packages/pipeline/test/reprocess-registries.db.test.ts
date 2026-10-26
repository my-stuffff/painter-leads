import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll, type StageRegistry } from '@pp/core';
import { createRegistriesStage } from '@pp/registries';
import { resetRosterQueue } from '../../registries/src/nj/roster-ensure';
import { loadNjRosterRows, parseNjRoster } from '../../registries/src/nj/roster-parse';
import { fixture, makeFetcher, testConfig, tempDir as regTempDir } from '../../registries/test/helpers';
import { mockDetailFlow, mockPrincipalFlow } from '../../registries/test/nj-detail-mocks';
import { enrichCompanies } from '../src/enrich';
import { stageContext } from '../src/env';
import { MASTER_COLUMNS, QUALIFIED_COLUMNS } from '../src/report/columns';
import { reprocessRun } from '../src/reprocess';
import { q } from '../src/sql';
import { resolveStages } from '../src/stages';
import { makeEnv, readSheets, tempDir } from './helpers';
import { pointOf, prepareRun, seedListing, seedRun } from './seed';

/**
 * The run-8 sequence (Edison, 2026-10): a company is matched to its NJ registration, its owner is read from the HIC
 * detail page, then `pilot reprocess` (cache-only: the detail page is an offline miss) and `--live-registries` run.
 * The registry values it had must survive every pass; only a value that really changed may be replaced.
 */
const handle = getTestDb();
const db = handle.db;
const saved = { dataDir: process.env.PP_DATA_DIR, live: process.env.PP_LIVE };
const CAPTURED = new Date('2026-10-25T12:00:00Z');
const NAME = 'Spectra Painting';
const NJ_ONLY = new Set(['nj_hic_roster', 'nj_hic_detail', 'nj_principal_search'] as const);

/** The real Spectra registration, but in Edison, so the run's own town roster is the one that holds it. */
const spectraEdison =
  'SPECTRA PAINTING, INC|||||Home Improvement Contractors|Home Improvement Business Contr|13VH06161800|3/7/2011|3/31/2027|65 Reeds Rd||Edison|NJ|08817|Middlesex|spectra@spectra-example.test|Active|';

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
  resetRosterQueue();
  const dir = path.join(regTempDir(), 'downloads', 'nj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'edison-2026-10-25.txt'), '');
  process.env.PP_DATA_DIR = path.dirname(path.dirname(dir));
  await loadNjRosterRows(db, parseNjRoster(`${fixture('nj', 'nj-roster-synthetic.txt')}${spectraEdison}\n`), { capturedAt: CAPTURED });
});
afterEach(() => {
  for (const [k, v] of [['PP_DATA_DIR', saved.dataDir], ['PP_LIVE', saved.live]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const config = testConfig();
const registries = (): StageRegistry => ({ ...resolveStages({ fake: true }), 'registries-match': createRegistriesStage({ only: NJ_ONLY }) });

async function setup(): Promise<{ runId: number; companyId: number; out: string; first: ReturnType<typeof makeFetcher> }> {
  const env = makeEnv(db, { config });
  const runId = await seedRun(db);
  const pin = pointOf(config, 'edison_nj', '08817');
  await seedListing(db, env.evidence, runId, { key: 'spectra', name: NAME, rating: 4.9, reviews: 25, phone: '+17325550199', street: '65 Reeds Rd', city: 'Edison', zip: '08817', ...pin });
  const ids = await prepareRun(env, runId);
  const companyId = ids.get(NAME) as number;

  // first run: roster match + owner from the detail page + principal check, all live (mocked)
  const first = makeFetcher(config);
  mockDetailFlow(first.agent, 'spectra');
  mockPrincipalFlow(first.agent, true);
  await enrichCompanies(stageContext({ ...env, fetcher: first.fetcher }, runId), registries(), runId, { steps: new Set(['registries-match']) });
  return { runId, companyId, out: tempDir(), first };
}

interface Row {
  field: string;
  source_type: string;
  value: string;
  status: string;
  reject_reason: string | null;
}
const rowsOf = (companyId: number): Promise<Row[]> =>
  q<Row>(db, `SELECT field, source_type, value, status, reject_reason FROM evidence WHERE company_id = $1 AND source_type LIKE 'nj_%' ORDER BY id`, [companyId]);
const accepted = async (companyId: number): Promise<string[]> =>
  (await rowsOf(companyId)).filter((r) => r.status === 'accepted').map((r) => `${r.source_type}/${r.field}=${r.value}`).sort();

const ACCEPTED_AFTER_FIRST_RUN = [
  'nj_hic_detail/owner_name=Eric Doeler',
  'nj_hic_roster/email=spectra@spectra-example.test',
  'nj_hic_roster/licence_expiry=2027-03-31',
  'nj_hic_roster/licence_number=13VH06161800',
  'nj_hic_roster/licence_status=Active',
  'nj_hic_roster/registry_legal_name=SPECTRA PAINTING, INC',
  'nj_principal_search/owner_name=Eric Doeler',
];

/** What the xlsx shows for the company: [qualified?, owner, email]. */
async function sheetsOf(xlsx: string): Promise<{ master: unknown[]; qualified: unknown[] | undefined }> {
  const sheets = await readSheets(xlsx);
  const owner = MASTER_COLUMNS.indexOf('Owner / decision-maker');
  const email = MASTER_COLUMNS.indexOf('Email');
  const row = (sheets['Master list'] as unknown[][]).find((r) => r[0] === NAME) ?? [];
  const qualified = (sheets['Qualified'] as unknown[][]).slice(1).find((r) => r[0] === NAME);
  expect(QUALIFIED_COLUMNS.indexOf('Owner / decision-maker')).toBe(owner);
  return { master: [row[owner], row[email]], qualified };
}

describe('pilot reprocess keeps registry evidence (run 8)', () => {
  it('captures the licence, the roster email and the detail owner on the first run', async () => {
    const { companyId } = await setup();
    expect(await accepted(companyId)).toEqual(ACCEPTED_AFTER_FIRST_RUN);
  });

  it('cache-only reprocess with the detail page missing from the cache: nothing is lost, in the data or in the report', async () => {
    const { runId, companyId, out } = await setup();
    const offline = makeFetcher(config); // a cache that never saw the detail page
    const result = await reprocessRun({ ...makeEnv(db, { config }), fetcher: offline.fetcher }, runId, {
      stages: registries(),
      steps: new Set(['registries-match']),
      outDir: out,
    });

    expect(await accepted(companyId)).toEqual(ACCEPTED_AFTER_FIRST_RUN);
    expect(offline.calls()).toEqual([]); // no request went out
    const status = (await q<{ registry_status: Record<string, unknown> }>(db, `SELECT registry_status FROM companies WHERE id = $1`, [companyId]))[0]?.registry_status;
    expect(status).toMatchObject({ nj_hic: 'matched', nj_hic_detail: 'matched' });
    const { master, qualified } = await sheetsOf(result.report.xlsxPath);
    expect(master).toEqual(['Eric Doeler', 'spectra@spectra-example.test']);
    expect(qualified).toBeDefined();
  });

  it('then --live-registries reprocess: the principal check that could not run offline is retried, nothing is lost', async () => {
    const { runId, companyId, out } = await setup();
    const env = makeEnv(db, { config });
    await reprocessRun({ ...env, fetcher: makeFetcher(config).fetcher }, runId, { stages: registries(), steps: new Set(['registries-match']), outDir: out });
    const status = async (): Promise<Record<string, unknown>> =>
      (await q<{ registry_status: Record<string, unknown> }>(db, `SELECT registry_status FROM companies WHERE id = $1`, [companyId]))[0]?.registry_status ?? {};
    expect(await status()).toMatchObject({ nj_hic_detail: 'matched', nj_principal_search: 'error' });

    process.env.PP_LIVE = '1';
    const live = makeFetcher(config);
    mockDetailFlow(live.agent, 'spectra');
    mockPrincipalFlow(live.agent, true);
    const result = await reprocessRun({ ...env, fetcher: live.fetcher }, runId, {
      stages: registries(),
      steps: new Set(['registries-match']),
      outDir: out,
      liveRegistries: true,
    });

    expect(await accepted(companyId)).toEqual(ACCEPTED_AFTER_FIRST_RUN);
    expect(await status()).toMatchObject({ nj_hic: 'matched', nj_hic_detail: 'matched', nj_principal_search: 'matched' });
    expect((await sheetsOf(result.report.xlsxPath)).master).toEqual(['Eric Doeler', 'spectra@spectra-example.test']);
  });

  it('a live retry whose requests fail keeps every earlier value', async () => {
    const { runId, companyId, out } = await setup();
    const env = makeEnv(db, { config });
    await reprocessRun({ ...env, fetcher: makeFetcher(config).fetcher }, runId, { stages: registries(), steps: new Set(['registries-match']), outDir: out });

    process.env.PP_LIVE = '1';
    const live = makeFetcher(config);
    mockDetailFlow(live.agent, 'spectra', { drop: 'detail500' }); // the detail page answers HTTP 500; the principal site is unreachable
    const result = await reprocessRun({ ...env, fetcher: live.fetcher }, runId, {
      stages: registries(),
      steps: new Set(['registries-match']),
      outDir: out,
      liveRegistries: true,
    });

    expect(live.calls().length).toBeGreaterThan(0); // it did try
    expect(await accepted(companyId)).toEqual(ACCEPTED_AFTER_FIRST_RUN);
    expect((await sheetsOf(result.report.xlsxPath)).master).toEqual(['Eric Doeler', 'spectra@spectra-example.test']);
  });

  it('a registry value that really changed wins: the new owner is accepted, the old one stays superseded', async () => {
    const { runId, companyId, out } = await setup();
    const env = makeEnv(db, { config });
    await reprocessRun({ ...env, fetcher: makeFetcher(config).fetcher }, runId, { stages: registries(), steps: new Set(['registries-match']), outDir: out });

    // the registry now shows another owner
    process.env.PP_LIVE = '1';
    const live = makeFetcher(config);
    mockDetailFlow(live.agent, 'spectra', { ownerName: 'Erica Doeler' });
    mockPrincipalFlow(live.agent, true);
    const result = await reprocessRun({ ...env, fetcher: live.fetcher }, runId, {
      stages: registries(),
      steps: new Set(['registries-match']),
      outDir: out,
      liveRegistries: true,
    });

    const rows = await rowsOf(companyId);
    expect(rows.filter((r) => r.field === 'owner_name' && r.status === 'accepted').map((r) => `${r.source_type}=${r.value}`).sort()).toEqual([
      'nj_hic_detail=Erica Doeler',
      'nj_principal_search=Erica Doeler',
    ]);
    const old = rows.filter((r) => r.value === 'Eric Doeler');
    expect(old.length).toBeGreaterThanOrEqual(2); // history: every earlier copy stays, retired
    expect(old.every((r) => r.status === 'rejected' && r.reject_reason === 'superseded')).toBe(true);
    // the roster rows are unchanged and still accepted
    expect((await accepted(companyId)).filter((a) => a.startsWith('nj_hic_roster/'))).toEqual(ACCEPTED_AFTER_FIRST_RUN.filter((a) => a.startsWith('nj_hic_roster/')));
    expect((await sheetsOf(result.report.xlsxPath)).master).toEqual(['Erica Doeler', 'spectra@spectra-example.test']);
  });
});
