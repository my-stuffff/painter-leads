import { describe, expect, it } from 'vitest';
import { ladderNj, leadName, type NjLadderInput } from '../src/nj/match';
import { streetKey } from '../src/match/address';
import type { LadderCandidate } from '../src/match/ladder';

// Every name, number and address below is made up.
function cand(over: Partial<LadderCandidate> & { key: string; nameNorm: string; nameCore: string }): LadderCandidate {
  return { recordId: 1, aliasNorms: [], city: 'Edison', zip: '08817', phoneLast10: null, status: 'Active', expiresOn: '2027-03-31', ...over };
}
const company = (over: Partial<NjLadderInput['company']> = {}): NjLadderInput => ({
  company: { name: 'Zorblat Painting', city: 'Edison', zip: '08817', street: null, ...over },
  licenceNumbers: [],
  websiteDomain: null,
});
const run = (input: NjLadderInput, records: LadderCandidate[], streets: Record<string, string> = {}, emails: Record<string, string> = {}) =>
  ladderNj(input, records, new Map(Object.entries(emails)), new Map(Object.entries(streets)));

describe('streetKey: a bare unit after the street suffix', () => {
  it('drops a digit+letter unit ("5B") that follows a street suffix', () => {
    expect(streetKey('21 Quux Blvd 5B')?.key).toBe('21 QUUX BLVD');
    expect(streetKey('21 Quux Boulevard, 12C')?.key).toBe('21 QUUX BLVD');
  });
  it('keeps route numbers, lettered avenues and plain trailing numbers (they are part of the street)', () => {
    expect(streetKey('10 Highway 9')?.key).toBe('10 HWY 9');
    expect(streetKey('10 Route 1 South')?.key).toBe('10 RT 1 S');
    expect(streetKey('10 Avenue A')?.key).toBe('10 AVE A');
    expect(streetKey('5 Main St 12')?.key).toBe('5 MAIN ST 12');
  });
  it('keeps a street whose name is a number + letter when no suffix precedes it', () => {
    expect(streetKey('14 5B Road')?.key).toBe('14 5B RD');
  });
});

describe('NJ ladder: street address needs a name token in common', () => {
  const rec = cand({ key: '13VH00000001', nameNorm: 'QUUX HOME IMPROVEMENT', nameCore: 'QUUX' });

  it('same street + same ZIP + a shared distinctive name token = a strong match (rung address)', () => {
    const out = run(company({ name: 'Quux Painting & Remodeling', street: '21 Quux Blvd' }), [rec], { '13VH00000001': '21 Quux Blvd 5B' });
    expect(out.outcome).toBe('match');
    expect(out.chosen?.rung).toBe('address');
    expect((out.records[0] as { note?: string }).note).toMatch(/QUUX/);
  });

  it('same street + same ZIP but no name token in common is NOT a match (another business at the address)', () => {
    const out = run(company({ name: 'Wibble Wobble Painting', street: '21 Quux Blvd' }), [rec], { '13VH00000001': '21 Quux Blvd' });
    expect(out.outcome).toBe('none');
  });

  it('one shared trade word ("Painting") is not enough: two painters in one building are two businesses', () => {
    const other = cand({ key: '13VH00000002', nameNorm: 'WIBBLE PAINTING', nameCore: 'WIBBLE' });
    const out = run(company({ name: 'Zorblat Painting', street: '21 Quux Blvd' }), [other], { '13VH00000002': '21 Quux Blvd' });
    expect(out.outcome).toBe('none');
  });

  it('two shared words of any kind are enough (the same business under a longer Google name)', () => {
    const r = cand({ key: '13VH00000006', nameNorm: 'MY HANDYMAN AND PAINTER', nameCore: 'MY' });
    const out = run(company({ name: 'My Handyman, Painter and Property Maintenance.', zip: '08820', street: '102 George Ave' }), [r], { '13VH00000006': '102 George Ave' });
    expect(out.chosen?.rung).toBe('address');
  });

  it('a possessive on one side ("Bart" / "Barts") is still the same word', () => {
    const r = cand({ key: '13VH00000007', nameNorm: 'BARTS PROFESSIONAL PAINTING', nameCore: 'BARTS', city: 'Colonia', zip: '07067' });
    const out = run(company({ name: 'Bart Professional Painting - New Jersey', city: 'Colonia', zip: '07067', street: '382 New Dover Rd' }), [r], { '13VH00000007': '382 New Dover Rd' });
    expect(out.chosen?.rung).toBe('address');
  });

  it('place and quality words alone ("New Jersey Quality") are not a common name token', () => {
    const r = cand({ key: '13VH00000003', nameNorm: 'NEW JERSEY QUALITY ROOFING', nameCore: 'NEW JERSEY QUALITY ROOFING' });
    const out = run(company({ name: 'New Jersey Quality Painting', street: '21 Quux Blvd' }), [r], { '13VH00000003': '21 Quux Blvd' });
    expect(out.outcome).not.toBe('match');
  });

  it('same street in another town (different ZIP and city) is not a match even with a shared token', () => {
    const r = cand({ key: '13VH00000004', nameNorm: 'QUUX HOME IMPROVEMENT', nameCore: 'QUUX', city: 'Fords', zip: '08863' });
    const out = run(company({ name: 'Quux Wibble Painting', street: '21 Quux Blvd' }), [r], { '13VH00000004': '21 Quux Blvd' });
    expect(out.outcome).not.toBe('match');
    expect(out.chosen).toBeNull();
  });

  it('a roster row without a ZIP matches on the same city', () => {
    const r = cand({ key: '13VH00000005', nameNorm: 'QUUX HOME IMPROVEMENT', nameCore: 'QUUX', zip: null, city: 'Edison' });
    const out = run(company({ name: 'Quux Wibble Painting', zip: '08837', street: '21 Quux Blvd' }), [r], { '13VH00000005': '21 Quux Blvd' });
    expect(out.chosen?.rung).toBe('address');
  });

  it('a different street number is not the same address', () => {
    const out = run(company({ name: 'Quux Wibble Painting', street: '23 Quux Blvd' }), [rec], { '13VH00000001': '21 Quux Blvd 5B' });
    expect(out.outcome).not.toBe('match');
  });
});

