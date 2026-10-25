import { describe, expect, it } from 'vitest';
import type { CompanyRef } from '@pp/core';
import { replayers } from '../src/replay';

const company = (over: Partial<CompanyRef> = {}): CompanyRef => ({
  companyId: 1,
  name: "Joe's Painting LLC",
  state: 'CA',
  city: 'San Diego',
  zip: '92101',
  street: null,
  websiteUrl: null,
  phoneE164: '+16195550101',
  categories: ['Painter'],
  ...over,
});

const replay = replayers.registryMatch as NonNullable<typeof replayers.registryMatch>;

describe('replayers.registryMatch', () => {
  it('a phone match is the strong result', () => {
    const r = replay({ company: company(), candidates: [{ source_key: '1000001', legal_name: 'ZED INC', phone_last10: '6195550101', city: 'X', zip: '1' }] });
    expect(r).toEqual([{ sourceKey: '1000001', strength: 'strong' }]);
  });

  it('accepts camelCase rows and a phone in E.164; names are normalised here', () => {
    const r = replay({ company: company({ phoneE164: null }), candidates: [{ sourceKey: 'A1', legalName: 'JOES PAINTING INC', city: 'SAN DIEGO', zip: '92101', status: 'CLEAR' }] });
    expect(r).toEqual([{ sourceKey: 'A1', strength: 'strong' }]);
    const phone = replay({ company: company(), candidates: [{ sourceKey: 'B2', legalName: 'Other', phoneE164: '+16195550101' }] });
    expect(phone).toEqual([{ sourceKey: 'B2', strength: 'strong' }]);
  });

  it('name-only candidates stay candidates; unrelated rows give nothing', () => {
    const cand = replay({ company: company({ phoneE164: null, zip: '10001', city: 'New York' }), candidates: [{ source_key: 'C3', legal_name: "JOE'S PAINTING", city: 'SAN DIEGO', zip: '92101' }] });
    expect(cand).toEqual([{ sourceKey: 'C3', strength: 'candidate' }]);
    expect(replay({ company: company(), candidates: [{ source_key: 'D4', legal_name: 'ACME ROOFING', city: 'San Diego', zip: '92101' }] })).toEqual([]);
    expect(replay({ company: company(), candidates: [] })).toEqual([]);
  });

  it('two Active registrations of the same name are both candidates (ambiguous)', () => {
    const rows = [
      { source_key: 'E5', legal_name: "JOE'S PAINTING LLC", city: 'SAN DIEGO', zip: '92101', status: 'Active' },
      { source_key: 'E6', legal_name: "JOE'S PAINTING INC", city: 'SAN DIEGO', zip: '92101', status: 'Active' },
    ];
    const r = replay({ company: company({ phoneE164: null }), candidates: rows });
    expect(r.map((x) => x.strength)).toEqual(['candidate', 'candidate']);
  });

  it('prefers the Active registration over an expired one', () => {
    const rows = [
      { source_key: 'F7', legal_name: "JOE'S PAINTING LLC", city: 'SAN DIEGO', zip: '92101', status: 'Expired', expires_on: '2022-01-01' },
      { source_key: 'F8', legal_name: "JOE'S PAINTING LLC", city: 'SAN DIEGO', zip: '92101', status: 'Active', expires_on: '2027-01-01' },
    ];
    expect(replay({ company: company({ phoneE164: null }), candidates: rows })).toEqual([{ sourceKey: 'F8', strength: 'strong' }]);
  });
});
