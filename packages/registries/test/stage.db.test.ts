import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll, type Db } from '@pp/core';
import { loadCslbMaster } from '../src/cslb/master';
import { resetRosterQueue } from '../src/nj/roster-ensure';
import { loadNjRosterRows, parseNjRoster } from '../src/nj/roster-parse';
import { createRegistriesStage } from '../src/stage';
import { buildTxQueryUrl } from '../src/tx/opendata';
import { FIXTURES, fixture, insertCompany, makeFetcher, stageContext, tempDir, testConfig } from './helpers';
import { mockDetailFlow, mockPrincipalFlow } from './nj-detail-mocks';

const CAPTURED = new Date('2026-10-25T12:00:00Z');
const JSON_HEADERS = { headers: { 'content-type': 'application/json' } };
const CF = { headers: { 'content-type': 'text/html', server: 'cloudflare', 'cf-ray': '0000000000000000-KHI' } };
const saved = process.env.PP_DATA_DIR;

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
  resetRosterQueue();
  const dir = path.join(tempDir(), 'downloads', 'nj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'tinton-falls-2026-10-25.txt'), '');
  process.env.PP_DATA_DIR = path.dirname(path.dirname(dir));
});
afterEach(() => {
  if (saved === undefined) delete process.env.PP_DATA_DIR;
  else process.env.PP_DATA_DIR = saved;
});

describe('registriesMatchStage for one California, one New Jersey and one Texas company', () => {
  it('gets per-source statuses: cslb / NJ trio / TX open data matched, tx_comptroller disabled, bbb blocked by the 403 fixture', async () => {
    await loadCslbMaster(db, path.join(FIXTURES, 'cslb', 'master-sample.csv'), { capturedAt: CAPTURED });
    const spectra =
      'SPECTRA PAINTING, INC|||||Home Improvement Contractors|Home Improvement Business Contr|13VH06161800|3/7/2011|3/31/2027|65 Reeds Rd||Tinton Falls|NJ|07724|Monmouth|spectra@spectra-example.test|Active|';
    await loadNjRosterRows(db, parseNjRoster(`${fixture('nj', 'nj-roster-synthetic.txt')}${spectra}\n`), { capturedAt: CAPTURED });

    const config = testConfig(); // tx_comptroller is off in pp.config.json
    const { fetcher, agent, calls } = makeFetcher(config);
    mockDetailFlow(agent, 'spectra');
    mockPrincipalFlow(agent, true);
    agent
      .get('https://data.texas.gov')
      .intercept({ path: buildTxQueryUrl({ zip: '78665', nameToken: 'COUNTRY' }).replace('https://data.texas.gov', ''), method: 'GET' })
      .reply(200, fixture('tx', 'opendata-78665-hill-country.json'), JSON_HEADERS);
    agent.get('https://www.bbb.org').intercept({ path: '/robots.txt', method: 'GET' }).reply(403, fixture('bbb', 'cloudflare-403.html'), CF);

    const ca = await insertCompany(db, { name: 'Cabrales Painting', state: 'CA', city: 'San Jose', zip: '95133', phoneE164: '+14083983805' });
    const nj = await insertCompany(db, { name: 'Spectra Painting', state: 'NJ', city: 'Tinton Falls', zip: '07724' });
    const tx = await insertCompany(db, { name: 'Hill Country Painting', state: 'TX', city: 'Round Rock', zip: '78665' });
    const stage = createRegistriesStage(); // one instance: the BBB breaker is shared by the three companies
    const ctx = stageContext(db, fetcher, config);
    const inputs = [ca, nj, tx].map((company) => ({ company, emails: [], licenceNumbers: [], websiteDomain: null }));
    const [rCa, rNj, rTx] = [await stage.run(ctx, inputs[0]!), await stage.run(ctx, inputs[1]!), await stage.run(ctx, inputs[2]!)];

    expect(rCa).toMatchObject({ companyId: ca.companyId, status: { cslb: 'matched', bbb: 'blocked' }, owners: 1 });
    expect(rNj).toMatchObject({ status: { nj_hic_roster: 'matched', nj_hic_detail: 'matched', nj_principal_search: 'matched', bbb: 'blocked' }, owners: 1 });
    expect(rTx).toMatchObject({ status: { tx_open_data: 'matched', tx_comptroller: 'disabled', bbb: 'blocked' }, owners: 0 });

    // the Comptroller got nothing; bbb.org was asked exactly once for the whole run
    expect(calls().filter((c) => c.includes('comptroller.texas.gov'))).toEqual([]);
    expect(calls().filter((c) => c.includes('bbb.org'))).toHaveLength(1);

    for (const [c, key] of [
      [ca, 'cslb'],
      [nj, 'nj_hic'],
      [tx, 'tx_open_data'],
    ] as const) {
      const st = await db.$client.query('SELECT registry_status FROM companies WHERE id = $1', [c.companyId]);
      expect(st.rows[0].registry_status).toMatchObject({ [key]: 'matched', bbb: 'blocked' });
    }
    // every piece of evidence carries its provenance
    const all = await db.$client.query('SELECT count(*)::int AS n, count(*) FILTER (WHERE source_url = \'\' OR snippet = \'\' OR extractor = \'\') AS bad FROM evidence');
    expect(all.rows[0].n).toBeGreaterThan(15);
    expect(Number(all.rows[0].bad)).toBe(0);
  });

  it('every source switch off: each source reports disabled and nothing is requested', async () => {
    const off = (['cslb', 'nj_hic_roster', 'nj_hic_detail', 'nj_principal_search', 'tx_open_data', 'tx_comptroller', 'bbb'] as const).reduce(
      (acc, id) => ({ ...acc, [id]: { enabled: false } }),
      {},
    );
    const config = testConfig(off);
    const { fetcher, calls } = makeFetcher(config);
    const stage = createRegistriesStage();
    const ctx = stageContext(db, fetcher, config);
    const mk = async (state: 'CA' | 'NJ' | 'TX') => ({ company: await insertCompany(db, { name: 'Any Painting', state, city: 'Town', zip: '12345' }), emails: [], licenceNumbers: [], websiteDomain: null });
    expect((await stage.run(ctx, await mk('CA'))).status).toEqual({ cslb: 'disabled', bbb: 'disabled' });
    expect((await stage.run(ctx, await mk('NJ'))).status).toEqual({ nj_hic_roster: 'disabled', nj_hic_detail: 'not_applicable', nj_principal_search: 'not_applicable', bbb: 'disabled' });
    expect((await stage.run(ctx, await mk('TX'))).status).toEqual({ tx_open_data: 'disabled', tx_comptroller: 'disabled', bbb: 'disabled' });
    expect(calls()).toEqual([]);
  });

  it('--source: only the chosen source runs', async () => {
    const config = testConfig();
    const { fetcher, calls } = makeFetcher(config);
    const stage = createRegistriesStage({ only: new Set(['bbb']) });
    const company = await insertCompany(db, { name: 'Any Painting', state: 'TX' });
    const r = await stage.run(stageContext(db, fetcher, config), { company, emails: [], licenceNumbers: [], websiteDomain: null });
    expect(Object.keys(r.status)).toEqual(['bbb']);
    expect(calls()).toEqual([]); // no city: nothing to look up
  });
});
