import { describe, expect, it } from 'vitest';
import { streetKey } from '../src/match/address';
import { isActiveStatus, matchLadder, rungFor, type LadderCandidate, type LadderCompany } from '../src/match/ladder';

function cand(over: Partial<LadderCandidate> & { key: string }): LadderCandidate {
  return {
    recordId: Number(over.key.replace(/\D/g, '')) || 1,
    nameNorm: null,
    nameCore: null,
    aliasNorms: [],
    city: null,
    zip: null,
    phoneLast10: null,
    status: 'CLEAR',
    expiresOn: '2027-01-31',
    ...over,
  };
}

const company = (over: Partial<LadderCompany> = {}): LadderCompany => ({
  name: "Joe's Painting LLC",
  city: 'San Diego',
  zip: '92101',
  phoneLast10: '6195550101',
  ...over,
});

describe('matchLadder rungs', () => {
  it('equal last 10 digits of the phone is a strong match (rung phone), whatever the name', () => {
    const r = matchLadder(company(), [cand({ key: '1', nameNorm: 'ZED', nameCore: 'ZED', phoneLast10: '6195550101' })]);
    expect(r.outcome).toBe('match');
    expect(r.chosen).toMatchObject({ key: '1', rung: 'phone', strength: 'strong' });
  });

  it('equal normalised name + same ZIP or same city is strong (name_loc); equal name elsewhere is only a candidate', () => {
    const same = cand({ key: '1', nameNorm: 'JOES PAINTING', nameCore: 'JOES', zip: '92101', city: 'X' });
    expect(matchLadder(company(), [same]).chosen).toMatchObject({ rung: 'name_loc', strength: 'strong' });
    const sameCity = cand({ key: '2', nameNorm: 'JOES PAINTING', nameCore: 'JOES', zip: '99999', city: 'SAN DIEGO' });
    expect(matchLadder(company(), [sameCity]).chosen?.strength).toBe('strong');
    const elsewhere = cand({ key: '3', nameNorm: 'JOES PAINTING', nameCore: 'JOES', zip: '10001', city: 'NEW YORK' });
    const r = matchLadder(company(), [elsewhere]);
    expect(r.outcome).toBe('candidate_only');
    expect(r.chosen).toBeNull();
    expect(r.records[0]).toMatchObject({ strength: 'candidate', rung: 'name' });
  });

  it('equal core (generic trade words dropped) + same city/ZIP is strong (core_loc)', () => {
    const c = cand({ key: '1', nameNorm: 'JOES PAINTING AND HOME IMPROVEMENT', nameCore: 'JOES', zip: '92101' });
    expect(rungFor(company(), c)).toEqual({ rung: 'core_loc', strength: 'strong' });
  });

  it('core containment alone is a candidate and is never promoted to a match', () => {
    const c = cand({ key: '1', nameNorm: 'GOLDEN RAINBOW SPECIAL', nameCore: 'GOLDEN RAINBOW SPECIAL', zip: '92101', city: 'SAN DIEGO' });
    const r = matchLadder(company({ name: 'Rainbow Painting', phoneLast10: null }), [c]);
    expect(r.outcome).toBe('candidate_only');
    expect(r.chosen).toBeNull();
    expect(r.records.every((x) => x.strength === 'candidate')).toBe(true);
  });

  it('a DBA / trade-name alias on either side matches (T/A names)', () => {
    const c = cand({
      key: '1',
      nameNorm: 'CHERRY PAINTING CONTRACTORS AND HOME IMPROVEMENT',
      nameCore: 'CHERRY',
      aliasNorms: ['ANTHONY CHERRY'],
      zip: '08817',
    });
    const r = matchLadder(company({ name: 'Anthony Cherry', zip: '08817', phoneLast10: null }), [c]);
    expect(r.chosen).toMatchObject({ strength: 'strong', rung: 'name_loc' });
  });

  it('nothing in common gives no match and no candidates', () => {
    const r = matchLadder(company(), [cand({ key: '1', nameNorm: 'ACME ROOFING', nameCore: 'ACME ROOFING', zip: '92101' })]);
    expect(r).toEqual({ outcome: 'none', chosen: null, records: [] });
  });
});

describe('matchLadder choosing between registrations', () => {
  const twin = (key: string, status: string, expiresOn: string) =>
    cand({ key, nameNorm: 'JOES PAINTING', nameCore: 'JOES', zip: '92101', status, expiresOn });

  it('prefers the Active registration over older expired ones', () => {
    const r = matchLadder(company(), [twin('1', 'Expired', '2024-03-31'), twin('2', 'Active', '2027-03-31'), twin('3', 'Expired', '2022-03-31')]);
    expect(r.outcome).toBe('match');
    expect(r.chosen?.key).toBe('2');
  });

  it('two Active strong registrations are ambiguous: candidates only, never a match', () => {
    const r = matchLadder(company(), [twin('1', 'Active', '2027-03-31'), twin('2', 'CLEAR', '2028-03-31')]);
    expect(r.outcome).toBe('candidate_only');
    expect(r.chosen).toBeNull();
    expect(r.records).toHaveLength(2);
    expect(r.records.every((x) => x.strength === 'candidate')).toBe(true);
  });

  it('with no Active registration the latest expiry wins only when it is unique', () => {
    const win = matchLadder(company(), [twin('1', 'Expired', '2022-03-31'), twin('2', 'Expired', '2024-03-31')]);
    expect(win.chosen?.key).toBe('2');
    const tie = matchLadder(company(), [twin('1', 'Expired', '2024-03-31'), twin('2', 'Expired', '2024-03-31')]);
    expect(tie.outcome).toBe('candidate_only');
  });

  it('a record reached by several rungs is counted once, at its best rung', () => {
    const c = cand({ key: '1', nameNorm: 'JOES PAINTING', nameCore: 'JOES', zip: '92101', phoneLast10: '6195550101' });
    const r = matchLadder(company(), [c]);
    expect(r.records).toHaveLength(1);
    expect(r.chosen?.rung).toBe('phone');
  });

  it('isActiveStatus accepts CLEAR and Active, not expired or suspended', () => {
    expect(isActiveStatus('CLEAR')).toBe(true);
    expect(isActiveStatus('Active')).toBe(true);
    expect(isActiveStatus('Expired')).toBe(false);
    expect(isActiveStatus('Work Comp Susp')).toBe(false);
    expect(isActiveStatus(null)).toBe(false);
  });
});

describe('streetKey', () => {
  it('normalises suffixes and drops units', () => {
    expect(streetKey('65 Reeds Rd')?.key).toBe('65 REEDS RD');
    expect(streetKey('65 REEDS ROAD, Suite 2')?.key).toBe('65 REEDS RD');
    expect(streetKey('1270 Picador Boulevard #Q')?.key).toBe('1270 PICADOR BLVD');
  });
  it('gives null for PO boxes and addresses without a street number', () => {
    expect(streetKey('P O BOX 144')).toBeNull();
    expect(streetKey('PO Box 9')).toBeNull();
    expect(streetKey('Reeds Road')).toBeNull();
    expect(streetKey(null)).toBeNull();
  });
});
