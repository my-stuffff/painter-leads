import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbEvidenceStore, getTestDb, truncateAll, type Db } from '@pp/core';
import { loadCslbMaster } from '../src/cslb/master';
import { matchCslb } from '../src/cslb/match';
import { createRegistriesStage } from '../src/stage';
import { FIXTURES, insertCompany, makeFetcher, stageContext, testConfig } from './helpers';

const SAMPLE = path.join(FIXTURES, 'cslb', 'master-sample.csv');
const CAPTURED = new Date('2026-10-23T00:00:00Z');

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

const deps = () => ({ db, store: new DbEvidenceStore(db), now: () => new Date('2026-10-25T12:00:00Z') });

async function evidenceOf(companyId: number) {
  return new DbEvidenceStore(db).listForCompany(companyId);
}

describe('loadCslbMaster', () => {
  it('upserts every row once (re-loading changes nothing) and stores sole owners with a readable name', async () => {
    const first = await loadCslbMaster(db, SAMPLE, { capturedAt: CAPTURED });
    expect(first.rows).toBe(16);
    expect(first.soleOwners).toBe(3);
    await loadCslbMaster(db, SAMPLE, { capturedAt: CAPTURED });
    const n = await db.$client.query("SELECT count(*)::int AS n FROM registry_records WHERE source_type = 'cslb_master'");
    expect(n.rows[0].n).toBe(16);
    const people = await db.$client.query('SELECT count(*)::int AS n FROM registry_people');
    expect(people.rows[0].n).toBe(3);
    const row = await db.$client.query("SELECT to_char(expires_on, 'YYYY-MM-DD') AS e, source_key, phone_last10 FROM registry_records WHERE source_key = '1011284'");
    expect(row.rows[0]).toMatchObject({ e: '2028-02-29', source_key: '1011284', phone_last10: '4083983805' });
  });
});

