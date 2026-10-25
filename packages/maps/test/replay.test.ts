import { describe, expect, it } from 'vitest';
import type { CardSnapshot } from '../src/driver/types';
import { parseCard } from '../src/parse/card';
import { packageModule } from '../src/index';
import { mapsCard } from '../src/replay';
import { fakeCard, readFixture, sdCards } from './helpers';

describe('replayers.mapsCard', () => {
  it('is registered on the maps package module', () => {
    expect(packageModule.replayers.mapsCard).toBe(mapsCard);
  });

  it('returns name, rating, review_count, phone (E.164), category and website exactly as parseCard reads them', () => {
    const lifetime = sdCards().find((c) => c.name === 'Lifetime Custom Painting Inc') as CardSnapshot;
    expect(mapsCard(lifetime)).toEqual({
      name: 'Lifetime Custom Painting Inc',
      rating: '4.9',
      review_count: '306',
      phone: '+16193148622',
      category: 'Painter',
      website: null,
    });
  });

  it('agrees with parseCard on every card of three fixtures, including the website link', () => {
    const smoke = readFixture<{ cards: CardSnapshot[] }>('smoke-1-search.json').cards;
    for (const c of [...sdCards(), ...smoke, fakeCard(1)]) {
      const p = parseCard(c);
      const r = mapsCard(c);
      expect(r.name).toBe(p.name);
      expect(r.phone).toBe(p.phone.value);
      expect(r.category).toBe(p.category.value);
      expect(r.website).toBe(p.website.value);
      expect(r.rating).toBe(p.rating.value === null ? null : String(p.rating.value));
      expect(r.review_count).toBe(p.reviewCount.value === null ? null : String(p.reviewCount.value));
    }
    const certapro = smoke.find((c) => c.name === 'CertaPro Painters of Edison, NJ') as CardSnapshot;
    expect(mapsCard(certapro).website).toContain('https://certapro.com/edison/');
  });

  it('gives null (never "0") for a card with no star label', () => {
    const noStars = sdCards().find((c) => c.ratingAria === null) as CardSnapshot;
    expect(mapsCard(noStars)).toMatchObject({ rating: null, review_count: null });
  });
});
