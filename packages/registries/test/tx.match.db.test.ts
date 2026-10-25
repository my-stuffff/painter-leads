import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbEvidenceStore, getTestDb, truncateAll, type Db, type RegistryMatchInput } from '@pp/core';
import { createRegistriesStage } from '../src/stage';
import { buildTxQueryUrl } from '../src/tx/opendata';
import { fixture, insertCompany, makeFetcher, stageContext, testConfig } from './helpers';

const DATA = 'https://data.texas.gov';
const COMPTROLLER = 'https://comptroller.texas.gov';
const JSON_HEADERS = { headers: { 'content-type': 'application/json' } };
const TX_ONLY = new Set(['tx_open_data', 'tx_comptroller'] as const);

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

async function input(name: string, zip: string, city = 'Round Rock'): Promise<RegistryMatchInput> {
  const company = await insertCompany(db, { name, state: 'TX', city, zip });
  return { company, emails: [], licenceNumbers: [], websiteDomain: null };
}

function setup(over: Parameters<typeof testConfig>[0] = {}) {
  const config = testConfig(over);
  const f = makeFetcher(config);
  const open = (zip: string, token: string, body: string | unknown[]) =>
    f.agent
      .get(DATA)
      .intercept({ path: buildTxQueryUrl({ zip, nameToken: token }).replace(DATA, ''), method: 'GET' })
      .reply(200, typeof body === 'string' ? body : JSON.stringify(body), JSON_HEADERS);
  const run = (i: RegistryMatchInput) => createRegistriesStage({ only: TX_ONLY }).run(stageContext(db, f.fetcher, config), i);
  return { ...f, open, run };
}

const evidence = (id: number) => new DbEvidenceStore(db).listForCompany(id);

describe('Texas with the Comptroller switch OFF (default)', () => {
  it('taxpayer from open data is matched; tx_comptroller is disabled and comptroller.texas.gov gets no request', async () => {
    const t = setup();
    t.open('78665', 'COUNTRY', fixture('tx', 'opendata-78665-hill-country.json'));
    const i = await input('Hill Country Painting', '78665');
    const r = await t.run(i);
    expect(r.status).toEqual({ tx_open_data: 'matched', tx_comptroller: 'disabled' });
    expect(r.owners).toBe(0);
    const rows = await evidence(i.company.companyId);
    expect(rows.map((e) => [e.field, e.value, e.sourceType, e.confidence])).toEqual([
      ['tx_taxpayer_number', '32072442869', 'tx_open_data', 'high'],
      ['registry_legal_name', 'HILL COUNTRY PAINTING LLC', 'tx_open_data', 'high'],
    ]);
    expect(rows[0]?.sourceUrl).toMatch(/^https:\/\/data\.texas\.gov\/resource\/9cir-efmm\.json\?/);
    expect(rows[0]?.snippet).toContain('taxpayer_number=32072442869');
    expect(t.calls().filter((c) => c.includes('comptroller.texas.gov'))).toEqual([]);
    const st = await db.$client.query('SELECT registry_status FROM companies WHERE id = $1', [i.company.companyId]);
    expect(st.rows[0].registry_status).toMatchObject({ tx_open_data: 'matched', tx_taxpayer: '32072442869', tx_comptroller: 'disabled' });
  });

  it('a brand name with no entity in the open data: no_match, no evidence, no Comptroller request', async () => {
    const t = setup();
    t.open('78704', 'SPRINGS', []);
    const i = await input('Barton Springs Painting', '78704', 'Austin');
    const r = await t.run(i);
    expect(r.status).toEqual({ tx_open_data: 'no_match', tx_comptroller: 'disabled' });
    expect(await evidence(i.company.companyId)).toHaveLength(0);
    expect(t.calls().filter((c) => c.includes('comptroller'))).toEqual([]);
  });

  it('a name-only hit (the entity name is longer) is a candidate: matches row, no evidence, no Comptroller request', async () => {
    const t = setup();
    t.open('78665', 'COUNTRY', fixture('tx', 'opendata-78665-hill-country.json'));
    const i = await input('Hill Country Painting and Repair', '78665');
    const r = await t.run(i);
    expect(r.status.tx_open_data).toBe('candidate_only');
    expect(await evidence(i.company.companyId)).toHaveLength(0);
    const m = await db.$client.query('SELECT strength FROM registry_matches WHERE company_id = $1', [i.company.companyId]);
    expect(m.rows).toEqual([{ strength: 'candidate' }]);
    expect(t.calls().filter((c) => c.includes('comptroller'))).toEqual([]);
  });

  it('a company without a ZIP cannot be searched: no_match and no request at all', async () => {
    const t = setup();
    const company = await insertCompany(db, { name: 'Hill Country Painting', state: 'TX', city: 'Round Rock' });
    const r = await t.run({ company, emails: [], licenceNumbers: [], websiteDomain: null });
    expect(r.status.tx_open_data).toBe('no_match');
    expect(t.calls()).toEqual([]);
  });

  it('open data switch off: disabled, no request', async () => {
    const t = setup({ tx_open_data: { enabled: false } });
    const i = await input('Hill Country Painting', '78665');
    const r = await t.run(i);
    expect(r.status).toEqual({ tx_open_data: 'disabled', tx_comptroller: 'disabled' });
    expect(t.calls()).toEqual([]);
  });
});

