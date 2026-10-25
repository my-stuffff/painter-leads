import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DbEvidenceStore, getTestDb, schema, truncateAll } from '@pp/core';
import { checkMailDomain } from '../src/emails/mx';
import { extractEmails } from '../src/emails/extract';
import { emailDrafts, mailDomainChecks } from '../src/evidence';
import { fakeResolver, loadSite } from './helpers';

const { db, close } = getTestDb();
afterAll(close);
beforeEach(() => truncateAll(db));

async function company(name: string): Promise<number> {
  const [row] = await db.insert(schema.companies).values({ displayName: name }).returning({ id: schema.companies.id });
  return row!.id;
}

describe('email evidence rows', () => {
  it('stores one row per address and page with page URL, snippet and method; rejected rows keep their reason', async () => {
    const id = await company('John Paint');
    const s = loadSite('johnspaint');
    const findings = extractEmails(s.pages, { websiteUrl: s.websiteUrl });
    const checks = await mailDomainChecks(findings, fakeResolver({ mx: ['johnspaintingnj.com'] }), db);
    const store = new DbEvidenceStore(db);
    await store.recordMany(emailDrafts(findings, { companyId: id, capturedAt: new Date('2026-10-25T12:00:00Z'), checks }));

    const rows = await store.listForCompany(id, 'email');
    const accepted = rows.filter((r) => r.status === 'accepted');
    expect(accepted.length).toBe(s.pages.length);
    expect(new Set(accepted.map((r) => r.value))).toEqual(new Set(['johnspaint@hotmail.com']));
    for (const r of accepted) {
      expect(r).toMatchObject({ sourceType: 'website', extractor: 'sites/emails', confidence: 'high' });
      expect(r.sourceUrl.startsWith('https://www.johnspaint.com')).toBe(true);
      expect(r.pageSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.snippet.length).toBeGreaterThan(0);
      expect(r.attrs.method).toBe('mailto');
      expect(r.attrs.kind).toBe('other');
    }
    const rejected = rows.filter((r) => r.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    expect(new Set(rejected.map((r) => r.value))).toEqual(new Set(['office@johnspaintingnj.com']));
    expect(new Set(rejected.map((r) => r.rejectReason))).toEqual(new Set(['off-domain, not free-mail']));
  });

  it('a site with no email stores no email evidence at all', async () => {
    const id = await company('Rutgers');
    const s = loadSite('rutgerspainting');
    const findings = extractEmails(s.pages, { websiteUrl: s.websiteUrl });
    await new DbEvidenceStore(db).recordMany(emailDrafts(findings, { companyId: id, capturedAt: new Date() }));
    expect(await new DbEvidenceStore(db).listForCompany(id, 'email')).toEqual([]);
  });

  it('bundle-only addresses are medium confidence; role addresses are marked role', async () => {
    const id = await company('Acme');
    const findings = extractEmails([], { websiteUrl: 'https://acme.com' }, [{ url: 'https://acme.com/a.js', text: 'e="info@acme.com"' }]);
    await new DbEvidenceStore(db).recordMany(emailDrafts(findings, { companyId: id, capturedAt: new Date() }));
    const [row] = await new DbEvidenceStore(db).listForCompany(id, 'email');
    expect(row).toMatchObject({ value: 'info@acme.com', confidence: 'medium', status: 'accepted' });
    expect(row?.attrs).toMatchObject({ method: 'bundle', kind: 'role' });
  });
});

describe('mail-domain check with the dns_checks cache', () => {
  it('caches results, so a second lookup does not touch DNS', async () => {
    const r = fakeResolver({ mx: ['acme.com'], nullMx: ['nomail.com'] });
    expect(await checkMailDomain('acme.com', r, db)).toMatchObject({ result: 'mx', fromCache: false });
    expect(await checkMailDomain('acme.com', r, db)).toMatchObject({ result: 'mx', accept: true, fromCache: true });
    expect(await checkMailDomain('nomail.com', r, db)).toMatchObject({ result: 'null_mx' });
    const calls = r.calls.length;
    expect(await checkMailDomain('nomail.com', r, db)).toMatchObject({ result: 'null_mx', accept: false, fromCache: true });
    expect(r.calls.length).toBe(calls);
    const rows = await db.select().from(schema.dnsChecks);
    expect(rows.map((x) => x.result).sort()).toEqual(['mx', 'null_mx']);
  });

  it('does not cache lookup errors, and cache-only mode answers from the cache', async () => {
    const flaky = fakeResolver({ broken: ['flaky.com'] });
    expect(await checkMailDomain('flaky.com', flaky, db)).toMatchObject({ result: 'error', needsReview: true });
    expect(await db.select().from(schema.dnsChecks)).toEqual([]);

    await checkMailDomain('acme.com', fakeResolver({ mx: ['acme.com'] }), db);
    const none = fakeResolver();
    expect(await checkMailDomain('acme.com', none, db, { cacheOnly: true })).toMatchObject({ result: 'mx', fromCache: true });
    expect(none.calls).toEqual([]);
  });

  it('a null-MX or missing domain turns an accepted-looking address into a rejected row; a lookup error into needs_review', async () => {
    const id = await company('Acme');
    const page = { url: 'https://acme.com/', rendered: false, html: '<p>a@acme.com</p>' };
    const findings = extractEmails([page], { websiteUrl: 'https://acme.com' });
    const store = new DbEvidenceStore(db);

    const nullMx = await mailDomainChecks(findings, fakeResolver({ nullMx: ['acme.com'] }), db);
    await store.recordMany(emailDrafts(findings, { companyId: id, capturedAt: new Date(), checks: nullMx }));
    await truncateAll(db);
    const id2 = await company('Acme 2');
    const broken = await mailDomainChecks(findings, fakeResolver({ broken: ['acme.com'] }), db);
    await store.recordMany(emailDrafts(findings, { companyId: id2, capturedAt: new Date(), checks: broken }));
    const [row] = await store.listForCompany(id2, 'email');
    expect(row).toMatchObject({ status: 'needs_review', confidence: 'low', rejectReason: 'mx check error' });
    expect(nullMx.get('acme.com')?.result).toBe('null_mx');
    const rejected = emailDrafts(findings, { companyId: id, capturedAt: new Date(), checks: nullMx })[0];
    expect(rejected).toMatchObject({ status: 'rejected', rejectReason: 'null MX (domain does not accept mail)' });
  });
});
