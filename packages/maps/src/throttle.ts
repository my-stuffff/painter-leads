/** A random whole-millisecond pause inside [min, max] (inclusive). `rng` returns a number in [0, 1). */
export function randomPause(range: readonly [number, number], rng: () => number = Math.random): number {
  const [min, max] = range;
  if (max <= min) return min;
  const r = Math.min(Math.max(rng(), 0), 0.9999999999);
  return min + Math.floor(r * (max - min + 1));
}

/** Small deterministic generator for tests (mulberry32). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
