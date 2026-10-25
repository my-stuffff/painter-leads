/** 97.5th percentile of the standard normal distribution (two-sided 95%). */
export const Z_95 = 1.959963984540054;

export interface Interval {
  n: number;
  correct: number;
  /** correct / n; null when n is 0. */
  point: number | null;
  low: number | null;
  high: number | null;
}

/**
 * Wilson score interval (D-38, research Pitfall 16). Behaves for n = 0 (everything null) and for 0 / n and n / n
 * (the interval never leaves [0, 1]).
 */
export function wilson(correct: number, n: number, z: number = Z_95): Interval {
  if (n <= 0) return { n: 0, correct: 0, point: null, low: null, high: null };
  const p = correct / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    n,
    correct,
    point: p,
    low: Math.max(0, centre - half),
    high: Math.min(1, centre + half),
  };
}
