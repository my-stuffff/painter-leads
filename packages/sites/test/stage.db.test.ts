import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  DbEvidenceStore,
  getTestDb,
  schema,
  truncateAll,
  type CompanyRef,
  type SiteEnrichResult,
  type Stage,
  type StageContext,
} from '@pp/core';
import { classifyStage, createSiteEnrichStage, enrichCompanies, loadCompanyRefs } from '../src/stage';
import { fakeResolver, html, loadSite, makeFetcher, serve, testConfig } from './helpers';

const { db, close } = getTestDb();
afterAll(close);
beforeEach(() => truncateAll(db));

async function seedCompany(name: string, websiteUrl: string | null, categories: string[] = ['Painter']): Promise<number> {
  const [run] = await db.insert(schema.runs).values({ areaId: 'austin_tx', state: 'TX', configSnapshot: {} }).returning({ id: schema.runs.id });
  const [company] = await db
    .insert(schema.companies)
    .values({ displayName: name, runId: run!.id, state: 'TX' })
    .returning({ id: schema.companies.id });
  const [listing] = await db
    .insert(schema.listings)
    .values({
      placeId: `place-${company!.id}`,
      profileUrl: `https://www.google.com/maps/place/${company!.id}`,
      name,
      categories,
      websiteUrl,
      websiteStatus: websiteUrl ? 'captured' : 'not_on_card',
      city: 'Austin',
      companyId: company!.id,
    })
    .returning({ id: schema.listings.id });
  await db.$client.query('UPDATE companies SET primary_listing_id = $1 WHERE id = $2', [listing!.id, company!.id]);
  return company!.id;
}

async function ref(companyId: number): Promise<CompanyRef> {
  const runId = (await db.$client.query<{ run_id: number }>('SELECT run_id FROM companies WHERE id = $1', [companyId])).rows[0]!.run_id;
  const [c] = await loadCompanyRefs(db, runId, companyId);
  return c!;
}

function serveBarton(agent: ReturnType<typeof makeFetcher>['agent']): void {
  const s = loadSite('bartonspringspainting');
  const pages: Record<string, string> = {};
  for (const p of s.pages) pages[new URL(p.url).pathname] = p.html;
  serve(agent, 'https://bartonspringspainting.com', pages);
}

function context(fetcher: StageContext['fetcher'], runId: number): StageContext {
  return {
    runId,
    config: testConfig(),
    db,
    evidence: new DbEvidenceStore(db),
    fetcher,
    log: createLogger('test'),
    now: () => new Date('2026-10-25T12:00:00Z'),
    sleep: async () => {},
  };
}

