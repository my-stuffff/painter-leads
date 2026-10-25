import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbEvidenceStore, getTestDb, truncateAll, type Db, type RegistryMatchInput } from '@pp/core';
import { emailDomainMatches } from '../src/nj/match';
import { resetRosterQueue } from '../src/nj/roster-ensure';
import { loadNjRosterRows, parseNjRoster } from '../src/nj/roster-parse';
import { createRegistriesStage } from '../src/stage';
import { fixture, insertCompany, makeFetcher, stageContext, tempDir, testConfig } from './helpers';
import { mockDetailFlow, mockPrincipalFlow } from './nj-detail-mocks';

let db: Db;
let close: () => Promise<void>;
const saved = process.env.PP_DATA_DIR;
const CAPTURED = new Date('2026-10-25T12:00:00Z');

/** One extra roster row for the real Spectra registration (public register data; the email is invented). */
const spectraRow =
  'SPECTRA PAINTING, INC|||||Home Improvement Contractors|Home Improvement Business Contr|13VH06161800|3/7/2011|3/31/2027|65 Reeds Rd||Tinton Falls|NJ|07724|Monmouth|spectra@spectra-example.test|Active|';

beforeAll(() => {
  ({ db, close } = getTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await truncateAll(db);
  resetRosterQueue();
  // Rosters are "pulled" already: fresh files for the towns used here, rows loaded.
  const dir = path.join(tempDir(), 'downloads', 'nj');
  mkdirSync(dir, { recursive: true });
  for (const slug of ['edison', 'trenton', 'tinton-falls', 'elsewhere']) writeFileSync(path.join(dir, `${slug}-2026-10-25.txt`), '');
  process.env.PP_DATA_DIR = path.dirname(path.dirname(dir));
  const rows = parseNjRoster(`${fixture('nj', 'nj-roster-synthetic.txt')}${spectraRow}\n`);
  await loadNjRosterRows(db, rows, { capturedAt: CAPTURED });
});
afterEach(() => {
  if (saved === undefined) delete process.env.PP_DATA_DIR;
  else process.env.PP_DATA_DIR = saved;
});

async function input(over: Partial<RegistryMatchInput['company']> & { name: string }, extra: Partial<RegistryMatchInput> = {}): Promise<RegistryMatchInput> {
  const company = await insertCompany(db, { state: 'NJ', city: 'Edison', zip: '08817', ...over });
  return { company, emails: [], licenceNumbers: [], websiteDomain: null, ...extra };
}

const run = (i: RegistryMatchInput, config = testConfig(), mock?: (agent: ReturnType<typeof makeFetcher>['agent']) => void, opts = {}) => {
  const f = makeFetcher(config);
  mock?.(f.agent);
  return createRegistriesStage({ only: new Set(['nj_hic_roster', 'nj_hic_detail', 'nj_principal_search']), ...opts })
    .run(stageContext(db, f.fetcher, config), i)
    .then((r) => ({ r, calls: f.calls() }));
};

const ev = (companyId: number) => new DbEvidenceStore(db).listForCompany(companyId);
const matches = async (companyId: number) =>
  (await db.$client.query('SELECT m.rung, m.strength, r.source_key FROM registry_matches m JOIN registry_records r ON r.id = m.registry_record_id WHERE m.company_id = $1 ORDER BY r.source_key', [companyId])).rows;
const statusOf = async (companyId: number) => (await db.$client.query('SELECT registry_status FROM companies WHERE id = $1', [companyId])).rows[0].registry_status;

describe('NJ: strong match runs the whole owner chain', () => {
  it('Spectra: matches by name + ZIP, reads the owner in one session, confirms the principal, stores the roster email', async () => {
    const i = await input({ name: 'Spectra Painting', city: 'Tinton Falls', zip: '07724' });
    const { r, calls } = await run(i, testConfig(), (a) => {
      mockDetailFlow(a, 'spectra');
      mockPrincipalFlow(a, true);
    });
    expect(r.status).toEqual({ nj_hic_roster: 'matched', nj_hic_detail: 'matched', nj_principal_search: 'matched' });
    expect(r.owners).toBe(1);
    expect(await matches(i.company.companyId)).toEqual([{ rung: 'name_zip', strength: 'strong', source_key: '13VH06161800' }]);

    const rows = await ev(i.company.companyId);
    const owners = rows.filter((e) => e.field === 'owner_name');
    expect(owners.map((o) => [o.sourceType, o.value, o.confidence])).toEqual([
      ['nj_hic_detail', 'Eric Doeler', 'high'],
      ['nj_principal_search', 'Eric Doeler', 'high'],
    ]);
    expect(owners[0]?.sourceUrl).toMatch(/Details\.aspx\?result=/);
    expect(owners[0]?.snippet).toContain('Owner Name: Eric Doeler');
    expect(owners[1]?.snippet).toContain('SPECTRA PAINTING, INC. (entity 0100508103');

    const email = rows.find((e) => e.field === 'email');
    expect(email).toMatchObject({ value: 'spectra@spectra-example.test', sourceType: 'nj_hic_roster', confidence: 'high', snippet: 'addr_email on roster row 13VH06161800' });
    expect(rows.find((e) => e.field === 'licence_number')).toMatchObject({ value: '13VH06161800', sourceType: 'nj_hic_roster', attrs: expect.objectContaining({ kind: 'nj_hic' }) });
    expect(rows.find((e) => e.field === 'licence_status')?.value).toBe('Active');
    expect(rows.every((e) => e.sourceUrl.startsWith('https://') && e.snippet.length > 0 && e.registryRecordId !== null)).toBe(true);

    const st = await statusOf(i.company.companyId);
    expect(st).toMatchObject({ nj_hic: 'matched', nj_hic_active: true, nj_hic_rung: 'name_zip', nj_hic_detail: 'matched', nj_principal_search: 'matched' });
    const people = await db.$client.query("SELECT full_name, title FROM registry_people WHERE source_type = 'nj_hic_detail'");
    expect(people.rows).toEqual([{ full_name: 'Eric Doeler', title: 'Owner' }]);
    // 3 detail requests + 3 principal requests (GET, radio postback, search)
    expect(calls.filter((c) => c.includes('mylicense')).length).toBe(3);
    expect(calls.filter((c) => c.includes('njportal')).length).toBe(3);
  });

  it('a second run reuses the stored owner evidence: no request goes out and nothing is duplicated', async () => {
    const i = await input({ name: 'Spectra Painting', city: 'Tinton Falls', zip: '07724' });
    await run(i, testConfig(), (a) => {
      mockDetailFlow(a, 'spectra');
      mockPrincipalFlow(a, true);
    });
    const before = (await ev(i.company.companyId)).length;
    const again = await run(i);
    expect(again.calls).toEqual([]);
    expect(again.r.status).toEqual({ nj_hic_roster: 'matched', nj_hic_detail: 'matched', nj_principal_search: 'matched' });
    expect((await ev(i.company.companyId)).length).toBe(before);
  });

  it('a principal search that does not list the registered company leaves the owner but records no_match for that source', async () => {
    const i = await input({ name: 'Spectra Painting', city: 'Tinton Falls', zip: '07724' });
    const { r } = await run(i, testConfig(), (a) => {
      mockDetailFlow(a, 'spectra');
      mockPrincipalFlow(a, false);
    });
    expect(r.status.nj_principal_search).toBe('no_match');
    const owners = (await ev(i.company.companyId)).filter((e) => e.field === 'owner_name');
    expect(owners.map((o) => o.sourceType)).toEqual(['nj_hic_detail']);
  });

  it('a failed detail lookup is an error for that source (never "no owner") and the roster evidence is kept', async () => {
    const i = await input({ name: 'Spectra Painting', city: 'Tinton Falls', zip: '07724' });
    const { r } = await run(i, testConfig(), (a) => mockDetailFlow(a, 'spectra', { drop: 'detail500' }));
    expect(r.status).toMatchObject({ nj_hic_roster: 'matched', nj_hic_detail: 'error', nj_principal_search: 'not_applicable' });
    expect(r.owners).toBe(0);
    const rows = await ev(i.company.companyId);
    expect(rows.some((e) => e.field === 'owner_name')).toBe(false);
    expect(rows.some((e) => e.field === 'licence_number')).toBe(true);
  });
});

describe('NJ: no detail request without a strong match', () => {
  it('a name-only (candidate) match writes a matches row, no evidence, and sends no request at all', async () => {
    const i = await input({ name: 'Bright Coat Painting', city: 'Trenton', zip: '08608' });
    const { r, calls } = await run(i);
    expect(r.status).toEqual({ nj_hic_roster: 'candidate_only', nj_hic_detail: 'not_applicable', nj_principal_search: 'not_applicable' });
    expect((await matches(i.company.companyId)).every((m) => m.strength === 'candidate')).toBe(true);
    expect(await ev(i.company.companyId)).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it('no roster row at all: no_match, no request', async () => {
    const i = await input({ name: 'Totally Unknown Roofing', city: 'Edison', zip: '08899' });
    const { r, calls } = await run(i);
    expect(r.status.nj_hic_roster).toBe('no_match');
    expect(calls).toEqual([]);
    expect(await matches(i.company.companyId)).toEqual([]);
  });

  it('two Active registrations with the same name and ZIP are ambiguous: candidates only, no request', async () => {
    const i = await input({ name: 'Northside Decks & Painting', city: 'Edison', zip: '08820' });
    const { r, calls } = await run(i);
    expect(r.status.nj_hic_roster).toBe('candidate_only');
    expect(await matches(i.company.companyId)).toEqual([
      { rung: 'name_zip', strength: 'candidate', source_key: '13VH90000006' },
      { rung: 'name_zip', strength: 'candidate', source_key: '13VH90000007' },
    ]);
    expect(await ev(i.company.companyId)).toHaveLength(0);
    expect(calls).toEqual([]);
  });
});

describe('NJ: rung order and Active preference', () => {
  const noDetail = () => testConfig({ nj_hic_detail: { enabled: false } });

  it('Active is chosen over the older Expired registration of the same brand; its roster email is stored', async () => {
    const i = await input({ name: 'Bright Coat Painting LLC', city: 'Edison', zip: '08817' });
    const { r, calls } = await run(i, noDetail());
    expect(r.status).toMatchObject({ nj_hic_roster: 'matched', nj_hic_detail: 'disabled' });
    expect(await matches(i.company.companyId)).toEqual([{ rung: 'name_zip', strength: 'strong', source_key: '13VH90000001' }]);
    const rows = await ev(i.company.companyId);
    expect(rows.find((e) => e.field === 'email')?.value).toBe('info@brightcoat-example.test');
    expect(calls).toEqual([]);
  });

  it('rung 1: the 13VH number from the website beats every other rung', async () => {
    const i = await input({ name: 'Something Else Entirely', city: 'Edison', zip: '08837' }, { licenceNumbers: ['13VH90000005'], websiteDomain: 'brightcoat-example.test' });
    const { r } = await run(i, noDetail());
    expect(r.status.nj_hic_roster).toBe('matched');
    expect(await matches(i.company.companyId)).toEqual([{ rung: '13vh', strength: 'strong', source_key: '13VH90000005' }]);
    expect((await ev(i.company.companyId)).find((e) => e.field === 'registry_legal_name')?.value).toBe('GREEN HILL HOME IMPROVEMENT INC');
  });

  it('rung 2: roster email domain = website domain (Active chosen among the twin registrations)', async () => {
    const i = await input({ name: 'Unrelated Name Co', city: 'Elsewhere', zip: '99999' }, { websiteDomain: 'brightcoat-example.test' });
    await run(i, noDetail());
    expect(await matches(i.company.companyId)).toEqual([{ rung: 'email_domain', strength: 'strong', source_key: '13VH90000001' }]);
  });

  it('rung 4: street address + ZIP + a name word in common, when nothing earlier matches', async () => {
    const i = await input({ name: 'Bright Coat Wall Finishing', city: 'Edison', zip: '08817', street: '100 Fixture Road' });
    await run(i, noDetail());
    expect(await matches(i.company.companyId)).toEqual([{ rung: 'address', strength: 'strong', source_key: '13VH90000001' }]);
    const detail = (await db.$client.query('SELECT detail FROM registry_matches WHERE company_id = $1', [i.company.companyId])).rows[0].detail;
    expect(detail.note).toMatch(/BRIGHT/);
  });

  it('rung 4 never fires on the street address alone: another business at the same address is not a match', async () => {
    const i = await input({ name: 'Unrelated Painters', city: 'Edison', zip: '08817', street: '100 Fixture Road' });
    const { r } = await run(i, noDetail());
    expect(await matches(i.company.companyId)).toEqual([]);
    expect(r.status.nj_hic_roster).toBe('no_match');
  });

  it('a roster row with no ZIP is still found by the listing city, and a unit like "5B" on the roster address does not hide the street', async () => {
    const header = fixture('nj', 'nj-roster-synthetic.txt').split('\n')[0];
    await loadNjRosterRows(
      db,
      parseNjRoster(`${header}\nQUUX HOME IMPROVEMENT LLC|||||Home Improvement Contractors|Home Improvement Business Contr|13VH90000050|1/1/2020|3/31/2027|21 Quux Blvd 5B||Edison|NJ|||quux@gmail-example.test|Active|
`),
      { capturedAt: CAPTURED },
    );
    const i = await input({ name: 'Quux Wibble Painting & Remodeling', city: 'Edison', zip: '08837', street: '21 Quux Boulevard' });
    await run(i, noDetail());
    expect(await matches(i.company.companyId)).toEqual([{ rung: 'address', strength: 'strong', source_key: '13VH90000050' }]);
  });

  it('name + ZIP (rung 3) is tried before the street address (rung 4)', async () => {
    const i = await input({ name: 'Green Hill Home Improvement', city: 'Edison', zip: '08837', street: '100 Fixture Road' });
    await run(i, noDetail());
    expect((await matches(i.company.companyId)).map((m) => m.rung)).toEqual(['name_zip']);
  });

  it('a registration that is not Active still matches (status stored, nj_hic_active false)', async () => {
    const i = await input({ name: 'Zenith Roofing', city: 'Edison', zip: '08820' });
    await run(i, noDetail());
    expect(await matches(i.company.companyId)).toEqual([{ rung: 'name_zip', strength: 'strong', source_key: '13VH90000008' }]);
    expect((await statusOf(i.company.companyId)).nj_hic_active).toBe(false);
  });

  it('a registration in the owner\'s own name matches on the company name path', async () => {
    const i = await input({ name: 'Antonio Fixture Painting', city: 'Edison', zip: '08837' });
    await run(i, noDetail());
    expect((await matches(i.company.companyId)).map((m) => m.source_key)).toEqual(['13VH90000004']);
  });

  it('T/A: the trade name on either side matches', async () => {
    const i = await input({ name: 'Anthony Cherry', city: 'Edison', zip: '08820' });
    await run(i, noDetail());
    expect((await matches(i.company.companyId)).map((m) => m.source_key)).toEqual(['13VH90000003']);
  });
});

describe('NJ: switches and offline', () => {
  it('roster switch off: roster disabled, nothing else applies, no request', async () => {
    const i = await input({ name: 'Spectra Painting', city: 'Tinton Falls', zip: '07724' });
    const { r, calls } = await run(i, testConfig({ nj_hic_roster: { enabled: false } }));
    expect(r.status).toEqual({ nj_hic_roster: 'disabled', nj_hic_detail: 'not_applicable', nj_principal_search: 'not_applicable' });
    expect(calls).toEqual([]);
  });

  it('principal switch off: the owner is read, the confirmation is disabled and no njportal request goes out', async () => {
    const i = await input({ name: 'Spectra Painting', city: 'Tinton Falls', zip: '07724' });
    const { r, calls } = await run(i, testConfig({ nj_principal_search: { enabled: false } }), (a) => mockDetailFlow(a, 'spectra'));
    expect(r.status).toEqual({ nj_hic_roster: 'matched', nj_hic_detail: 'matched', nj_principal_search: 'disabled' });
    expect(calls.some((c) => c.includes('njportal'))).toBe(false);
  });

  it('offline: matches from the loaded roster, but the live owner flows are not run', async () => {
    const i = await input({ name: 'Spectra Painting', city: 'Tinton Falls', zip: '07724' });
    const { r, calls } = await run(i, testConfig(), undefined, { offline: true });
    expect(r.status).toMatchObject({ nj_hic_roster: 'matched', nj_hic_detail: 'disabled' });
    expect(calls).toEqual([]);
  });
});

describe('emailDomainMatches', () => {
  it('needs the company\'s own domain on both sides: not a free-mail provider, not a shared host', () => {
    expect(emailDomainMatches('info@acme-paint.com', 'acme-paint.com')).toBe(true);
    expect(emailDomainMatches('info@mail.acme-paint.com', 'www.acme-paint.com')).toBe(true);
    expect(emailDomainMatches('acme@gmail.com', 'gmail.com')).toBe(false);
    expect(emailDomainMatches('acme@yahoo.com', 'acme-paint.com')).toBe(false);
    expect(emailDomainMatches('acme@x.wixsite.com', 'x.wixsite.com')).toBe(false);
    expect(emailDomainMatches(null, 'acme-paint.com')).toBe(false);
    expect(emailDomainMatches('info@acme-paint.com', null)).toBe(false);
  });
});
