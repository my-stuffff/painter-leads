import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { mapMasterRow, normaliseClassifications, usDateToIso, type MasterRow } from '../src/cslb/master';
import { pickCslbOwner, roleRank, soleOwnerFromMasterRow } from '../src/cslb/owner';
import type { RegistryPerson } from '../src/records';
import { FIXTURES } from './helpers';

const rows = parse(readFileSync(path.join(FIXTURES, 'cslb', 'master-sample.csv'), 'utf8'), {
  bom: true,
  columns: true,
  relax_quotes: true,
}) as MasterRow[];
const byLicence = (n: string) => mapMasterRow(rows.find((r) => r.LicenseNo === n) as MasterRow);

describe('CSLB master row mapping', () => {
  it('maps every fixture row (real header, public C-33 licences)', () => {
    expect(rows.length).toBe(16);
    expect(rows.map(mapMasterRow).every((d) => d !== null)).toBe(true);
  });

  it('keeps licence numbers as strings (leading zeros stay) and dates as plain dates (no time-zone shift)', () => {
    const d = mapMasterRow({ LicenseNo: '0012345', BusinessName: 'ZEE PAINTING', ExpirationDate: '01/31/2027', IssueDate: '12/01/1999' });
    expect(d?.sourceKey).toBe('0012345');
    expect(d?.expiresOn).toBe('2027-01-31');
    expect(d?.issuedOn).toBe('1999-12-01');
    expect(usDateToIso('13/40/2027')).toBeNull();
    expect(usDateToIso('')).toBeNull();
  });

  it('compares phones by their last 10 digits and stores E.164', () => {
    const d = byLicence('1011284');
    expect(d?.phoneLast10).toBe('4083983805');
    expect(d?.phoneE164).toBe('+14083983805');
  });

  it('normalises classifications and keeps the status / business type as the file states them', () => {
    expect(normaliseClassifications('B| C33')).toBe('B, C33');
    expect(normaliseClassifications('')).toBeNull();
    const susp = byLicence('1000963');
    expect(susp?.status).toBe('Judgement Susp');
    expect(byLicence('1000441')?.businessType).toBe('Limited Liability');
  });

  it('adds the DBA and the person-form name as aliases (normalised)', () => {
    const dba = byLicence('1000505');
    expect(dba?.nameNorm).toBe('LOCAL QUALITY SERVICES');
    expect(dba?.aliases).toContain('LOCAL PAINTING');
    const sole = byLicence('1002540');
    expect(sole?.aliases).toContain('CARLOS PENUNURI PAINTING');
  });

  it('does not store insurance or bond columns in raw', () => {
    const raw = byLicence('1000070')?.raw ?? {};
    expect(Object.keys(raw)).not.toContain('WCPolicyNumber');
    expect(raw.LicenseNo).toBe('1000070');
  });
});

describe('Sole Owner names from the master file', () => {
  it('reads "First Last" from FullBusinessName when the file shows the LAST FIRST form too', () => {
    expect(byLicence('1011284')?.soleOwner?.display).toBe('Edgar Cabrales');
    expect(byLicence('1002540')?.soleOwner?.display).toBe('Carlos Penunuri');
    expect(byLicence('1004885')?.soleOwner?.display).toBe('Wm Martinez');
  });

  it('gives no name for a trade-name licence, a corporation named after a person, or a sole owner without the person form', () => {
    expect(byLicence('1000918')?.soleOwner).toBeNull(); // PROTOUCH PAINTING
    expect(byLicence('1000624')?.soleOwner).toBeNull(); // NAVARRO JOSE PAINTING INC (Corporation)
    expect(byLicence('1000070')?.soleOwner).toBeNull();
  });

  it('cases Mc / Mac / O\' names and refuses single-initial first names and possessive trade names', () => {
    expect(soleOwnerFromMasterRow({ BusinessName: 'MCGREGOR JOHN', FullBusinessName: 'JOHN MCGREGOR' })?.display).toBe('John McGregor');
    expect(soleOwnerFromMasterRow({ BusinessName: "O'BRIEN PATRICK", FullBusinessName: "PATRICK O'BRIEN" })?.display).toBe("Patrick O'Brien");
    expect(soleOwnerFromMasterRow({ BusinessName: 'MACDONALD IAN', FullBusinessName: 'IAN MACDONALD' })?.display).toBe('Ian MacDonald');
    expect(soleOwnerFromMasterRow({ BusinessName: 'MCGREGOR J T CUSTOM PAINTING', FullBusinessName: 'J T MCGREGOR CUSTOM PAINTING' })).toBeNull();
    expect(soleOwnerFromMasterRow({ BusinessName: "MADRID'S DAN CUSTOM COATINGS", FullBusinessName: "DAN MADRID'S CUSTOM COATINGS" })).toBeNull();
  });

  it('refuses a FullBusinessName that is not the rotation of the other name (never guesses)', () => {
    expect(soleOwnerFromMasterRow({ BusinessName: 'SMITH PAINTING', FullBusinessName: 'ACME PAINTING' })).toBeNull();
    expect(soleOwnerFromMasterRow({ BusinessName: 'ACME', FullBusinessName: '' })).toBeNull();
  });
});

describe('role ranking and owner choice (D-19)', () => {
  const person = (id: number, title: string, over: Partial<RegistryPerson> = {}): RegistryPerson => ({
    id,
    registryRecordId: 1,
    sourceType: 'cslb_personnel',
    nameRaw: null,
    fullName: `Person ${id}`,
    firstName: 'Person',
    lastName: String(id),
    title,
    roleRank: null,
    associatedOn: '2010-01-01',
    dissociatedOn: null,
    sourceUrl: null,
    capturedAt: null,
    ...over,
  });

  it('ranks CEO/President > Owner > RMO > Officer > LLC Member/Manager > General Partner; others are not owners', () => {
    const order = ['CEO', 'President', 'Sole Owner', 'Responsible Managing Officer', 'Officer', 'LLC Member', 'General Partner'].map(roleRank);
    expect(order).toEqual([1, 1, 2, 3, 4, 5, 6]);
    expect(roleRank('Vice President')).toBe(4);
    expect(roleRank('RME')).toBeNull();
    expect(roleRank('Qualifying Partner')).toBeNull();
    expect(roleRank('Deceased')).toBeNull();
    expect(roleRank('')).toBeNull();
  });

  it('picks the highest rank, never a dissociated person', () => {
    const picked = pickCslbOwner([
      person(1, 'Officer'),
      person(2, 'CEO/President', { dissociatedOn: '2020-01-01' }),
      person(3, 'RMO'),
      person(4, 'LLC Member'),
    ]);
    expect(picked?.id).toBe(3);
  });

  it('returns null when nobody current is owner-like', () => {
    expect(pickCslbOwner([person(1, 'RME'), person(2, 'Officer', { dissociatedOn: '2019-05-05' })])).toBeNull();
    expect(pickCslbOwner([])).toBeNull();
  });

  it('breaks a tie on the earliest association', () => {
    const picked = pickCslbOwner([person(1, 'Officer', { associatedOn: '2015-01-01' }), person(2, 'Officer', { associatedOn: '2005-01-01' })]);
    expect(picked?.id).toBe(2);
  });
});
