import { describe, expect, it } from 'vitest';
import { loadConfig } from '@pp/core';
import { flagFranchise } from '../src/franchise';
import { planMerge, type MergeListing } from '../src/merge';

const config = loadConfig();

let nextId = 1;
const L = (over: Partial<MergeListing> & { name: string }): MergeListing => ({
  id: nextId++,
  placeId: `ChIJ${nextId}`,
  phoneE164: null,
  websiteUrl: null,
  zip: null,
  companyId: null,
  ...over,
});

const groupsOf = (listings: MergeListing[]): number[][] =>
  planMerge(listings, config).groups.map((g) => g.members).sort((a, b) => (a[0] as number) - (b[0] as number));

describe('merge ladder (D-26, REC-01)', () => {
  it('same phone + same registrable domain -> one company, rung phone', () => {
    const a = L({ name: 'Acme Painting', phoneE164: '+17325550100', websiteUrl: 'https://www.acmepainting.com' });
    const b = L({ name: 'Acme House Painters', phoneE164: '+17325550100', websiteUrl: 'http://acmepainting.com/contact' });
    const plan = planMerge([a, b], config);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({ survivor: a.id, members: [a.id, b.id], rung: 'phone' });
    expect(plan.mergesByRung.phone).toBe(1);
  });

  it('same phone, different domain and different name -> two companies linked by possible_duplicate_of', () => {
    const a = L({ name: 'Alpha Painting', phoneE164: '+17325550111', websiteUrl: 'https://alphapainting.com' });
    const b = L({ name: 'Zeta Coatings', phoneE164: '+17325550111', websiteUrl: 'https://zetacoatings.com' });
    const plan = planMerge([a, b], config);
    expect(plan.groups).toHaveLength(2);
    expect(plan.possibleDuplicates.get(b.id)).toBe(a.id);
    expect(plan.mergesByRung.phone).toBe(0);
  });

  it('same phone with the same normalised name merges (entity suffix and case ignored)', () => {
    const a = L({ name: 'Acme Painting LLC', phoneE164: '+17325550122' });
    const b = L({ name: 'ACME PAINTING', phoneE164: '+17325550122' });
    expect(groupsOf([a, b])).toEqual([[a.id, b.id]]);
  });

  it('same non-shared domain -> one company, rung domain', () => {
    const a = L({ name: 'Bright Walls', websiteUrl: 'https://brightwalls.com' });
    const b = L({ name: 'Bright Walls Interior Division', websiteUrl: 'https://www.brightwalls.com/interior' });
    const plan = planMerge([a, b], config);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.rung).toBe('domain');
  });

  it('never merges on a shared host', () => {
    const a = L({ name: 'Maria Paints', websiteUrl: 'https://maria.business.site' });
    const b = L({ name: 'Joe Painting', websiteUrl: 'https://joe.business.site' });
    const c = L({ name: 'Facebook Pros One', websiteUrl: 'https://www.facebook.com/prosone' });
    const d = L({ name: 'Facebook Pros Two', websiteUrl: 'https://www.facebook.com/prostwo' });
    expect(planMerge([a, b, c, d], config).groups).toHaveLength(4);
  });

  it('two franchise locations of one brand domain stay two companies, both flagged franchise', () => {
    const a = L({ name: 'CertaPro Painters of Edison', websiteUrl: 'https://certapro.com/edison', zip: '08817' });
    const b = L({ name: 'CertaPro Painters of Metuchen', websiteUrl: 'https://certapro.com/metuchen', zip: '08840' });
    const plan = planMerge([a, b], config);
    expect(plan.groups).toHaveLength(2);
    expect(plan.groups.every((g) => g.franchise && g.franchiseBrand === 'CertaPro Painters')).toBe(true);
  });

  it('franchise locations that share a call-center phone do not merge either', () => {
    const a = L({ name: 'Five Star Painting of Edison', phoneE164: '+18005550101', websiteUrl: 'https://fivestarpainting.com/edison', zip: '08817' });
    const b = L({ name: 'Five Star Painting of Woodbridge', phoneE164: '+18005550101', websiteUrl: 'https://fivestarpainting.com/woodbridge', zip: '07095' });
    const plan = planMerge([a, b], config);
    expect(plan.groups).toHaveLength(2);
    expect(plan.possibleDuplicates.get(b.id)).toBe(a.id);
  });

  it('same normalised name + same ZIP -> one company, rung name_zip', () => {
    const a = L({ name: 'Smith & Sons Painting, Inc.', zip: '08817' });
    const b = L({ name: 'SMITH AND SONS PAINTING', zip: '08817-1234' });
    const plan = planMerge([a, b], config);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.rung).toBe('name_zip');
  });

  it('name + ZIP uses the core normaliser: diacritics stripped, entity suffixes removed, 5-digit ZIP text', () => {
    const a = L({ name: 'Café Muñoz Painting LLC', zip: '08817' });
    const b = L({ name: 'Cafe Munoz Painting', zip: '08817' });
    const c = L({ name: 'Cafe Munoz Painting', zip: '08820' });
    expect(groupsOf([a, b, c])).toEqual([[a.id, b.id], [c.id]]);
  });

  it('a listing with no phone, no website and no ZIP merges only on place id (so never)', () => {
    const a = L({ name: 'Plain Painting' });
    const b = L({ name: 'Plain Painting' });
    const plan = planMerge([a, b], config);
    expect(plan.groups).toHaveLength(2);
    expect(plan.mergesByRung).toEqual({ place_id: 2, phone: 0, domain: 0, name_zip: 0 });
  });

  it('the chain phone -> domain -> name_zip joins transitively and the survivor is the lowest listing id', () => {
    const a = L({ name: 'Chain One', phoneE164: '+17325550133', websiteUrl: 'https://chain.com' });
    const b = L({ name: 'Chain One Again', phoneE164: '+17325550133', websiteUrl: 'https://chain.com' });
    const c = L({ name: 'Unrelated Name', websiteUrl: 'https://chain.com' });
    const d = L({ name: 'Other Co', zip: '08837' });
    const e = L({ name: 'Other Co', zip: '08837' });
    const plan = planMerge([e, d, c, b, a], config);
    expect(plan.groups.map((g) => [g.survivor, g.members])).toEqual([
      [a.id, [a.id, b.id, c.id]],
      [d.id, [d.id, e.id]],
    ]);
  });

  it('is order independent: every permutation gives the same companies', () => {
    const listings = [
      L({ name: 'Acme Painting', phoneE164: '+17325550100', websiteUrl: 'https://acmepainting.com', zip: '08817' }),
      L({ name: 'Acme House Painters', phoneE164: '+17325550100', websiteUrl: 'https://acmepainting.com' }),
      L({ name: 'Alpha Painting', phoneE164: '+17325550111', websiteUrl: 'https://alphapainting.com' }),
      L({ name: 'Zeta Coatings', phoneE164: '+17325550111', websiteUrl: 'https://zetacoatings.com' }),
      L({ name: 'Smith and Sons Painting', zip: '08837' }),
      L({ name: 'Smith & Sons Painting Inc', zip: '08837' }),
      L({ name: 'CertaPro Painters of Edison', websiteUrl: 'https://certapro.com/e' }),
      L({ name: 'CertaPro Painters of Metuchen', websiteUrl: 'https://certapro.com/m' }),
    ];
    const reference = JSON.stringify(planMerge(listings, config), (_k, v) => (v instanceof Map ? [...v] : v));
    const permutations: MergeListing[][] = [[...listings].reverse()];
    for (let seed = 1; seed <= 12; seed++) {
      const copy = [...listings];
      let s = seed * 7919;
      for (let i = copy.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) % 2147483648;
        const j = s % (i + 1);
        [copy[i], copy[j]] = [copy[j] as MergeListing, copy[i] as MergeListing];
      }
      permutations.push(copy);
    }
    for (const p of permutations) {
      expect(JSON.stringify(planMerge(p, config), (_k, v) => (v instanceof Map ? [...v] : v))).toBe(reference);
    }
  });

  it('counts the merges each rung produced', () => {
    const a = L({ name: 'One', phoneE164: '+17325550144', websiteUrl: 'https://one.com' });
    const b = L({ name: 'One Two', phoneE164: '+17325550144', websiteUrl: 'https://one.com' });
    const c = L({ name: 'Three', websiteUrl: 'https://one.com' });
    const d = L({ name: 'Four Co', zip: '08817' });
    const e = L({ name: 'Four', zip: '08817' });
    const plan = planMerge([a, b, c, d, e], config);
    expect(plan.mergesByRung).toEqual({ place_id: 5, phone: 1, domain: 1, name_zip: 1 });
  });
});

describe('franchise flag (R7)', () => {
  it('matches a configured brand by name prefix, case-insensitively', () => {
    expect(flagFranchise('CERTAPRO PAINTERS of Edison NJ', null, config)).toEqual({ franchise: true, brand: 'CertaPro Painters' });
    expect(flagFranchise('five star painting - central nj', null, config).franchise).toBe(true);
  });

  it('matches a configured brand domain', () => {
    expect(flagFranchise('Edison House Painters', 'https://www.wow1day.com/edison', config)).toEqual({
      franchise: true,
      brand: 'WOW 1 DAY PAINTING',
    });
  });

  it('does not flag an independent painter whose name merely contains a brand word', () => {
    expect(flagFranchise('The Five Star Painting Guys', 'https://fivestarguys.com', config).franchise).toBe(false);
    expect(flagFranchise('Acme Painting', null, config)).toEqual({ franchise: false, brand: null });
  });
});