describe('Texas with the Comptroller switch on (test config only)', () => {
  it('strong match: the officers become owner candidates with titles; the corporate agent is not one', async () => {
    const t = setup({ tx_comptroller: { enabled: true } });
    t.open('78665', 'COUNTRY', fixture('tx', 'opendata-78665-hill-country.json'));
    t.agent.get(COMPTROLLER).intercept({ path: '/data-search/franchise-tax/32072442869', method: 'GET' }).reply(200, fixture('tx', 'comptroller-hill-country.json'), JSON_HEADERS);
    const i = await input('Hill Country Painting LLC', '78665');
    const r = await t.run(i);
    expect(r.status).toEqual({ tx_open_data: 'matched', tx_comptroller: 'matched' });
    expect(r.owners).toBe(3);
    const owners = (await evidence(i.company.companyId)).filter((e) => e.field === 'owner_name');
    expect(owners.map((o) => o.value)).toEqual(['Forrest Jensen', 'Josh Cross', 'Justin Carter']);
    expect(owners.every((o) => o.sourceType === 'tx_comptroller' && o.confidence === 'high')).toBe(true);
    expect(owners[0]?.attrs).toMatchObject({ title: 'MEMBER', titles: ['DIRECTOR', 'MEMBER'], taxpayerNumber: '32072442869' });
    expect(owners[0]?.sourceUrl).toBe(`${COMPTROLLER}/data-search/franchise-tax/32072442869`);
    expect(owners[0]?.snippet).toContain('AGNT_NM=FORREST JENSEN');
    expect(owners.some((o) => /agent/i.test(o.value))).toBe(false);
    expect(JSON.stringify(owners.map((o) => o.snippet))).not.toMatch(/REDACTED|CHERRY COURT|SATELLITE/);

    // re-run: nothing is requested again and nothing is duplicated
    const before = t.calls().length;
    const again = await t.run(i);
    expect(again.status.tx_comptroller).toBe('matched');
    expect(t.calls().length).toBe(before); // the open-data query is answered from the page cache; the owners are already stored
    expect((await evidence(i.company.companyId)).filter((e) => e.field === 'owner_name')).toHaveLength(3);
  });

  it('an entity with no officers gives no_match for the Comptroller (never an owner from the agent)', async () => {
    const t = setup({ tx_comptroller: { enabled: true } });
    t.agent.get(COMPTROLLER).intercept({ path: '/data-search/franchise-tax/32096453066', method: 'GET' }).reply(200, fixture('tx', 'comptroller-hill-country-repair.json'), JSON_HEADERS);
    const i = await input('Hill Country Painting and Repair', '78621', 'Elgin');
    // the distinctive token of this name is COUNTRY
    t.open('78621', 'COUNTRY', [
      { taxpayer_number: '32096453066', taxpayer_name: 'HILL COUNTRY PAINTING AND REPAIR LLC', taxpayer_city: 'ELGIN', taxpayer_zip: '78621', right_to_transact_business_code: 'N', sos_status_code: 'F' },
    ]);
    const r = await t.run(i);
    expect(r.status).toEqual({ tx_open_data: 'matched', tx_comptroller: 'no_match' });
    expect(r.owners).toBe(0);
    expect((await evidence(i.company.companyId)).some((e) => e.field === 'owner_name')).toBe(false);
  });

  it('with robots.txt respected the lookup is "blocked" (the real file disallows /data-search/), never "no owner"', async () => {
    const t = setup({ tx_comptroller: { enabled: true, robots: 'respect' } });
    t.open('78665', 'COUNTRY', fixture('tx', 'opendata-78665-hill-country.json'));
    t.agent.get(COMPTROLLER).intercept({ path: '/robots.txt', method: 'GET' }).reply(200, fixture('tx', 'comptroller-robots.txt'), { headers: { 'content-type': 'text/plain' } });
    const i = await input('Hill Country Painting LLC', '78665');
    const r = await t.run(i);
    expect(r.status.tx_comptroller).toBe('blocked');
    expect(t.calls().filter((c) => c.includes('/data-search/'))).toEqual([]);
  });

  it('a failing Comptroller answer is an error for that source; the open-data evidence stays', async () => {
    const t = setup({ tx_comptroller: { enabled: true } });
    t.open('78665', 'COUNTRY', fixture('tx', 'opendata-78665-hill-country.json'));
    t.agent.get(COMPTROLLER).intercept({ path: '/data-search/franchise-tax/32072442869', method: 'GET' }).reply(500, 'boom');
    const i = await input('Hill Country Painting LLC', '78665');
    const r = await t.run(i);
    expect(r.status).toEqual({ tx_open_data: 'matched', tx_comptroller: 'error' });
    expect((await evidence(i.company.companyId)).some((e) => e.field === 'tx_taxpayer_number')).toBe(true);
  });
});
