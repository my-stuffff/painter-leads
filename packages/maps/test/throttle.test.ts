import { describe, expect, it } from 'vitest';
import { randomPause, seededRng } from '../src/throttle';

describe('randomPause', () => {
  it('always lands inside [10000, 20000] for searches and [4000, 8000] for place pages', () => {
    const rng = seededRng(7);
    for (let i = 0; i < 5000; i++) {
      const s = randomPause([10000, 20000], rng);
      const p = randomPause([4000, 8000], rng);
      expect(s).toBeGreaterThanOrEqual(10000);
      expect(s).toBeLessThanOrEqual(20000);
      expect(p).toBeGreaterThanOrEqual(4000);
      expect(p).toBeLessThanOrEqual(8000);
      expect(Number.isInteger(s) && Number.isInteger(p)).toBe(true);
    }
  });

  it('reaches both ends of the range and survives a generator that returns exactly 1', () => {
    expect(randomPause([10000, 20000], () => 0)).toBe(10000);
    expect(randomPause([10000, 20000], () => 0.9999999999)).toBe(20000);
    expect(randomPause([10000, 20000], () => 1)).toBe(20000);
    expect(randomPause([10000, 20000], () => -3)).toBe(10000);
    expect(randomPause([5, 5], () => 0.5)).toBe(5);
  });

  it('is random: a spread of values, and the same seed repeats exactly', () => {
    const draw = (seed: number) => {
      const rng = seededRng(seed);
      return Array.from({ length: 50 }, () => randomPause([10000, 20000], rng));
    };
    expect(draw(1)).toEqual(draw(1));
    expect(new Set(draw(1)).size).toBeGreaterThan(40);
    expect(draw(1)).not.toEqual(draw(2));
  });
});
