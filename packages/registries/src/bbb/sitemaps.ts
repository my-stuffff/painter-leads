import * as cheerio from 'cheerio';
import type { Fetcher } from '@pp/core';
import { bbbGet, type BbbBreaker } from './breaker';

export const BBB_ROBOTS_URL = 'https://www.bbb.org/robots.txt';

function locs(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('loc')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((u) => u.length > 0);
}

/** A sitemap index: the URLs of the child sitemaps. */
export function parseBbbSitemapIndex(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  if ($('sitemapindex').length === 0) return [];
  return locs(xml);
}

/** A URL sitemap: the page URLs. */
export function parseBbbSitemap(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  if ($('urlset').length === 0) return [];
  return locs(xml);
}

/** "Basking Ridge" -> "basking-ridge" (the city part of a BBB profile URL). */
export function citySlug(city: string): string {
  return city
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Profile URLs of painting contractors in the given cities of a state: /us/<st>/<city>/profile/painting-contractors/<slug>. */
export function filterProfileUrls(urls: string[], where: { state: string; cities: string[] }): string[] {
  const st = where.state.toLowerCase();
  const cities = new Set(where.cities.map(citySlug));
  const re = /^https:\/\/www\.bbb\.org\/us\/([a-z]{2})\/([a-z0-9-]+)\/profile\/painting-contractors\/([a-z0-9-]+)\/?$/;
  return urls.filter((u) => {
    const m = re.exec(u);
    return m !== null && m[1] === st && cities.has(m[2] as string);
  });
}

/** The slug of a profile URL without BBB's trailing id parts ("...-llc-0221-1003377" -> "...-llc"). */
export function profileSlugName(url: string): string {
  const slug = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
  // BBB ends every profile slug with "-<bureau id, 4 digits>-<business id>".
  return slug.replace(/-\d{4}-\d+$/, '').replace(/-/g, ' ');
}

/**
 * The painting-contractor profile URLs of one state's city, found through BBB's business-profile sitemaps (robots.txt
 * allows them; the query-string search API is disallowed and never used). Bounded: at most `maxFetches` sitemaps.
 */
export async function discoverBbbProfileUrls(
  fetcher: Fetcher,
  breaker: BbbBreaker,
  where: { state: string; city: string },
  opts: { maxFetches?: number; offline?: boolean } = {},
): Promise<string[]> {
  const max = opts.maxFetches ?? 60;
  const robots = await bbbGet(fetcher, breaker, BBB_ROBOTS_URL, { offline: opts.offline });
  const roots = robots
    .text()
    .split(/\r?\n/)
    .map((l) => /^sitemap:\s*(\S+)/i.exec(l)?.[1])
    .filter((u): u is string => !!u && /business-?profile/i.test(u));
  const queue = [...roots];
  const found: string[] = [];
  let fetched = 0;
  while (queue.length > 0 && fetched < max) {
    const url = queue.shift() as string;
    fetched++;
    const res = await bbbGet(fetcher, breaker, url, { offline: opts.offline });
    if (res.status !== 200) continue;
    const xml = res.text();
    const children = parseBbbSitemapIndex(xml).filter((u) => /business-?profile/i.test(u));
    if (children.length > 0) {
      queue.push(...children);
      continue;
    }
    found.push(...filterProfileUrls(parseBbbSitemap(xml), { state: where.state, cities: [where.city] }));
  }
  return [...new Set(found)];
}
