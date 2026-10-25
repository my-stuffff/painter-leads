import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client';
import { companies, evidence, listings, PILOT_TABLES } from '../src/db/schema';
import { getTestDb, truncateAll } from '../src/db/test-utils';
import { corroborate, resolveOwnerConflicts } from '../src/evidence/corroborate';
import { DEFAULT_SELECTION_POLICY, selectBest } from '../src/evidence/select';
import { DbEvidenceStore, type EvidenceDraft, type EvidenceRow } from '../src/evidence/store';

const handle = getTestDb();
const db: Db = handle.db;
const store = new DbEvidenceStore(db);

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function makeCompany(name = 'Test Painting'): Promise<number> {
  const [row] = await db.insert(companies).values({ displayName: name }).returning({ id: companies.id });
  return row!.id;
}

const draft = (companyId: number, over: Partial<EvidenceDraft>): EvidenceDraft => ({
  companyId,
  field: 'owner_name',
  value: 'John Catapano',
  sourceType: 'website',
  sourceUrl: 'https://example-painting.test/about',
  capturedAt: new Date('2026-10-25T12:00:00Z'),
  snippet: 'Meet John Catapano, owner of Example Painting',
  extractor: 'test',
  extractorVersion: '1',
  confidence: 'medium',
  ...over,
});

describe('migration', () => {
  it('created every pilot table from the one migration', async () => {
    const res = await db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
    const names = (res.rows as { table_name: string }[]).map((r) => r.table_name);
    for (const t of PILOT_TABLES) expect(names).toContain(t);
  });
});

describe('evidence provenance is enforced by the database (ENR-06, D-03)', () => {
  const required = ['snippet', 'sourceType', 'sourceUrl', 'capturedAt', 'extractor', 'extractorVersion'] as const;

  it.each(required)('refuses an evidence row without %s', async (col) => {
    const companyId = await makeCompany();
    const valid = {
      companyId,
      field: 'owner_name',
      value: 'John Catapano',
      valueNorm: 'john catapano',
      sourceType: 'website',
      sourceUrl: 'https://example-painting.test/about',
      capturedAt: new Date(),
      snippet: 'Meet John Catapano',
      extractor: 'test',
      extractorVersion: '1',
      confidence: 'medium',
    };
    await expect(db.insert(evidence).values({ ...valid, [col]: null } as never)).rejects.toThrow();
    await expect(db.insert(evidence).values(valid)).resolves.toBeDefined();
  });

  it('refuses an empty snippet, an unknown field and a row that belongs to nothing', async () => {
    const companyId = await makeCompany();
    await expect(store.record(draft(companyId, { snippet: '' }))).rejects.toThrow();
    await expect(store.record(draft(companyId, { field: 'shoe_size' as never }))).rejects.toThrow();
    await expect(store.record(draft(companyId, { companyId: null }))).rejects.toThrow();
  });
});

