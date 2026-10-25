import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbEvidenceStore, getTestDb, truncateAll, type Db } from '@pp/core';
import { loadCslbMaster } from '../src/cslb/master';
import { matchCslb } from '../src/cslb/match';
import { IncompletePersonnelError, loadCslbPersonnel, masterMaxLicence } from '../src/cslb/personnel';
import { FIXTURES, insertCompany } from './helpers';

const MASTER = path.join(FIXTURES, 'cslb', 'master-sample.csv');
const COMPLETE = path.join(FIXTURES, 'cslb', 'cslb-people-complete.csv');
const TRUNCATED = path.join(FIXTURES, 'cslb', 'cslb-people-truncated.csv');
const CAPTURED = new Date('2026-10-23T00:00:00Z');
const MASTER_MAX = 1163439;

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
  await loadCslbMaster(db, MASTER, { capturedAt: CAPTURED });
});

const deps = () => ({ db, store: new DbEvidenceStore(db), now: () => new Date('2026-10-25T12:00:00Z') });
const peopleCount = async () => (await db.$client.query("SELECT count(*)::int AS n FROM registry_people WHERE source_type = 'cslb_personnel'")).rows[0].n as number;

describe('loadCslbPersonnel', () => {
  it('refuses a partial file and leaves the database untouched', async () => {
    await loadCslbPersonnel(db, COMPLETE, { capturedAt: CAPTURED, masterMax: MASTER_MAX });
    const before = await peopleCount();
    expect(before).toBeGreaterThan(0);
    const err = await loadCslbPersonnel(db, TRUNCATED, { capturedAt: CAPTURED, masterMax: MASTER_MAX }).catch((e) => e);
    expect(err).toBeInstanceOf(IncompletePersonnelError);
    expect((err as IncompletePersonnelError).verdict.reason).toMatch(/last row does not parse/);
    expect(await peopleCount()).toBe(before);
  });

  it('loads owner-like roles of licences that are in the master; skips deceased, business rows, unknown licences', async () => {
    const r = await loadCslbPersonnel(db, COMPLETE, { capturedAt: CAPTURED, masterMax: MASTER_MAX });
    expect(r).toMatchObject({ rows: 9, skippedUnknownLicence: 1 });
    const rows = (
      await db.$client.query(
        `SELECT r.source_key, p.full_name, p.title, p.role_rank, to_char(p.dissociated_on, 'YYYY-MM-DD') AS dis
           FROM registry_people p JOIN registry_records r ON r.id = p.registry_record_id
          WHERE p.source_type = 'cslb_personnel' ORDER BY r.source_key, p.id`,
      )
    ).rows as { source_key: string; full_name: string; title: string; role_rank: number; dis: string | null }[];
    expect(rows.map((x) => [x.source_key, x.full_name, x.role_rank, x.dis])).toEqual([
      ['1000440', 'Richard Roe', 4, null],
      ['1000441', 'Lee Sample', 5, null],
      ['1000918', 'Jane Tester', 2, null],
      ['1002304', 'Carol Example', 1, null],
      ['1002304', 'Pat Fixture', 4, null],
      ['1002304', 'Sam Oldtimer', 1, '2010-06-06'],
    ]);
  });

  it('is re-runnable: loading again replaces, not duplicates', async () => {
    await loadCslbPersonnel(db, COMPLETE, { capturedAt: CAPTURED, masterMax: MASTER_MAX });
    const n = await peopleCount();
    await loadCslbPersonnel(db, COMPLETE, { capturedAt: CAPTURED, masterMax: MASTER_MAX });
    expect(await peopleCount()).toBe(n);
  });

  it('the master\'s highest licence ignores outliers', async () => {
    expect(await masterMaxLicence(db)).toBe(1011284);
  });
});

describe('CA owner from the personnel file (D-19 priority)', () => {
  beforeEach(async () => {
    await loadCslbPersonnel(db, COMPLETE, { capturedAt: CAPTURED, masterMax: MASTER_MAX });
  });

  const ownerOf = async (companyId: number) => (await new DbEvidenceStore(db).listForCompany(companyId, 'owner_name'));

  it('a corporation: the current CEO/President beats an officer; the dissociated former president is never chosen', async () => {
    const company = await insertCompany(db, { name: 'Lifetime Custom Painting', state: 'CA', city: 'National City', zip: '91950', phoneE164: '+16195919936' });
    const r = await matchCslb(deps(), company);
    expect(r).toMatchObject({ status: 'matched', owners: 1 });
    const owners = await ownerOf(company.companyId);
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ value: 'Carol Example', sourceType: 'cslb_personnel', confidence: 'high' });
    expect(owners[0]?.attrs.title).toBe('Responsible Managing Officer/Chief Executive Officer/President');
    expect(owners[0]?.snippet).toContain('LicenseNo=1002304');
    const st = await db.$client.query('SELECT registry_status FROM companies WHERE id = $1', [company.companyId]);
    expect(st.rows[0].registry_status).toMatchObject({ cslb_owner: 'found' });
  });

  it('an LLC: the member is the owner; a responsible managing employee is not an owner', async () => {
    const company = await insertCompany(db, { name: 'Advanced Painting LLC', state: 'CA', city: 'Santa Rosa', zip: '95401', phoneE164: '+17075405963' });
    await matchCslb(deps(), company);
    const owners = await ownerOf(company.companyId);
    expect(owners.map((o) => [o.value, o.attrs.title])).toEqual([['Lee Sample', 'LLC Member']]);
  });

  it('a sole owner whose licence carries only a trade name gets the owner from the personnel file', async () => {
    const company = await insertCompany(db, { name: 'Protouch Painting', state: 'CA', city: 'Mokelumne Hill', zip: '95245', phoneE164: '+12094189640' });
    await matchCslb(deps(), company);
    const owners = await ownerOf(company.companyId);
    expect(owners.map((o) => [o.value, o.attrs.title])).toEqual([['Jane Tester', 'Sole Owner']]);
  });

  it('a deceased sole owner is no owner: licence evidence, no owner_name', async () => {
    const company = await insertCompany(db, { name: 'Best United Top Painting', state: 'CA', city: 'Tujunga', zip: '91042', phoneE164: '+12132206605' });
    const r = await matchCslb(deps(), company);
    expect(r).toMatchObject({ status: 'matched', owners: 0 });
    expect(await ownerOf(company.companyId)).toHaveLength(0);
  });
});
