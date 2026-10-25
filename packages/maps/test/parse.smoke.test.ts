import { describe, expect, it } from 'vitest';
import type { FixturePage } from '../src/driver/types';
import { parseCard } from '../src/parse/card';
import { readFixture } from './helpers';

type SearchFixture = Extract<FixturePage, { kind: 'search' }>;

describe('parseCard on the live smoke searches', () => {
  const smoke1 = readFixture<SearchFixture>('smoke-1-search.json');
  const smoke2 = readFixture<SearchFixture>('smoke-2-search.json');
  const smoke3 = readFixture<SearchFixture>('smoke-3-search.json');

  it('the saved smoke files are search fixtures with the counts the live run reported', () => {
    expect(smoke1.kind).toBe('search');
    expect(smoke1.cards).toHaveLength(116);
    expect(smoke1.endReached).toBe(false);
    expect(smoke2.cards).toHaveLength(77);
    expect(smoke3.cards).toHaveLength(120);
    expect(smoke3.endReached).toBe(true);
    expect(smoke1.landedUrl).toBe('https://www.google.com/maps/search/house%20painter%2008817/?hl=en&gl=us');
  });

  it('every smoke card parses to a place id, CID and a name; coordinates are captured unless the link has none', () => {
    const noCoords: string[] = [];
    for (const c of [...smoke1.cards, ...smoke2.cards, ...smoke3.cards]) {
      const p = parseCard(c);
      expect(p.name).toBeTruthy();
      expect(p.placeId?.startsWith('ChIJ')).toBe(true);
      expect(p.cid).toMatch(/^\d+$/);
      if (p.lat.status === 'captured') {
        expect(p.lng.status).toBe('captured');
      } else {
        // A card whose link carries no !3d/!4d (live: 'House Painting By Elvis'): NULL, never 0.
        expect(p.lat).toEqual({ value: null, status: 'not_on_card', snippet: null });
        noCoords.push(p.name as string);
      }
    }
    expect(noCoords).toEqual(['House Painting By Elvis']);
  });

  it('captures rating and review count together, and leaves the rest NULL with not_on_card', () => {
    const parsed = smoke1.cards.map(parseCard);
    const withRating = parsed.filter((p) => p.rating.status === 'captured');
    expect(withRating).toHaveLength(112);
    for (const p of withRating) {
      expect(p.reviewCount.status).toBe('captured');
      expect(p.rating.value).toBeGreaterThanOrEqual(1);
      expect(p.rating.value).toBeLessThanOrEqual(5);
      expect(Number.isInteger(p.reviewCount.value)).toBe(true);
    }
    const without = parsed.filter((p) => p.rating.status !== 'captured');
    expect(without).toHaveLength(4);
    for (const p of without) {
      expect(p.rating).toEqual({ value: null, status: 'not_on_card', snippet: null });
      expect(p.reviewCount.value).toBeNull();
    }
  });

  it('reads the website link from the card and the phone as E.164', () => {
    const parsed = smoke1.cards.map(parseCard);
    expect(parsed.filter((p) => p.website.status === 'captured')).toHaveLength(94);
    const certapro = parsed.find((p) => p.name === 'CertaPro Painters of Edison, NJ');
    expect(certapro?.website.value).toBe(
      'https://certapro.com/edison/landing-page/residential-gbp/?utm_source=google&utm_medium=organic&utm_campaign=gbp_landing',
    );
    expect(certapro?.phone.value).toBe('+17322046020');
    expect(certapro?.category.value).toBe('Painter');
    expect(certapro?.street.value).toBe('2045 Woodbridge Ave');
    expect(certapro?.rating.value).toBe(4.6);
    expect(certapro?.reviewCount.value).toBe(224);
    // Every phone on every card is a valid E.164 number or not captured.
    for (const p of parsed) {
      if (p.phone.status === 'captured') expect(p.phone.value).toMatch(/^\+1\d{10}$/);
    }
  });

  it('parsing the same fixture twice gives identical rows in identical order', () => {
    expect(smoke3.cards.map(parseCard)).toEqual(smoke3.cards.map(parseCard));
  });
});
