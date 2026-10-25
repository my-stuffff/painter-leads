import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, truncateAll } from '@pp/core';
import { mergeRun } from '../src/merge';
import { q } from '../src/sql';
import { makeEnv, FIXED_NOW } from './helpers';
import { seedListing, seedRun } from './seed';

const handle = getTestDb();
const db = handle.db;
const env = makeEnv(db);

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

const companies = (): Promise<{ id: number; display_name: string; franchise: boolean; franchise_brand: string | null; merge_rung: string; possible_duplicate_of: number | null; primary_listing_id: number }[]> =>
  q(db, `SELECT id, display_name, franchise, franchise_brand, merge_rung, possible_duplicate_of, primary_listing_id FROM companies ORDER BY id`);

describe('mergeRun persists the ladder (REC-01)', () => {
  it('merges on phone + domain, keeps every listing, points evidence at the surviving company', async () => {
    const run = await seedRun(db);
    const a = await seedListing(db, env.evidence, run, { key: 'a', name: 'Acme Painting', phone: '+17325550100', website: 'https://acmepainting.com', zip: '08817', street: '1 A St', city: 'Edison' });
    const b = await seedListing(db, env.evidence, run, { key: 'b', name: 'Acme House Painters', phone: '+17325550100', website: 'https://www.acmepainting.com' });
    const c = await seedListing(db, env.evidence, run, { key: 'c', name: 'Solo Painter' });

    const result = await mergeRun(db, env.evidence, env.config, run);
    expect(result).toMatchObject({ companies: 2, possibleDuplicates: 0 });
    expect(result.mergesByRung).toEqual({ place_id: 3, phone: 1, domain: 0, name_zip: 0 });

    const cs = await companies();
    expect(cs).toHaveLength(2);
    const merged = cs.find((x) => x.display_name === 'Acme Painting');
    expect(merged).toMatchObject({ merge_rung: 'phone', primary_listing_id: a });

    const rows = await q<{ id: number; company_id: number }>(db, `SELECT id, company_id FROM listings ORDER BY id`);
    expect(rows.find((r) => r.id === a)?.company_id).toBe(merged?.id);
    expect(rows.find((r) => r.id === b)?.company_id).toBe(merged?.id);
    expect(rows.find((r) => r.id === c)?.company_id).not.toBe(merged?.id);

    // all the evidence of both listings now belongs to the merged company, none is lost
    const ev = await q<{ n: string }>(db, `SELECT COUNT(*) AS n FROM evidence WHERE company_id = $1`, [merged?.id]);
    const total = await q<{ n: string }>(db, `SELECT COUNT(*) AS n FROM evidence WHERE listing_id IN ($1, $2)`, [a, b]);
    expect(Number(ev[0]?.n)).toBe(Number(total[0]?.n));
    const names = await q<{ value: string }>(db, `SELECT value FROM evidence WHERE company_id = $1 AND field = 'company_name' ORDER BY id`, [merged?.id]);
    expect(names.map((n) => n.value)).toEqual(['Acme Painting', 'Acme House Painters']);
  });

  it('same phone but different domain and name: both stay, linked by possible_duplicate_of', async () => {
    const run = await seedRun(db);
    await seedListing(db, env.evidence, run, { key: 'a', name: 'Alpha Painting', phone: '+17325550111', website: 'https://alphapainting.com' });
    await seedListing(db, env.evidence, run, { key: 'b', name: 'Zeta Coatings', phone: '+17325550111', website: 'https://zetacoatings.com' });

    const result = await mergeRun(db, env.evidence, env.config, run);
    expect(result).toMatchObject({ companies: 2, possibleDuplicates: 1 });
    const cs = await companies();
    expect(cs.find((x) => x.display_name === 'Zeta Coatings')?.possible_duplicate_of).toBe(cs.find((x) => x.display_name === 'Alpha Painting')?.id);
    expect(cs.find((x) => x.display_name === 'Alpha Painting')?.possible_duplicate_of).toBeNull();
  });

  it('two franchise locations stay two companies with the franchise flag and brand', async () => {
    const run = await seedRun(db);
    await seedListing(db, env.evidence, run, { key: 'a', name: 'CertaPro Painters of Edison', website: 'https://certapro.com/edison', zip: '08817' });
    await seedListing(db, env.evidence, run, { key: 'b', name: 'CertaPro Painters of Metuchen', website: 'https://certapro.com/metuchen', zip: '08840' });
    await mergeRun(db, env.evidence, env.config, run);
    const cs = await companies();
    expect(cs).toHaveLength(2);
    expect(cs.every((c) => c.franchise && c.franchise_brand === 'CertaPro Painters')).toBe(true);
  });

  it('is idempotent: running it again keeps the same company ids and creates nothing new', async () => {
    const run = await seedRun(db);
    await seedListing(db, env.evidence, run, { key: 'a', name: 'Acme Painting', phone: '+17325550100' });
    await seedListing(db, env.evidence, run, { key: 'b', name: 'Acme Painting', phone: '+17325550100' });
    await seedListing(db, env.evidence, run, { key: 'c', name: 'Other', phone: '+17325550199' });
    await mergeRun(db, env.evidence, env.config, run);
    const first = await companies();
    const second = await mergeRun(db, env.evidence, env.config, run);
    expect(second.companies).toBe(2);
    expect((await companies()).map((c) => c.id)).toEqual(first.map((c) => c.id));
  });

  it('absorbs a company that a later merge joins: its company-level evidence moves and the empty company is removed', async () => {
    const run = await seedRun(db);
    const a = await seedListing(db, env.evidence, run, { key: 'a', name: 'Acme Painting', website: 'https://acmepainting.com' });
    const b = await seedListing(db, env.evidence, run, { key: 'b', name: 'Totally Different Name' });
    await mergeRun(db, env.evidence, env.config, run);
    const before = await companies();
    expect(before).toHaveLength(2);
    const bCompany = before.find((c) => c.primary_listing_id === b)?.id as number;

    // a company-level evidence row (e.g. an owner found on a website) on the second company
    await env.evidence.record({
      companyId: bCompany,
      field: 'owner_name',
      value: 'Jane Doe',
      sourceType: 'website',
      sourceUrl: 'https://acmepainting.com/about',
      capturedAt: FIXED_NOW,
      snippet: 'Meet Jane Doe, owner',
      extractor: 't',
      extractorVersion: '1',
      confidence: 'medium',
    });
    // the detail pass later shows both listings share a website
    await q(db, `UPDATE listings SET website_url = 'https://www.acmepainting.com', website_status = 'captured' WHERE id = $1`, [b]);

    const result = await mergeRun(db, env.evidence, env.config, run);
    expect(result.companies).toBe(1);
    const after = await companies();
    expect(after).toHaveLength(1);
    expect(after[0]?.primary_listing_id).toBe(a);
    const owner = await q<{ company_id: number }>(db, `SELECT company_id FROM evidence WHERE field = 'owner_name'`);
    expect(owner[0]?.company_id).toBe(after[0]?.id);
  });

  it('merges in any listing order to the same companies (REC-01 ordering)', async () => {
    const specs = [
      { key: 'a', name: 'Acme Painting', phone: '+17325550100', website: 'https://acmepainting.com' },
      { key: 'b', name: 'Acme Painters', phone: '+17325550100', website: 'https://acmepainting.com' },
      { key: 'c', name: 'Smith and Sons', zip: '08817' },
      { key: 'd', name: 'Smith & Sons Inc', zip: '08817' },
    ];
    const outcome = async (order: typeof specs): Promise<string[]> => {
      await truncateAll(db);
      const run = await seedRun(db);
      for (const s of order) await seedListing(db, env.evidence, run, s);
      await mergeRun(db, env.evidence, env.config, run);
      const rows = await q<{ name: string; display_name: string }>(
        db,
        `SELECT l.name, c.display_name FROM listings l JOIN companies c ON c.id = l.company_id`,
      );
      // the company a listing ends up in, described by the names of the company's members
      const byCompany = new Map<string, string[]>();
      for (const r of rows) byCompany.set(r.display_name, [...(byCompany.get(r.display_name) ?? []), r.name]);
      return [...byCompany.values()].map((v) => v.sort().join('+')).sort();
    };
    const forward = await outcome(specs);
    const backward = await outcome([...specs].reverse());
    expect(backward).toEqual(forward);
    expect(forward).toHaveLength(2);
  });
});
