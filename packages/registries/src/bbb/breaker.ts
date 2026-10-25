import type { FetchOptions, FetchResult, Fetcher } from '@pp/core';

export class BbbBlockedError extends Error {
  constructor(message = 'bbb.org answered with a Cloudflare block') {
    super(message);
    this.name = 'BbbBlockedError';
  }
}

/** A Cloudflare block page (this laptop: 403 on every bbb.org URL, an IP-level block). */
export function isCloudflareBlock(res: { status: number; headers: Record<string, string>; text(): string }): boolean {
  if (res.status !== 403 && res.status !== 429 && res.status !== 503) return false;
  const h = res.headers;
  if (h['cf-mitigated'] || h['cf-ray'] || (h.server ?? '').toLowerCase().includes('cloudflare')) return true;
  return res.status === 403 && /cloudflare|you have been blocked/i.test(res.text().slice(0, 4000));
}

/**
 * Per-run circuit breaker: the first Cloudflare block trips it; from then on no request goes to bbb.org and every
 * company's BBB status is 'blocked' - never "no owner" (D-21).
 */
export class BbbBreaker {
  private reason: string | null = null;

  get tripped(): boolean {
    return this.reason !== null;
  }

  get why(): string | null {
    return this.reason;
  }

  trip(reason: string): void {
    this.reason ??= reason;
  }
}

/** GET a bbb.org URL through the breaker: refused without a request when tripped; a Cloudflare block trips it. */
export async function bbbGet(
  fetcher: Fetcher,
  breaker: BbbBreaker,
  url: string,
  opts: Partial<FetchOptions> = {},
): Promise<FetchResult> {
  if (breaker.tripped) throw new BbbBlockedError(`bbb.org is blocked for this run (${breaker.why})`);
  const res = await fetcher.get(url, { cache: 'use', ...opts, source: 'bbb' });
  if (isCloudflareBlock(res)) {
    breaker.trip(`HTTP ${res.status} from Cloudflare at ${new URL(url).pathname}`);
    throw new BbbBlockedError(`HTTP ${res.status} Cloudflare block`);
  }
  return res;
}
