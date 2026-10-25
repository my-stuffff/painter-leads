import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, DbEvidenceStore, getTestDb, loadConfig, schema, truncateAll, type EvidenceDraft, type StageContext } from '@pp/core';
import { siteFinalizeStage, templateNameIds } from '../src/owners/template';

const { db, close } = getTestDb();
afterAll(close);
beforeEach(() => truncateAll(db));

async function run(): Promise<number> {
  const [r] = await db.insert(schema.runs).values({ areaId: 'edison_nj', state: 'NJ', configSnapshot: {} }).returning({ id: schema.runs.id });
  return r!.id;
}

async function company(runId: number, name: string, franchiseBrand: string | null = null): Promise<number> {
  const [c] = await db
    .insert(schema.companies)
    .values({ displayName: name, runId, franchise: franchiseBrand !== null, franchiseBrand })
    .returning({ id: schema.companies.id });
  return c!.id;
}

const owner = (companyId: number, name: string, url: string, status: EvidenceDraft['status'] = 'accepted'): EvidenceDraft => ({
  companyId,
  field: 'owner_name',
  value: name,
  sourceType: 'website',
  sourceUrl: url,
  capturedAt: new Date('2026-10-25T12:00:00Z'),
  snippet: `${name} / Owner`,
  extractor: 'sites/owners',
  extractorVersion: '1',
  confidence: 'medium',
  status,
});

function ctx(runId: number): StageContext {
  return {
    runId,
    config: loadConfig(),
    db,
    evidence: new DbEvidenceStore(db),
    fetcher: undefined as never,
    log: createLogger('test'),
    now: () => new Date(),
    sleep: async () => {},
  };
}

describe('site-finalize: template names (D-18)', () => {
  it('rejects a person claimed as owner on two different registrable domains, everywhere', async () => {
    const runId = await run();
    const a = await company(runId, 'Alpha Painting');
    const b = await company(runId, 'Beta Painting');
    const c = await company(runId, 'Gamma Painting');
    const store = new DbEvidenceStore(db);
    await store.recordMany([
      owner(a, 'Brennan Price', 'https://alpha.com/about'),
      owner(b, 'Brennan Price', 'https://beta.com/team'),
      owner(c, 'Real Person', 'https://gamma.com/about'),
    ]);

    const out = await siteFinalizeStage.run(ctx(runId), { runId });
    expect(out).toEqual({ templateNamesRejected: 2 });
    const rows = [...(await store.listForCompany(a, 'owner_name')), ...(await store.listForCompany(b, 'owner_name'))];
    expect(rows.map((r) => [r.status, r.rejectReason])).toEqual([
      ['rejected', 'template name'],
      ['rejected', 'template name'],
    ]);
    const [kept] = await store.listForCompany(c, 'owner_name');
    expect(kept).toMatchObject({ status: 'accepted', rejectReason: null });
  });

  it('leaves one person on several pages of one domain, and a single claim, alone', async () => {
    const runId = await run();
    const a = await company(runId, 'Alpha Painting');
    await new DbEvidenceStore(db).recordMany([
      owner(a, 'Jeff London', 'https://alpha.com/about'),
      owner(a, 'Jeff London', 'https://www.alpha.com/contact'),
    ]);
    expect(await siteFinalizeStage.run(ctx(runId), { runId })).toEqual({ templateNamesRejected: 0 });
  });

  it('leaves locations of one franchise brand alone, and ignores names written differently by case or middle initial', async () => {
    const runId = await run();
    const f1 = await company(runId, 'CertaPro Edison', 'CertaPro Painters');
    const f2 = await company(runId, 'CertaPro Austin', 'CertaPro Painters');
    const x = await company(runId, 'X Painting');
    const y = await company(runId, 'Y Painting');
    await new DbEvidenceStore(db).recordMany([
      owner(f1, 'Dana Reed', 'https://edison.certapro.com/about'),
      owner(f2, 'Dana Reed', 'https://austin.certapro.com/about'),
      owner(x, 'Anna B. Cole', 'https://x.com/about'),
      owner(y, 'ANNA COLE', 'https://y.com/about'),
    ]);
    // franchise pair untouched; "Anna B. Cole" and "ANNA COLE" are the same person key on two domains
    expect(await siteFinalizeStage.run(ctx(runId), { runId })).toEqual({ templateNamesRejected: 2 });
  });

  it('only looks at accepted website owner rows of this run', async () => {
    const runId = await run();
    const otherRun = await run();
    const a = await company(runId, 'Alpha Painting');
    const b = await company(otherRun, 'Beta Painting');
    const c = await company(runId, 'Gamma Painting');
    await new DbEvidenceStore(db).recordMany([
      owner(a, 'Sam Parker', 'https://alpha.com/about'),
      owner(b, 'Sam Parker', 'https://beta.com/about'),
      owner(c, 'Sam Parker', 'https://gamma.com/about', 'needs_review'),
    ]);
    expect(await siteFinalizeStage.run(ctx(runId), { runId })).toEqual({ templateNamesRejected: 0 });
  });

  it('templateNameIds is a pure function over rows', () => {
    const rows = [
      { id: 1, valueNorm: 'a b', sourceUrl: 'https://one.com/', franchiseBrand: null },
      { id: 2, valueNorm: 'a b', sourceUrl: 'https://two.com/', franchiseBrand: null },
      { id: 3, valueNorm: 'c d', sourceUrl: 'https://one.com/', franchiseBrand: null },
    ];
    expect(templateNameIds(rows, [])).toEqual([1, 2]);
  });
});
