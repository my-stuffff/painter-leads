import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbEvidenceStore, getTestDb, truncateAll, type Db, type RegistryMatchInput } from '@pp/core';
import { captureBbb, importBbb } from '../src/bbb/capture';
import { createRegistriesStage } from '../src/stage';
import { fixture, insertCompany, makeFetcher, stageContext, tempDir, testConfig } from './helpers';

const HOST = 'https://www.bbb.org';
const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } };
const CF = { headers: { 'content-type': 'text/html', server: 'cloudflare', 'cf-ray': '0000000000000000-KHI' } };
const JOHNS = `${HOST}/us/nj/basking-ridge/profile/painting-contractors/johns-painting-contractor-llc-0221-1003377`;
const NAMELESS = `${HOST}/us/nj/edison/profile/painting-contractors/nameless-painting-0221-3000001`;
const AUSTIN = `${HOST}/us/tx/austin/profile/painting-contractors/austin-professional-painting-0825-90102730`;
const BBB_ONLY = new Set(['bbb'] as const);

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

const evidence = (id: number) => new DbEvidenceStore(db).listForCompany(id);
const statusOf = async (id: number) => (await db.$client.query('SELECT registry_status FROM companies WHERE id = $1', [id])).rows[0].registry_status;

async function johns(over: Partial<RegistryMatchInput['company']> = {}): Promise<RegistryMatchInput> {
  const company = await insertCompany(db, { name: "John's Painting Contractor LLC", state: 'NJ', city: 'Basking Ridge', zip: '07920', phoneE164: '+19086048759', ...over });
  return { company, emails: [], licenceNumbers: [], websiteDomain: null };
}

/** The profile pages as Railway would have captured them. */
async function capturedFolder(): Promise<string> {
  const { fetcher, agent } = makeFetcher();
  const pool = agent.get(HOST);
  pool.intercept({ path: new URL(JOHNS).pathname, method: 'GET' }).reply(200, fixture('bbb', 'profile-johns-painting.html'), HTML);
  pool.intercept({ path: new URL(NAMELESS).pathname, method: 'GET' }).reply(200, fixture('bbb', 'profile-no-owner.html'), HTML);
  const dir = tempDir();
  await captureBbb(fetcher, { urls: [JOHNS, NAMELESS] }, dir, { now: () => new Date('2026-10-20T08:00:00Z') });
  return dir;
}

describe('BBB import of a captured folder (offline)', () => {
  it("John's Painting: strong match by phone, owner John Catapano / Owner from the JSON-LD, with profile URL and capture date; never an email", async () => {
    const dir = await capturedFolder();
    const i = await johns();
    const { fetcher, config } = makeFetcher();
    const r = await importBbb(stageContext(db, fetcher, config), dir, [i]);
    expect(r).toMatchObject({ profiles: 2, companies: 1, matched: 1, owners: 1 });
    const rows = await evidence(i.company.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ field: 'owner_name', value: 'John Catapano', sourceType: 'bbb', confidence: 'high', sourceUrl: JOHNS });
    expect(rows[0]?.capturedAt.toISOString()).toBe('2026-10-20T08:00:00.000Z');
    expect(rows[0]?.attrs).toMatchObject({ title: 'Owner', rung: 'phone' });
    expect(rows[0]?.pageSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rows.some((e) => e.field === 'email')).toBe(false);
    expect(await statusOf(i.company.companyId)).toMatchObject({ bbb: 'matched', bbb_owner: 'found' });
    const m = await db.$client.query('SELECT rung, strength FROM registry_matches WHERE company_id = $1', [i.company.companyId]);
    expect(m.rows).toEqual([{ rung: 'phone', strength: 'strong' }]);
  });

  it('a profile with no employee list and no Business Management line: matched, but no BBB owner (no_owner is not blocked)', async () => {
    const dir = await capturedFolder();
    const company = await insertCompany(db, { name: 'Nameless Painting', state: 'NJ', city: 'Edison', zip: '08817', phoneE164: '+17325550177' });
    const { fetcher, config } = makeFetcher();
    const r = await importBbb(stageContext(db, fetcher, config), dir, [{ company, emails: [], licenceNumbers: [], websiteDomain: null }]);
    expect(r).toMatchObject({ matched: 1, owners: 0 });
    expect(await evidence(company.companyId)).toHaveLength(0);
    expect(await statusOf(company.companyId)).toMatchObject({ bbb: 'matched', bbb_owner: 'none' });
  });

  it('a company that is not on any captured profile gets no evidence and status no_match', async () => {
    const dir = await capturedFolder();
    const company = await insertCompany(db, { name: 'Completely Different Roofing', state: 'NJ', city: 'Newark', zip: '07102', phoneE164: '+19735550100' });
    const { fetcher, config } = makeFetcher();
    const r = await importBbb(stageContext(db, fetcher, config), dir, [{ company, emails: [], licenceNumbers: [], websiteDomain: null }]);
    expect(r.matched).toBe(0);
    expect(await evidence(company.companyId)).toHaveLength(0);
    expect(await statusOf(company.companyId)).toMatchObject({ bbb: 'no_match' });
  });

  it('importing twice does not duplicate evidence', async () => {
    const dir = await capturedFolder();
    const i = await johns();
    const { fetcher, config } = makeFetcher();
    const ctx = stageContext(db, fetcher, config);
    await importBbb(ctx, dir, [i]);
    await importBbb(ctx, dir, [i]);
    expect(await evidence(i.company.companyId)).toHaveLength(1);
  });
});