describe('listing capture status (D-13): a value that was not captured is NULL, never 0', () => {
  const base = { profileUrl: 'https://www.google.com/maps/place/x', name: 'X Painting' };

  it('refuses review_count 0 with status limited_view and accepts NULL', async () => {
    await expect(
      db.insert(listings).values({ ...base, placeId: 'p1', reviewCount: 0, reviewCountStatus: 'limited_view' }),
    ).rejects.toThrow();
    await expect(
      db.insert(listings).values({ ...base, placeId: 'p2', reviewCount: null, reviewCountStatus: 'limited_view' }),
    ).resolves.toBeDefined();
  });

  it('accepts a genuinely captured 0 and refuses NULL marked captured', async () => {
    await expect(
      db.insert(listings).values({ ...base, placeId: 'p3', reviewCount: 0, reviewCountStatus: 'captured' }),
    ).resolves.toBeDefined();
    await expect(
      db.insert(listings).values({ ...base, placeId: 'p4', reviewCount: null, reviewCountStatus: 'captured' }),
    ).rejects.toThrow();
  });

  it('applies the same rule to rating, phone, website, address, coordinates and the closed flag', async () => {
    await expect(
      db.insert(listings).values({ ...base, placeId: 'p5', rating: 1, ratingStatus: 'not_on_card' }),
    ).rejects.toThrow();
    await expect(
      db.insert(listings).values({ ...base, placeId: 'p6', phoneE164: '+15123730002', phoneStatus: 'not_shown' }),
    ).rejects.toThrow();
    await expect(
      db.insert(listings).values({ ...base, placeId: 'p7', lat: 0, lng: 0, coordsStatus: 'parse_failed' }),
    ).rejects.toThrow();
    await expect(
      db.insert(listings).values({ ...base, placeId: 'p8', permanentlyClosed: false, closedStatus: 'blocked' }),
    ).rejects.toThrow();
  });

  it('refuses a rating outside 1.0-5.0 and a listing with neither place id nor cid', async () => {
    await expect(
      db.insert(listings).values({ ...base, placeId: 'p9', rating: 5.5, ratingStatus: 'captured' }),
    ).rejects.toThrow();
    await expect(db.insert(listings).values({ ...base })).rejects.toThrow();
  });

  it('keeps place_id unique when set but allows many listings that only have a cid', async () => {
    await db.insert(listings).values({ ...base, placeId: 'dup' });
    await expect(db.insert(listings).values({ ...base, placeId: 'dup' })).rejects.toThrow();
    await db.insert(listings).values({ ...base, cid: 'c1' });
    await db.insert(listings).values({ ...base, cid: 'c2' });
  });
});

describe('corroborate (D-22): independence', () => {
  it('raises website + bbb agreement to high and links both ways', async () => {
    const companyId = await makeCompany();
    const [web, bbb] = await store.recordMany([
      draft(companyId, { sourceType: 'website', value: 'John Catapano' }),
      draft(companyId, { sourceType: 'bbb', value: 'JOHN A. CATAPANO', sourceUrl: 'https://www.bbb.org/x' }),
    ]);
    const touched = await corroborate(db, companyId, 'owner_name');
    expect(touched).toBe(2);
    const rows = await store.listForCompany(companyId, 'owner_name');
    const w = rows.find((r) => r.id === web)!;
    const b = rows.find((r) => r.id === bbb)!;
    expect(w.confidence).toBe('high');
    expect(b.confidence).toBe('high');
    expect(w.corroboratedBy).toEqual([bbb]);
    expect(b.corroboratedBy).toEqual([web]);
  });

  it('does not raise two pages of the same website', async () => {
    const companyId = await makeCompany();
    await store.recordMany([
      draft(companyId, { sourceUrl: 'https://example-painting.test/about' }),
      draft(companyId, { sourceUrl: 'https://example-painting.test/team' }),
    ]);
    expect(await corroborate(db, companyId, 'owner_name')).toBe(0);
    const rows = await store.listForCompany(companyId, 'owner_name');
    expect(rows.every((r) => r.confidence === 'medium' && r.corroboratedBy.length === 0)).toBe(true);
  });

  it('ignores rejected rows and different values', async () => {
    const companyId = await makeCompany();
    await store.recordMany([
      draft(companyId, { sourceType: 'website', value: 'John Catapano' }),
      draft(companyId, { sourceType: 'bbb', value: 'Maria Lopez' }),
      draft(companyId, { sourceType: 'nj_hic_detail', value: 'John Catapano', status: 'rejected' }),
    ]);
    expect(await corroborate(db, companyId, 'owner_name')).toBe(0);
  });
});