describe('matchCslb (D-19)', () => {
  beforeEach(async () => {
    await loadCslbMaster(db, SAMPLE, { capturedAt: CAPTURED });
  });

  it('phone = a sample row\'s BusinessPhone: strong match, licence + owner evidence with provenance', async () => {
    const company = await insertCompany(db, { name: 'Cabrales Painting', state: 'CA', city: 'San Jose', zip: '95133', phoneE164: '+14083983805' });
    const r = await matchCslb(deps(), company);
    expect(r).toMatchObject({ status: 'matched', owners: 1, rung: 'phone' });

    const m = await db.$client.query('SELECT rung, strength FROM registry_matches WHERE company_id = $1', [company.companyId]);
    expect(m.rows).toEqual([{ rung: 'phone', strength: 'strong' }]);

    const ev = await evidenceOf(company.companyId);
    const by = (f: string) => ev.filter((e) => e.field === f);
    expect(by('licence_number')[0]).toMatchObject({ value: '1011284', confidence: 'high', sourceType: 'cslb_master' });
    expect(by('licence_status')[0]?.value).toBe('CLEAR');
    expect(by('licence_expiry')[0]?.value).toBe('2028-02-29');
    expect(by('licence_classifications')[0]?.value).toContain('C33');
    expect(by('registry_legal_name')[0]?.value).toBe('EDGAR CABRALES');
    expect(by('phone')[0]).toMatchObject({ value: '+14083983805', attrs: expect.objectContaining({ role: 'registry_phone' }) });

    const owner = by('owner_name');
    expect(owner).toHaveLength(1);
    expect(owner[0]).toMatchObject({ value: 'Edgar Cabrales', confidence: 'high', sourceType: 'cslb_master' });
    expect(owner[0]?.attrs.title).toBe('Sole Owner');
    for (const e of ev) {
      expect(e.sourceUrl).toMatch(/^https:\/\/web\.cslb\.ca\.gov\//);
      expect(e.capturedAt.toISOString()).toBe(CAPTURED.toISOString());
      expect(e.snippet).toContain('1011284');
      expect(e.registryRecordId).not.toBeNull();
    }
    const status = await db.$client.query('SELECT registry_status FROM companies WHERE id = $1', [company.companyId]);
    expect(status.rows[0].registry_status).toMatchObject({ cslb: 'matched', cslb_owner: 'found' });
  });

  it('name + same city on a corporation: strong by name_loc; licence evidence but no owner (no personnel file)', async () => {
    const company = await insertCompany(db, { name: 'J&A Painting, Inc.', state: 'CA', city: 'Seaside', zip: '93955' });
    const r = await matchCslb(deps(), company);
    expect(r).toMatchObject({ status: 'matched', owners: 0, rung: 'name_loc' });
    const ev = await evidenceOf(company.companyId);
    expect(ev.some((e) => e.field === 'licence_number' && e.value === '1000440')).toBe(true);
    expect(ev.some((e) => e.field === 'owner_name')).toBe(false);
    const status = await db.$client.query('SELECT registry_status FROM companies WHERE id = $1', [company.companyId]);
    expect(status.rows[0].registry_status).toMatchObject({ cslb: 'matched', cslb_owner: 'none' });
  });

  it('a name-only match (right name, wrong place, other phone) is a candidate: a matches row, ZERO evidence', async () => {
    const company = await insertCompany(db, { name: 'Advanced Painting', state: 'CA', city: 'Fresno', zip: '93701', phoneE164: '+15595550100' });
    const r = await matchCslb(deps(), company);
    expect(r.status).toBe('candidate_only');
    expect(r.evidenceIds).toEqual([]);
    const m = await db.$client.query('SELECT strength FROM registry_matches WHERE company_id = $1', [company.companyId]);
    expect(m.rows).toEqual([{ strength: 'candidate' }]);
    expect(await evidenceOf(company.companyId)).toHaveLength(0);
    const status = await db.$client.query('SELECT registry_status FROM companies WHERE id = $1', [company.companyId]);
    expect(status.rows[0].registry_status).toMatchObject({ cslb: 'candidate_only' });
  });

  it('no phone match and no name match: no_match, no matches row, no evidence', async () => {
    const company = await insertCompany(db, { name: 'Zenith Wall Art', state: 'CA', city: 'Fresno', zip: '93701', phoneE164: '+15595550100' });
    const r = await matchCslb(deps(), company);
    expect(r.status).toBe('no_match');
    expect(await evidenceOf(company.companyId)).toHaveLength(0);
    const m = await db.$client.query('SELECT 1 FROM registry_matches WHERE company_id = $1', [company.companyId]);
    expect(m.rows).toHaveLength(0);
  });

  it('is re-runnable: a second run adds no duplicate evidence or matches', async () => {
    const company = await insertCompany(db, { name: 'Cabrales Painting', state: 'CA', city: 'San Jose', zip: '95133', phoneE164: '+14083983805' });
    const a = await matchCslb(deps(), company);
    const b = await matchCslb(deps(), company);
    expect(b.evidenceIds.sort()).toEqual(a.evidenceIds.sort());
    expect(await evidenceOf(company.companyId)).toHaveLength(a.evidenceIds.length);
    const m = await db.$client.query('SELECT 1 FROM registry_matches WHERE company_id = $1', [company.companyId]);
    expect(m.rows).toHaveLength(1);
  });

  it('a suspended licence still matches and its status is stored as is', async () => {
    const company = await insertCompany(db, { name: 'Southwest Quality Construction and Painting', state: 'CA', city: 'Oceanside', zip: '92056' });
    const r = await matchCslb(deps(), company);
    expect(r.status).toBe('matched');
    const ev = await evidenceOf(company.companyId);
    expect(ev.find((e) => e.field === 'licence_status')?.value).toBe('Judgement Susp');
  });
});

describe('registries-match stage for California', () => {
  it("reports 'error' with the message 'CSLB master not loaded' when no master rows exist", async () => {
    const { fetcher } = makeFetcher();
    const config = testConfig();
    const company = await insertCompany(db, { name: 'Cabrales Painting', state: 'CA', city: 'San Jose', zip: '95133', phoneE164: '+14083983805' });
    const r = await createRegistriesStage({ only: new Set(['cslb']) }).run(stageContext(db, fetcher, config), { company, emails: [], licenceNumbers: [], websiteDomain: null });
    expect(r.status.cslb).toBe('error');
    const status = await db.$client.query('SELECT registry_status FROM companies WHERE id = $1', [company.companyId]);
    expect(status.rows[0].registry_status).toMatchObject({ cslb_error: 'CSLB master not loaded' });
  });

  it("reports 'disabled' when the cslb switch is off, and 'matched' with an owner when it is on", async () => {
    await loadCslbMaster(db, SAMPLE, { capturedAt: CAPTURED });
    const company = await insertCompany(db, { name: 'Cabrales Painting', state: 'CA', city: 'San Jose', zip: '95133', phoneE164: '+14083983805' });
    const input = { company, emails: [], licenceNumbers: [], websiteDomain: null };

    const off = testConfig({ cslb: { enabled: false } });
    const rOff = await createRegistriesStage({ only: new Set(['cslb']) }).run(stageContext(db, makeFetcher(off).fetcher, off), input);
    expect(rOff.status.cslb).toBe('disabled');

    const on = testConfig();
    const rOn = await createRegistriesStage({ only: new Set(['cslb']) }).run(stageContext(db, makeFetcher(on).fetcher, on), input);
    expect(rOn).toMatchObject({ companyId: company.companyId, status: { cslb: 'matched' }, owners: 1 });
    expect(rOn.evidenceIds.length).toBeGreaterThanOrEqual(6);
  });
});
