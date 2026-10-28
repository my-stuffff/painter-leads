import { describe, expect, it } from 'vitest';
import { loadConfig } from '@pp/core';
import { DEFAULT_JOB_SETTINGS } from '../src/contract';
import { ruleLine, summarise } from '../src/export';
import { compareRows, dedupe, dedupeKey, pickList } from '../src/lists';
import { exportConfig, pipelineConfig, readSettings } from '../src/settings';
import type { LeadRow } from '../src/contract';

const q = (name: string, category: string | null = 'Painter') => ({ qualified: true, reasons: [], name, category });
const nq = (reasons: string[], name = 'Ace Painting') => ({ qualified: false, reasons, name, category: 'Painter' });

describe('the three lists (28 Oct workbook rules)', () => {
  it('painting = qualified, the name says painting and Google lists it as Painter or Painting', () => {
    expect(pickList(q('Ace Painting LLC'))).toEqual({ list: 'painting', whyNot: null });
    expect(pickList(q('Best Coatings', 'Painting'))).toEqual({ list: 'painting', whyNot: null });
    for (const name of ['Prime Finishes', 'True Color', 'Colour Masters', 'Brush Strokes', 'Deck Stain Co', 'Wall Doctors', 'Drywall Pros']) {
      expect(pickList(q(name))?.list, name).toBe('painting');
    }
  });

  it('check first = qualified, but the name does not say painting or the category is something else', () => {
    expect(pickList(q('Honey-Do Handyman'))).toEqual({ list: 'check', whyNot: null });
    expect(pickList(q('Green Tech Remodeling & Design INC'))).toEqual({ list: 'check', whyNot: null });
    expect(pickList(q('Ace Painting', 'House painter'))).toEqual({ list: 'check', whyNot: null });
    expect(pickList(q('Ace Painting', 'Contractor'))).toEqual({ list: 'check', whyNot: null });
    expect(pickList(q('Ace Painting', null))).toEqual({ list: 'check', whyNot: null });
  });

  it('likely fits = not qualified only for also commercial / residential status unclear, said in plain words', () => {
    expect(pickList(nq(['also commercial']))).toEqual({ list: 'likely', whyNot: 'Also does commercial work' });
    expect(pickList(nq(['residential status unclear']))).toEqual({ list: 'likely', whyNot: "Couldn't confirm it does houses only" });
    // a likely fit keeps whatever the name and category say
    expect(pickList(nq(['also commercial'], 'Triple M Construction'))?.list).toBe('likely');
  });

  it('any other reason keeps a company out of every list', () => {
    expect(pickList(nq(['also commercial', 'outside pilot area']))).toBeNull();
    expect(pickList(nq(['residential status unclear', 'rating below minimum']))).toBeNull();
    expect(pickList(nq(['commercial only']))).toBeNull();
    expect(pickList(nq(['not a painting contractor']))).toBeNull();
    expect(pickList(nq(['rating not captured', 'review count not captured']))).toBeNull();
    expect(pickList(nq([]))).toBeNull();
  });
});

describe('dedupe and order', () => {
  it('keeps the first row per Google profile link (first city wins), company id when there is no link', () => {
    const rows = [
      { city: 'Dallas', url: 'https://www.google.com/maps?cid=1', id: 1 },
      { city: 'Plano', url: 'https://www.google.com/maps?cid=1', id: 9 },
      { city: 'Plano', url: null, id: 2 },
      { city: 'Austin', url: '  ', id: 2 },
      { city: 'Austin', url: null, id: 3 },
    ];
    const kept = dedupe(rows, (r) => dedupeKey(r.url, r.id));
    expect(kept.map((r) => `${r.city}:${r.id}`)).toEqual(['Dallas:1', 'Plano:2', 'Austin:3']);
  });

  it('sorts by State, Search city, Company (case-insensitive), company id last', () => {
    const r = (state: string, searchCity: string, company: string, companyId = 1) => ({ state, searchCity, company, companyId });
    const sorted = [r('TX', 'Dallas', 'b'), r('CA', 'Fresno', 'z'), r('TX', 'Austin', 'Z'), r('TX', 'Austin', 'a', 2), r('TX', 'Austin', 'a', 1)].sort(
      compareRows,
    );
    expect(sorted.map((x) => `${x.state}/${x.searchCity}/${x.company}/${x.companyId}`)).toEqual([
      'CA/Fresno/z/1',
      'TX/Austin/a/1',
      'TX/Austin/a/2',
      'TX/Austin/Z/1',
      'TX/Dallas/b/1',
    ]);
  });
});

describe('job settings and configs', () => {
  it('fills missing or malformed settings with the defaults', () => {
    expect(readSettings(null)).toEqual(DEFAULT_JOB_SETTINGS);
    expect(readSettings({ minRating: 4.5, terms: [' house painter ', '', 3] })).toEqual({
      ...DEFAULT_JOB_SETTINGS,
      minRating: 4.5,
      terms: ['house painter'],
    });
    expect(readSettings({ terms: [] }).terms).toEqual(DEFAULT_JOB_SETTINGS.terms);
  });

  it('the pipeline gets only the job terms; the export gets only the job thresholds; the base is untouched', () => {
    const base = loadConfig();
    const before = JSON.stringify(base);
    const s = { ...DEFAULT_JOB_SETTINGS, minRating: 4.2, minReviews: 5, maxReviews: 500, terms: ['cabinet painting'] };
    const p = pipelineConfig(base, s);
    expect(p.search.terms).toEqual(['cabinet painting']);
    expect(p.qualification).toEqual(base.qualification);
    const e = exportConfig(base, s);
    expect(e.qualification).toEqual({ ...base.qualification, minRating: 4.2, minReviews: 5, maxReviews: 500 });
    expect(e.search).toEqual(base.search);
    expect(e.report).toEqual(base.report);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('says the rule in one line', () => {
    expect(ruleLine(DEFAULT_JOB_SETTINGS)).toBe('Residential only, Google rating ≥ 4.7, reviews 10–99. Blank = not found; nothing guessed.');
  });
});

describe('summary', () => {
  const lead = (list: LeadRow['list'], state: LeadRow['state'], fill: Partial<LeadRow> = {}): LeadRow =>
    ({ list, state, owner: null, phone: null, email: null, website: null, ...fill }) as LeadRow;

  it('counts each list, per state, and the filled-in fields of the painting list only', () => {
    const s = summarise(
      [
        lead('painting', 'TX', { owner: 'A', phone: '1', website: 'w' }),
        lead('painting', 'CA', { email: 'e' }),
        lead('check', 'TX', { owner: 'B', phone: '2', email: 'x', website: 'y' }),
        lead('likely', 'TX'),
      ],
      3,
      new Date('2026-10-28T10:00:00Z'),
      ['CA', 'TX', 'NJ'],
    );
    expect(s).toEqual({
      builtAt: '2026-10-28T10:00:00.000Z',
      counts: { painting: 2, check: 1, likely: 1 },
      byState: { CA: { painting: 1, check: 0, likely: 0 }, TX: { painting: 1, check: 1, likely: 1 }, NJ: { painting: 0, check: 0, likely: 0 } },
      fill: { owner: 1, phone: 1, email: 1, website: 1 },
      citiesIncluded: 3,
    });
  });
});