describe('resolveOwnerConflicts (D-18): the registry wins', () => {
  it("rejects 'Brennan Price' from the website when nj_hic_detail says 'Donal Lopez'", async () => {
    const companyId = await makeCompany();
    const [web, reg] = await store.recordMany([
      draft(companyId, { sourceType: 'website', value: 'Brennan Price' }),
      draft(companyId, {
        sourceType: 'nj_hic_detail',
        value: 'Donal Lopez',
        confidence: 'high',
        sourceUrl: 'https://newjersey.mylicense.com/verification/Details.aspx?result=x',
      }),
    ]);
    expect(await resolveOwnerConflicts(db, companyId)).toBe(1);
    const rows = await store.listForCompany(companyId, 'owner_name');
    const w = rows.find((r) => r.id === web)!;
    expect(w.status).toBe('rejected');
    expect(w.rejectReason).toBe('conflicts with registry');
    expect(rows.find((r) => r.id === reg)!.status).toBe('accepted');
  });

  it('corroborates a website owner that matches the registry instead of rejecting it', async () => {
    const companyId = await makeCompany();
    await store.recordMany([
      draft(companyId, { sourceType: 'website', value: 'Donal Lopez' }),
      draft(companyId, { sourceType: 'nj_hic_detail', value: 'DONAL LOPEZ', confidence: 'high' }),
    ]);
    expect(await resolveOwnerConflicts(db, companyId)).toBe(0);
    const rows = await store.listForCompany(companyId, 'owner_name');
    expect(rows.every((r) => r.status === 'accepted' && r.confidence === 'high' && r.corroboratedBy.length === 1)).toBe(true);
  });

  it('does nothing when there is no registry owner', async () => {
    const companyId = await makeCompany();
    await store.record(draft(companyId, { sourceType: 'website', value: 'Brennan Price' }));
    expect(await resolveOwnerConflicts(db, companyId)).toBe(0);
  });
});

describe('selectBest ordering on rows read back from the database', () => {
  const row = (over: Partial<EvidenceRow> & { id: number }): EvidenceRow => ({
    companyId: 1,
    field: 'owner_name',
    value: `v${over.id}`,
    valueNorm: `v${over.id}`,
    sourceType: 'website',
    sourceUrl: 'https://x.test',
    capturedAt: new Date('2026-01-01T00:00:00Z'),
    snippet: 's',
    extractor: 't',
    extractorVersion: '1',
    confidence: 'medium',
    status: 'accepted',
    corroboratedBy: [],
    attrs: {},
    ...over,
  });

  it('stores and returns rows in a form selectBest accepts', async () => {
    const companyId = await makeCompany();
    await store.recordMany([
      draft(companyId, { value: 'Low Name', confidence: 'low' }),
      draft(companyId, { value: 'Medium Name', confidence: 'medium' }),
    ]);
    const best = selectBest(await store.listForCompany(companyId), 'owner_name');
    expect(best?.value).toBe('Medium Name');
  });

  it('orders accepted > needs_review, high > medium > low, source priority, earliest, lowest id', () => {
    const policy = { ...DEFAULT_SELECTION_POLICY, minConfidence: 'low' as const };
    const pick = (rows: EvidenceRow[]) => selectBest(rows, 'owner_name', policy)?.id;

    expect(pick([row({ id: 1, status: 'needs_review', confidence: 'high' }), row({ id: 2, confidence: 'low' })])).toBe(2);
    expect(pick([row({ id: 1, confidence: 'low' }), row({ id: 2, confidence: 'high' }), row({ id: 3, confidence: 'medium' })])).toBe(2);
    expect(pick([row({ id: 1, sourceType: 'website' }), row({ id: 2, sourceType: 'bbb' }), row({ id: 3, sourceType: 'nj_hic_detail' })])).toBe(3);
    expect(
      pick([
        row({ id: 1, capturedAt: new Date('2026-03-01T00:00:00Z') }),
        row({ id: 2, capturedAt: new Date('2026-02-01T00:00:00Z') }),
      ]),
    ).toBe(2);
    expect(pick([row({ id: 5 }), row({ id: 4 })])).toBe(4);
    expect(pick([row({ id: 1, status: 'rejected', confidence: 'high' })])).toBeUndefined();
  });
});
