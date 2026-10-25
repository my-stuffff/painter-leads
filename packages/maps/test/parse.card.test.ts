import { describe, expect, it } from 'vitest';
import type { CardSnapshot } from '../src/driver/types';
import { parseCard } from '../src/parse/card';
import { fakeCard, sdCards } from './helpers';

describe('parseCard on the 82 San Diego cards (probe copy)', () => {
  const cards = sdCards();
  const parsed = cards.map(parseCard);

  it('parses every card and every place id is a ChIJ id', () => {
    expect(parsed).toHaveLength(82);
    for (const p of parsed) {
      expect(p.name).toBeTruthy();
      expect(p.placeId?.startsWith('ChIJ')).toBe(true);
      expect(p.cid).toMatch(/^\d+$/);
    }
  });

  it('captures rating and review count on 81 cards and leaves the one without stars NULL, not 0', () => {
    const withBoth = parsed.filter((p) => p.rating.status === 'captured' && p.reviewCount.status === 'captured');
    expect(withBoth).toHaveLength(81);
    const missing = parsed.filter((p) => p.rating.status !== 'captured');
    expect(missing).toHaveLength(1);
    const m = missing[0];
    expect(m?.rating).toEqual({ value: null, status: 'not_on_card', snippet: null });
    expect(m?.reviewCount).toEqual({ value: null, status: 'not_on_card', snippet: null });
    // The card says "No reviews"; that is recorded for audit but never turned into a stored 0.
    expect(m?.noReviewsText).toBe(true);
  });

  it('reads category and street from the "Category · street" line', () => {
    const lifetime = parsed.find((p) => p.name === 'Lifetime Custom Painting Inc');
    expect(lifetime?.category.value).toBe('Painter');
    expect(lifetime?.street.value).toBe('3601 30th St');
    expect(lifetime?.street.snippet).toBe('Painter · 3601 30th St');
  });

  it('keeps a street-less card street-less (no digit, no street)', () => {
    const twain = parsed.find((p) => p.name === 'Local San Diego Painters');
    expect(twain?.category.value).toBe('Painter');
    expect(twain?.street.status).toBe('not_on_card');
    const noStreet = parsed.filter((p) => p.street.status !== 'captured');
    expect(noStreet.length).toBeGreaterThanOrEqual(20);
  });

  it('turns the display phone into E.164', () => {
    const lifetime = parsed.find((p) => p.name === 'Lifetime Custom Painting Inc');
    expect(lifetime?.phone.value).toBe('+16193148622');
    expect(lifetime?.phone.snippet).toContain('(619) 314-8622');
  });

  it('reads coordinates with every digit and a stable CID profile link', () => {
    const first = parsed[0];
    expect(first?.lat.value).toBe(33.0172666);
    expect(first?.lng.value).toBe(-116.8460104);
    expect(first?.profileUrl).toBe(`https://www.google.com/maps?cid=${first?.cid}`);
  });

  it('is deterministic: the same fixture twice gives identical rows in identical order', () => {
    expect(cards.map(parseCard)).toEqual(parsed);
  });
});

describe('parseCard details', () => {
  it('parses the rating decimal as shown and strips thousands separators', () => {
    const p = parseCard({ ...fakeCard(1), ratingAria: '4.8 stars 1,083 Reviews' });
    expect(p.rating.value).toBe(4.8);
    expect(p.reviewCount.value).toBe(1083);
    expect(p.rating.snippet).toBe('4.8 stars 1,083 Reviews');
  });

  it('never stores 0 for a card with no star label', () => {
    const p = parseCard({ ...fakeCard(2), ratingAria: null, text: 'Painter 2\nPainter 2\nPainter · 2 Main St' });
    expect(p.rating.value).toBeNull();
    expect(p.reviewCount.value).toBeNull();
    expect(p.rating.status).toBe('not_on_card');
  });

  it('keeps accents exactly as shown, composed (NFC)', () => {
    const decomposed = 'José Pintura';
    const p = parseCard({ ...fakeCard(3), name: decomposed });
    expect(p.name).toBe('José Pintura');
    expect(p.name?.normalize('NFC')).toBe(p.name);
  });

  it('flags a permanently closed card and treats an open/closed status line as not permanently closed', () => {
    const closed = parseCard({
      ...fakeCard(4),
      text: 'Painter 4\nPainter 4\n4.1(10)\nPainter · 4 Main St\nPermanently closed',
    });
    expect(closed.permanentlyClosed).toMatchObject({ value: true, status: 'captured', snippet: 'Permanently closed' });
    const open = parseCard(fakeCard(5));
    expect(open.permanentlyClosed.value).toBe(false);
    const noLine = parseCard({ ...fakeCard(6), text: 'Painter 6\nPainter 6\n4.1(10)\nPainter' });
    expect(noLine.permanentlyClosed.status).toBe('not_on_card');
  });

  it('unwraps a Google redirect link and refuses non-http links for the website', () => {
    const wrapped = parseCard({ ...fakeCard(7), websiteHref: 'https://www.google.com/url?q=https://paint7.example.com/&sa=U' });
    expect(wrapped.website.value).toBe('https://paint7.example.com/');
    const bad = parseCard({ ...fakeCard(8), websiteHref: 'javascript:alert(1)' });
    expect(bad.website.value).toBeNull();
    expect(bad.website.status).toBe('parse_failed');
    const none = parseCard({ ...fakeCard(9), websiteHref: null, text: 'Painter 9\nPainter 9\n4.1(10)\nPainter' });
    expect(none.website.status).toBe('not_on_card');
  });

  it('marks a malformed phone parse_failed rather than guessing', () => {
    const p = parseCard({ ...fakeCard(10), text: 'Painter 10\nPainter 10\n4.1(10)\nPainter\nOpen · (000) 000-0000' });
    expect(p.phone.value).toBeNull();
    expect(p.phone.status).toBe('parse_failed');
  });

  it('survives a card with no name label by falling back to the first text line', () => {
    const snap: CardSnapshot = { ...fakeCard(11), name: null };
    expect(parseCard(snap).name).toBe('Painter 11');
  });
});
