import { describe, expect, it } from 'vitest';
import { loadConfig } from '@pp/core';
import { isDriftOk, ratingOk, reviewCountOk } from '../src/accuracy/drift';

const drift = loadConfig().accuracy.drift;

describe('drift rule (D-38)', () => {
  it('config carries the owner numbers: max(2, 3%) reviews, 0.1 rating', () => {
    expect(drift).toEqual({ reviewAbs: 2, reviewPct: 0.03, ratingTol: 0.1 });
  });

  it('review count: captured 120, live 122 is correct', () => {
    expect(reviewCountOk(120, 122, drift)).toBe(true);
    expect(isDriftOk('review_count', 120, 122, { reviewCountChanged: true }, drift)).toBe(true);
  });

  it('review count: live 125 is more than max(2, 3%) = 3.6 above 120, so wrong', () => {
    expect(reviewCountOk(120, 125, drift)).toBe(false);
  });

  it('review count: fewer than captured is wrong', () => {
    expect(reviewCountOk(120, 119, drift)).toBe(false);
  });

  it('review count: the percentage allowance takes over for large counts, the absolute one for small counts', () => {
    expect(reviewCountOk(400, 412, drift)).toBe(true); // 12 = 3%
    expect(reviewCountOk(400, 413, drift)).toBe(false);
    expect(reviewCountOk(10, 12, drift)).toBe(true); // 2 absolute
    expect(reviewCountOk(10, 13, drift)).toBe(false);
    expect(reviewCountOk(25, 25, drift)).toBe(true);
  });

  it('rating 4.8 captured vs 4.7 live is correct when the review count also changed', () => {
    expect(ratingOk(4.8, 4.7, true, drift)).toBe(true);
    expect(isDriftOk('rating', 4.8, 4.7, { reviewCountChanged: true }, drift)).toBe(true);
  });

  it('the same difference with an unchanged review count is wrong', () => {
    expect(ratingOk(4.8, 4.7, false, drift)).toBe(false);
  });

  it('equal ratings are correct either way; a bigger gap is wrong even with new reviews', () => {
    expect(ratingOk(4.8, 4.8, false, drift)).toBe(true);
    expect(ratingOk(4.8, 4.5, true, drift)).toBe(false);
  });
});