describe('BBB in the stage (live path)', () => {
  it('from a network Cloudflare blocks: the first 403 trips the breaker, every company is "blocked", and bbb.org is asked only once', async () => {
    const config = testConfig();
    const { fetcher, agent, calls } = makeFetcher(config);
    agent.get(HOST).intercept({ path: '/robots.txt', method: 'GET' }).reply(403, fixture('bbb', 'cloudflare-403.html'), CF);
    const stage = createRegistriesStage({ only: BBB_ONLY });
    const ctx = stageContext(db, fetcher, config);
    const a = await johns();
    const b = await johns({ name: 'Another Painter', phoneE164: '+19085550111' });
    const c = await johns({ name: 'Third Painter', phoneE164: '+19085550122' });
    const results = [await stage.run(ctx, a), await stage.run(ctx, b), await stage.run(ctx, c)];
    expect(results.map((r) => r.status)).toEqual([{ bbb: 'blocked' }, { bbb: 'blocked' }, { bbb: 'blocked' }]);
    expect(calls().filter((x) => x.includes('bbb.org'))).toHaveLength(1);
    for (const i of [a, b, c]) {
      expect(await statusOf(i.company.companyId)).toMatchObject({ bbb: 'blocked' });
      expect(await evidence(i.company.companyId)).toHaveLength(0);
    }
  });

  it('where bbb.org loads: sitemaps -> profile -> match by phone; the owner is high, a manager medium', async () => {
    const config = testConfig();
    const { fetcher, agent } = makeFetcher(config);
    const pool = agent.get(HOST);
    pool.intercept({ path: '/robots.txt', method: 'GET' }).reply(200, fixture('bbb', 'robots.txt'), { headers: { 'content-type': 'text/plain' } });
    pool.intercept({ path: '/sitemap-index-business-profiles.xml', method: 'GET' }).reply(200, fixture('bbb', 'sitemap-index.xml'), HTML);
    pool.intercept({ path: '/sitemap-business-profiles-1.xml', method: 'GET' }).reply(200, fixture('bbb', 'sitemap-business-profiles-1.xml'), HTML);
    pool.intercept({ path: '/sitemap-business-profiles-2.xml', method: 'GET' }).reply(200, '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', HTML);
    pool.intercept({ path: new URL(JOHNS).pathname, method: 'GET' }).reply(200, fixture('bbb', 'profile-johns-painting.html'), HTML);
    const stage = createRegistriesStage({ only: BBB_ONLY });
    const ctx = stageContext(db, fetcher, config);
    const i = await johns();
    const r = await stage.run(ctx, i);
    expect(r).toMatchObject({ status: { bbb: 'matched' }, owners: 1 });
    expect((await evidence(i.company.companyId)).map((e) => [e.value, e.confidence, e.attrs.title])).toEqual([['John Catapano', 'high', 'Owner']]);

    // Austin: two people on the profile
    pool.intercept({ path: '/robots.txt', method: 'GET' }).reply(200, fixture('bbb', 'robots.txt'), { headers: { 'content-type': 'text/plain' } });
    pool.intercept({ path: new URL(AUSTIN).pathname, method: 'GET' }).reply(200, fixture('bbb', 'profile-austin-professional.html'), HTML);
    const austin = await insertCompany(db, { name: 'Austin Professional Painting', state: 'TX', city: 'Austin', zip: '78745', phoneE164: '+15128457821' });
    const r2 = await stage.run(ctx, { company: austin, emails: [], licenceNumbers: [], websiteDomain: null });
    expect(r2.status.bbb).toBe('matched');
    expect((await evidence(austin.companyId)).map((e) => [e.value, e.confidence])).toEqual([
      ['Aurelio Contreras', 'high'],
      ['John Contreras', 'medium'],
    ]);
  });

  it('switch off: disabled and no request', async () => {
    const config = testConfig({ bbb: { enabled: false } });
    const { fetcher, calls } = makeFetcher(config);
    const r = await createRegistriesStage({ only: BBB_ONLY }).run(stageContext(db, fetcher, config), await johns());
    expect(r.status).toEqual({ bbb: 'disabled' });
    expect(calls()).toEqual([]);
  });

  it('a company without a city cannot be looked up: no_match, no request', async () => {
    const config = testConfig();
    const { fetcher, calls } = makeFetcher(config);
    const company = await insertCompany(db, { name: 'No City Painting', state: 'NJ' });
    const r = await createRegistriesStage({ only: BBB_ONLY }).run(stageContext(db, fetcher, config), { company, emails: [], licenceNumbers: [], websiteDomain: null });
    expect(r.status.bbb).toBe('no_match');
    expect(calls()).toEqual([]);
  });
});