describe('leadName: a Google tagline after the business name', () => {
  it('cuts at a spaced dash, en/em dash or bar', () => {
    expect(leadName('Quux Home Improvement – Transforming Homes with Painting')).toBe('Quux Home Improvement');
    expect(leadName('Quux Home Improvement - Painting & Remodeling')).toBe('Quux Home Improvement');
    expect(leadName('Quux Painting | Edison NJ')).toBe('Quux Painting');
    expect(leadName('Quux Painting — Edison')).toBe('Quux Painting');
  });
  it('leaves a name without a spaced separator alone (hyphenated names stay whole)', () => {
    expect(leadName('Quux-Wibble Painting')).toBe('Quux-Wibble Painting');
    expect(leadName('J&A Painting')).toBe('J&A Painting');
  });
  it('does not cut down to nothing', () => {
    expect(leadName(' - Painting')).toBe(' - Painting');
  });
});

describe('NJ ladder: tagline names', () => {
  const rec = cand({ key: '13VH00000010', nameNorm: 'QUUX HOME IMPROVEMENT', nameCore: 'QUUX' });
  it('the name before the tagline + same ZIP matches the registered name (rung name_zip)', () => {
    const out = run(company({ name: 'Quux Home Improvement – Transforming Homes with Painting & Remodeling' }), [rec]);
    expect(out.outcome).toBe('match');
    expect(out.chosen?.rung).toBe('name_zip');
  });
  it('the same tagline name in another town does not match', () => {
    const out = run(company({ name: 'Quux Home Improvement – Painting', city: 'Fords', zip: '08863' }), [rec]);
    expect(out.outcome).not.toBe('match');
  });
  it('a tagline that only shares generic words with a registered name does not match', () => {
    const r = cand({ key: '13VH00000011', nameNorm: 'ACME HOME IMPROVEMENT', nameCore: 'ACME' });
    const out = run(company({ name: 'Zorblat – Home Improvement & Painting' }), [r]);
    expect(out.outcome).not.toBe('match');
  });
});

describe('NJ ladder: near-misses stay out', () => {
  it('same normalised name in a different town and no other key is only a candidate', () => {
    const r = cand({ key: '13VH00000020', nameNorm: 'ZORBLAT PAINTING', nameCore: 'ZORBLAT', city: 'Fords', zip: '08863' });
    const out = run(company(), [r]);
    expect(out.outcome).toBe('candidate_only');
  });
  it('"Pro Painting LLC" vs "Pro Painting Services Inc" in the same town: generic cores never equal', () => {
    const r = cand({ key: '13VH00000021', nameNorm: 'PRO PAINTING SERVICES', nameCore: '' });
    const out = run(company({ name: 'Pro Painting LLC' }), [r]);
    expect(out.outcome).not.toBe('match');
  });
  it('a company with no address and no ZIP is never promoted on its name alone', () => {
    const r = cand({ key: '13VH00000022', nameNorm: 'ZORBLAT PAINTING', nameCore: 'ZORBLAT' });
    const out = run(company({ city: null, zip: null }), [r]);
    expect(out.outcome).toBe('candidate_only');
    expect(out.chosen).toBeNull();
  });
  it('a plural/singular difference is a fuzzy name: no match', () => {
    const r = cand({ key: '13VH00000023', nameNorm: 'ZORBLATS PAINTER', nameCore: 'ZORBLATS' });
    const out = run(company({ name: 'Zorblat Painters' }), [r]);
    expect(out.outcome).not.toBe('match');
  });
});
