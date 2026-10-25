import { describe, expect, it } from 'vitest';
import { EXCLUSION_REASON_ORDER, loadConfig, type ExclusionReason } from '@pp/core';
import { qualify, type QualifyFacts } from '../src/qualify';

const config = loadConfig();

const good: QualifyFacts = {
  painterStatus: 'painter',
  residentialStatus: 'residential_only',
  hasGoogleProfile: true,
  permanentlyClosed: false,
  inArea: true,
  rating: 4.8,
  reviewCount: 50,
};

const withFacts = (over: Partial<QualifyFacts>): QualifyFacts => ({ ...good, ...over });

describe('qualify: thresholds are inclusive and come from config (QUAL-03, QUAL-04)', () => {
  it('config has the D-05 numbers this test relies on', () => {
    expect(config.qualification).toMatchObject({ minRating: 4.7, minReviews: 10, maxReviews: 99 });
  });

  it.each([
    ['rating 4.7', { rating: 4.7 }],
    ['10 reviews', { reviewCount: 10 }],
    ['99 reviews', { reviewCount: 99 }],
    ['rating 5', { rating: 5 }],
  ] as [string, Partial<QualifyFacts>][])('%s qualifies', (_name, over) => {
    expect(qualify(withFacts(over), config)).toEqual({ qualified: true, reasons: [] });
  });

  it.each([
    ['rating 4.6', { rating: 4.6 }, 'rating below minimum'],
    ['9 reviews', { reviewCount: 9 }, 'review count below minimum'],
    ['100 reviews', { reviewCount: 100 }, 'review count above maximum'],
  ] as [string, Partial<QualifyFacts>, ExclusionReason][])('%s does not qualify', (_name, over, reason) => {
    expect(qualify(withFacts(over), config)).toEqual({ qualified: false, reasons: [reason] });
  });

  it('a rating or review count that was not captured says so, never below minimum', () => {
    expect(qualify(withFacts({ rating: null }), config).reasons).toEqual(['rating not captured']);
    expect(qualify(withFacts({ reviewCount: null }), config).reasons).toEqual(['review count not captured']);
    expect(qualify(withFacts({ rating: null, reviewCount: null }), config).reasons).toEqual([
      'rating not captured',
      'review count not captured',
    ]);
  });

  it('a captured review count of 0 is a real number and is below the minimum', () => {
    expect(qualify(withFacts({ reviewCount: 0 }), config).reasons).toEqual(['review count below minimum']);
  });

  it('changing minRating in the config from 4.7 to 4.8 excludes a 4.7 company with no code change', () => {
    const facts = withFacts({ rating: 4.7 });
    expect(qualify(facts, config).qualified).toBe(true);
    const stricter = { ...config, qualification: { ...config.qualification, minRating: 4.8 } };
    expect(qualify(facts, stricter)).toEqual({ qualified: false, reasons: ['rating below minimum'] });
  });

  it('thresholds are read from config for reviews too', () => {
    const wider = { ...config, qualification: { ...config.qualification, maxReviews: 150 } };
    expect(qualify(withFacts({ reviewCount: 100 }), wider).qualified).toBe(true);
  });
});

describe('qualify: every exclusion reason', () => {
  const cases: [ExclusionReason, Partial<QualifyFacts>][] = [
    ['not a painting contractor', { painterStatus: 'not_painter' }],
    ['also commercial', { residentialStatus: 'residential_and_commercial' }],
    ['commercial only', { residentialStatus: 'commercial_only' }],
    ['residential status unclear', { residentialStatus: 'unclear' }],
    ['residential status unclear', { residentialStatus: null }],
    ['no Google profile', { hasGoogleProfile: false }],
    ['permanently closed', { permanentlyClosed: true }],
    ['outside pilot area', { inArea: false }],
    ['rating not captured', { rating: null }],
    ['rating below minimum', { rating: 3 }],
    ['review count not captured', { reviewCount: null }],
    ['review count below minimum', { reviewCount: 1 }],
    ['review count above maximum', { reviewCount: 500 }],
  ];

  it.each(cases)('%s', (reason, over) => {
    const r = qualify(withFacts(over), config);
    expect(r.qualified).toBe(false);
    expect(r.reasons).toContain(reason);
  });

  it('covers every reason of the core list', () => {
    const covered = new Set(cases.map(([r]) => r));
    for (const r of EXCLUSION_REASON_ORDER) expect(covered.has(r)).toBe(true);
  });

  it('an unrecognised painter category never qualifies', () => {
    expect(qualify(withFacts({ painterStatus: 'unknown' }), config).reasons).toEqual(['not a painting contractor']);
  });

  it('a not-painter lists its other facts but is not judged on residential status', () => {
    const r = qualify(withFacts({ painterStatus: 'not_painter', residentialStatus: null, rating: 3 }), config);
    expect(r.reasons).toEqual(['not a painting contractor', 'rating below minimum']);
  });

  it('requireResidentialOnly and requireGoogleProfile switch their rules off from config', () => {
    const lax = { ...config, qualification: { ...config.qualification, requireResidentialOnly: false, requireGoogleProfile: false } };
    expect(qualify(withFacts({ residentialStatus: 'commercial_only', hasGoogleProfile: false }), lax).qualified).toBe(true);
  });
});

describe('qualify: reasons always appear in the core order', () => {
  it('several reasons come out in EXCLUSION_REASON_ORDER', () => {
    const facts = withFacts({
      painterStatus: 'not_painter',
      hasGoogleProfile: false,
      permanentlyClosed: true,
      inArea: false,
      rating: null,
      reviewCount: 1000,
    });
    const r = qualify(facts, config);
    expect(r.reasons).toEqual([
      'not a painting contractor',
      'no Google profile',
      'permanently closed',
      'outside pilot area',
      'rating not captured',
      'review count above maximum',
    ]);
    const idx = r.reasons.map((x) => EXCLUSION_REASON_ORDER.indexOf(x));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('the same facts always give the same reason string', () => {
    const facts = withFacts({ rating: 1, reviewCount: 0, permanentlyClosed: true });
    expect(qualify(facts, config).reasons.join('; ')).toBe(qualify({ ...facts }, config).reasons.join('; '));
  });
});
