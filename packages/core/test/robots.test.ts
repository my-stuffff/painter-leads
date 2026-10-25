import { describe, expect, it } from 'vitest';
import { RobotsCache, type RobotsFetchResult } from '../src/fetch/robots';

function cacheWith(res: RobotsFetchResult | null, calls: { n: number } = { n: 0 }, clock = { t: 0 }) {
  const cache = new RobotsCache(
    async () => {
      calls.n++;
      return res;
    },
    24,
    () => new Date(clock.t),
  );
  return { cache, calls, clock };
}

describe('RobotsCache (RFC 9309)', () => {
  it('applies Disallow and Allow rules with wildcards', async () => {
    const { cache } = cacheWith({
      status: 200,
      text: 'User-agent: *\nDisallow: /*/\nAllow: /taxes/\nDisallow: /data-search/',
    });
    expect(await cache.allowed('https://x.test/data-search/franchise-tax/1')).toBe(false);
    expect(await cache.allowed('https://x.test/taxes/forms')).toBe(true);
    expect(await cache.allowed('https://x.test/')).toBe(true);
  });

  it('4xx allows all; 5xx and unreachable disallow all', async () => {
    expect(await cacheWith({ status: 404, text: '' }).cache.allowed('https://x.test/a')).toBe(true);
    expect(await cacheWith({ status: 403, text: '' }).cache.allowed('https://x.test/a')).toBe(true);
    expect(await cacheWith({ status: 500, text: '' }).cache.allowed('https://x.test/a')).toBe(false);
    expect(await cacheWith(null).cache.allowed('https://x.test/a')).toBe(false);
  });

  it('caches per origin for the configured hours, then refetches', async () => {
    const { cache, calls, clock } = cacheWith({ status: 200, text: 'User-agent: *\nDisallow: /no' });
    await cache.allowed('https://x.test/a');
    await cache.allowed('https://x.test/b');
    expect(calls.n).toBe(1);
    await cache.allowed('https://y.test/a');
    expect(calls.n).toBe(2);
    clock.t += 25 * 3_600_000;
    await cache.allowed('https://x.test/a');
    expect(calls.n).toBe(3);
  });
});
