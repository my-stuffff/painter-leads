import { describe, expect, it } from 'vitest';
import { mulberry32, shuffle } from '../src/accuracy/prng';
import { wilson } from '../src/accuracy/wilson';

describe('wilson 95% interval (D-38, Pitfall 16)', () => {
  it.each([
    [147, 150, 0.943, 0.993],
    [392, 400, 0.961, 0.99],
    [29, 30, 0.833, 0.994],
  ])('%i of %i -> [%f, %f]', (k, n, low, high) => {
    const w = wilson(k, n);
    expect(w.low as number).toBeCloseTo(low, 3);
    expect(w.high as number).toBeCloseTo(high, 3);
    expect(w.point).toBeCloseTo(k / n, 10);
    expect(w.n).toBe(n);
  });

  it('stays inside [0, 1] at the edges and says nothing for n = 0', () => {
    const all = wilson(30, 30);
    expect(all.high).toBeLessThanOrEqual(1);
    expect(all.low as number).toBeGreaterThan(0.88);
    const none = wilson(0, 30);
    expect(none.low).toBe(0);
    expect(none.high as number).toBeLessThan(0.12);
    expect(wilson(0, 0)).toEqual({ n: 0, correct: 0, point: null, low: null, high: null });
  });

  it('a wider interval for fewer values', () => {
    const small = wilson(9, 10);
    const large = wilson(900, 1000);
    expect((small.high as number) - (small.low as number)).toBeGreaterThan((large.high as number) - (large.low as number));
  });
});

describe('seeded PRNG', () => {
  it('the same seed gives the same sequence, a different seed another one', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => mulberry32(43)())).not.toEqual(seqA);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('shuffle keeps every element, does not touch its input, and repeats for a seed', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const s1 = shuffle(items, mulberry32(7));
    expect([...s1].sort((a, b) => a - b)).toEqual(items);
    expect(items[0]).toBe(0);
    expect(shuffle(items, mulberry32(7))).toEqual(s1);
    expect(s1).not.toEqual(items);
  });
});
