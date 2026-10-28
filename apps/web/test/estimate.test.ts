import { describe, expect, it } from 'vitest';
import { estimateMinutes } from '../src/shared/api';

describe('estimateMinutes', () => {
  const cities = [
    { state: 'NJ', zipCount: 9 },
    { state: 'TX', zipCount: 92 },
  ];
  it('spreads the work over the workers but never below the busiest state', () => {
    // 18.5 + 143 = 161.5 over 2 workers = 80.75, but Texas alone takes 143 (one city per state at a time).
    expect(estimateMinutes(cities, 2)).toBe(143);
    expect(estimateMinutes(cities, 1)).toBe(161.5);
    expect(estimateMinutes([{ state: 'TX', zipCount: 10 }, { state: 'CA', zipCount: 10 }], 2)).toBe(20);
  });
  it('counts only what is left of a running city, and nothing for none', () => {
    expect(estimateMinutes([{ state: 'CA', zipCount: 10, left: 0.5 }], 2)).toBe(10);
    expect(estimateMinutes([], 2)).toBe(0);
  });
});