describe('site-enrich on the bartonsprings fixture', () => {
  it('records email, both owners and residential signals with page URLs and snippets, and sets site_status', async () => {
    const id = await seedCompany('Barton Springs Painting', 'https://bartonspringspainting.com');
    const company = await ref(id);
    expect(company).toMatchObject({ name: 'Barton Springs Painting', websiteUrl: 'https://bartonspringspainting.com', city: 'Austin', categories: ['Painter'] });
    const { fetcher, agent } = makeFetcher(testConfig());
    serveBarton(agent);
    const ctx = context(fetcher, 1);
    const stage = createSiteEnrichStage({ resolver: fakeResolver({ mx: ['bartonspringspainting.com'] }) });

    const result = await stage.run(ctx, company);
    expect(result).toMatchObject({ companyId: id, status: 'ok', emails: 1, owners: 2, licenceNumbers: [] });
    expect(result.pages.length).toBe(4);
    expect(result.pages.every((p) => p.sha256.length === 64 && !p.rendered)).toBe(true);
    expect(result.residentialSignals).toBeGreaterThan(5);

    const store = new DbEvidenceStore(db);
    const emails = (await store.listForCompany(id, 'email')).filter((r) => r.status === 'accepted');
    expect(emails.map((r) => [r.value, r.sourceUrl, r.attrs.method, r.attrs.kind])).toEqual([
      ['info@bartonspringspainting.com', 'https://bartonspringspainting.com/contact-us/', 'text', 'role'],
    ]);
    expect(emails[0]?.snippet).toContain('info@bartonspringspainting.com');

    const owners = (await store.listForCompany(id, 'owner_name')).filter((r) => r.status === 'accepted');
    expect(owners.map((r) => [r.value, r.attrs.title, r.sourceUrl, r.confidence])).toEqual([
      ['Jeff London', 'Founder', 'https://bartonspringspainting.com/about-us/', 'medium'],
      ['Breanna Rene', 'Owner', 'https://bartonspringspainting.com/about-us/', 'medium'],
    ]);
    for (const o of owners) expect(o.snippet).toContain(o.value);

    const signals = await store.listForCompany(id, 'residential_signal');
    expect(signals.length).toBe(result.residentialSignals);
    expect(signals.every((r) => r.sourceUrl.startsWith('https://bartonspringspainting.com') && r.snippet.length > 0 && r.pageSha256)).toBe(true);
    expect(signals.some((r) => r.value === 'residential:res:interior-painting')).toBe(true);

    const row = await db.$client.query<{ site_status: string }>('SELECT site_status FROM companies WHERE id = $1', [id]);
    expect(row.rows[0]?.site_status).toBe('ok');

    // re-running offline from the cache replaces the stage's rows (no duplicates) and needs no network or DNS
    const before = (await store.listForCompany(id)).length;
    const offline = createSiteEnrichStage({ offline: true });
    const again = await offline.run(ctx, company);
    expect(again).toMatchObject({ status: 'ok', emails: 1, owners: 2 });
    expect((await store.listForCompany(id)).length).toBe(before);
  });

  it('classify decides from the stored evidence and writes the company row', async () => {
    const id = await seedCompany('Barton Springs Painting', 'https://bartonspringspainting.com', ['Painter', 'House painter']);
    const company = await ref(id);
    const { fetcher, agent } = makeFetcher(testConfig());
    serveBarton(agent);
    const ctx = context(fetcher, 1);
    await createSiteEnrichStage({ resolver: fakeResolver({ mx: ['bartonspringspainting.com'] }) }).run(ctx, company);

    const d = await classifyStage.run(ctx, { company, njHicActive: null, siteStatus: 'ok' });
    expect(d.label).toBe('residential_and_commercial');
    expect(d.signals.some((s) => s.sourceType === 'google_maps' && s.id === 'res:category-house-painter')).toBe(true);
    expect(d.signals.some((s) => s.sourceType === 'website' && s.id === 'com:commercial-painting')).toBe(true);
    const row = await db.$client.query<{ residential_status: string; residential_reason: string }>('SELECT residential_status, residential_reason FROM companies WHERE id = $1', [id]);
    expect(row.rows[0]?.residential_status).toBe('residential_and_commercial');
    expect(row.rows[0]?.residential_reason).toContain('commercial signals');

    // the same evidence gives the same answer, and the Google rows are replaced, not duplicated
    const again = await classifyStage.run(ctx, { company, njHicActive: null, siteStatus: 'ok' });
    expect(again).toEqual(d);
    const google = (await new DbEvidenceStore(db).listForCompany(id, 'residential_signal')).filter((r) => r.sourceType === 'google_maps');
    expect(google.length).toBe(1);
  });

  it('a company with no website is recorded as no_website and classifies as unclear', async () => {
    const id = await seedCompany('No Site Painting', null, ['House painter']);
    const company = await ref(id);
    const { fetcher } = makeFetcher(testConfig());
    const ctx = context(fetcher, 1);
    const result = await createSiteEnrichStage().run(ctx, company);
    expect(result).toMatchObject({ status: 'no_website', pages: [], emails: 0, owners: 0 });
    const d = await classifyStage.run(ctx, { company, njHicActive: null, siteStatus: 'no_website' });
    expect(d).toMatchObject({ label: 'unclear', reason: 'insufficient evidence' });
  });

  it('a site that needs a browser and cannot get one is render_failed, never an empty ok', async () => {
    const id = await seedCompany('Spa Painting', 'https://spa.com');
    const company = await ref(id);
    const { fetcher, agent } = makeFetcher(testConfig());
    serve(agent, 'https://spa.com', { '/': html('<div id="root"></div>') });
    const ctx = context(fetcher, 1);
    const stage = createSiteEnrichStage({ renderer: { render: async () => Promise.reject(new Error('no browser')), close: async () => {} } });
    expect(await stage.run(ctx, company)).toMatchObject({ status: 'render_failed', emails: 0, owners: 0 });
  });
});

describe('enrichCompanies scheduling (D-16)', () => {
  const mk = (id: number, url: string | null): CompanyRef => ({
    companyId: id,
    name: `Co ${id}`,
    state: 'NJ',
    city: null,
    zip: null,
    street: null,
    websiteUrl: url,
    phoneE164: null,
    categories: [],
  });

  it('runs at most `concurrency` companies at once and never two on one domain', async () => {
    const active = new Set<string>();
    let max = 0;
    let clash = false;
    const stage: Stage<CompanyRef, SiteEnrichResult> = {
      name: 'site-enrich',
      async run(_ctx, c) {
        const key = c.websiteUrl ? new URL(c.websiteUrl).hostname.replace(/^www\./, '').replace(/^(?:a|b)\./, '') : `n${c.companyId}`;
        if (active.has(key)) clash = true;
        active.add(key);
        max = Math.max(max, active.size);
        await new Promise((r) => setTimeout(r, 15));
        active.delete(key);
        if (c.companyId === 6) throw new Error('boom');
        return { companyId: c.companyId, status: 'ok', pages: [], emails: 0, owners: 0, licenceNumbers: [], residentialSignals: 0 };
      },
    };
    const companies = [
      mk(1, 'https://acme.com'),
      mk(2, 'https://www.acme.com/about'),
      mk(3, 'https://b.acme.com'),
      mk(4, 'https://other.com'),
      mk(5, null),
      mk(6, 'https://third.com'),
      mk(7, 'https://fourth.com'),
      mk(8, 'https://fifth.com'),
    ];
    const out = await enrichCompanies(context(undefined as never, 1), stage, companies, 3);
    expect(max).toBeLessThanOrEqual(3);
    expect(max).toBeGreaterThan(1);
    expect(clash).toBe(false);
    expect(out.map((o) => o.company.companyId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(out[5]).toMatchObject({ result: null, error: 'boom' });
    expect(out.filter((o) => o.result).length).toBe(7);
  });
});
