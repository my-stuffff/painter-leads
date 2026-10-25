import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BbbBlockedError, BbbBreaker, bbbGet, isCloudflareBlock } from '../src/bbb/breaker';
import { captureBbb, parseBbbDir } from '../src/bbb/capture';
import { parseBbbProfile } from '../src/bbb/profile';
import { citySlug, discoverBbbProfileUrls, filterProfileUrls, parseBbbSitemap, parseBbbSitemapIndex, profileSlugName } from '../src/bbb/sitemaps';
import { fixture, makeFetcher, tempDir } from './helpers';

const HOST = 'https://www.bbb.org';
const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } };
const CF = { headers: { 'content-type': 'text/html', server: 'cloudflare', 'cf-ray': '0000000000000000-KHI' } };
const JOHNS = `${HOST}/us/nj/basking-ridge/profile/painting-contractors/johns-painting-contractor-llc-0221-1003377`;

describe('parseBbbProfile', () => {
  it("John's Painting: employee John Catapano / Owner (honorific dropped), phone, website, address", () => {
    const p = parseBbbProfile(fixture('bbb', 'profile-johns-painting.html'), JOHNS);
    expect(p).toMatchObject({
      name: "John's Painting Contractor, LLC",
      telephone: '(908) 604-8759',
      website: 'https://www.johnspaint.com',
      city: 'Basking Ridge',
      region: 'NJ',
      zip: '07920-2801',
      peopleSource: 'json-ld',
    });
    expect(p.people).toEqual([{ name: 'John Catapano', givenName: 'John', familyName: 'Catapano', jobTitle: 'Owner', from: 'json-ld' }]);
    expect(p.people[0]?.name).not.toMatch(/Mr/);
  });

  it('keeps every employee and its job title (an owner and an operations manager)', () => {
    const p = parseBbbProfile(fixture('bbb', 'profile-austin-professional.html'), `${HOST}/us/tx/austin/profile/painting-contractors/austin-professional-painting-0825-90102730`);
    expect(p.people.map((x) => [x.name, x.jobTitle])).toEqual([
      ['Aurelio Contreras', 'Owner'],
      ['John Contreras', 'Operations Manager'],
    ]);
    expect(p.website).toBeNull();
  });

  it("without employee[] it uses the 'Business Management:' line", () => {
    const p = parseBbbProfile(fixture('bbb', 'profile-management-line-only.html'), `${HOST}/us/nj/edison/profile/painting-contractors/fixture-painters-of-edison-0221-1`);
    expect(p.peopleSource).toBe('business-management');
    expect(p.people).toEqual([{ name: 'Jane Example', givenName: 'Jane', familyName: 'Example', jobTitle: 'President', from: 'business-management' }]);
  });

  it('a profile with neither JSON-LD employees nor a management line has no owner', () => {
    const p = parseBbbProfile(fixture('bbb', 'profile-no-owner.html'), `${HOST}/us/nj/edison/profile/painting-contractors/nameless-painting-0221-3000001`);
    expect(p.people).toEqual([]);
    expect(p.peopleSource).toBe('none');
    expect(p.telephone).toBe('(732) 555-0177');
  });

  it('survives broken JSON-LD and a page with no data at all', () => {
    const p = parseBbbProfile('<html><script type="application/ld+json">{oops</script><body>hello</body></html>', JOHNS);
    expect(p).toMatchObject({ name: null, people: [], peopleSource: 'none' });
  });
});

describe('sitemaps', () => {
  it('parses the index and the profile sitemap, and filters painting profiles by state and city', () => {
    const children = parseBbbSitemapIndex(fixture('bbb', 'sitemap-index.xml'));
    expect(children).toEqual([`${HOST}/sitemap-business-profiles-1.xml`, `${HOST}/sitemap-business-profiles-2.xml`]);
    expect(parseBbbSitemap(fixture('bbb', 'sitemap-index.xml'))).toEqual([]);
    const urls = parseBbbSitemap(fixture('bbb', 'sitemap-business-profiles-1.xml'));
    expect(urls).toHaveLength(5);
    expect(parseBbbSitemapIndex(fixture('bbb', 'sitemap-business-profiles-1.xml'))).toEqual([]);
    expect(filterProfileUrls(urls, { state: 'NJ', cities: ['Basking Ridge', 'Edison'] })).toEqual([JOHNS, `${HOST}/us/nj/edison/profile/painting-contractors/nameless-painting-0221-3000001`]);
    expect(filterProfileUrls(urls, { state: 'TX', cities: ['Austin'] })).toHaveLength(1);
    expect(filterProfileUrls(urls, { state: 'NJ', cities: ['Newark'] })).toEqual([]);
  });

  it('slugs: city and profile name', () => {
    expect(citySlug('Basking Ridge')).toBe('basking-ridge');
    expect(citySlug("St. John's")).toBe('st-john-s');
    expect(profileSlugName(JOHNS)).toBe('johns painting contractor llc');
  });

  it('walks robots.txt -> index -> profile sitemaps and returns the painting profiles of one city', async () => {
    const { fetcher, agent } = makeFetcher();
    const pool = agent.get(HOST);
    pool.intercept({ path: '/robots.txt', method: 'GET' }).reply(200, fixture('bbb', 'robots.txt'), { headers: { 'content-type': 'text/plain' } });
    pool.intercept({ path: '/sitemap-index-business-profiles.xml', method: 'GET' }).reply(200, fixture('bbb', 'sitemap-index.xml'), HTML);
    pool.intercept({ path: '/sitemap-business-profiles-1.xml', method: 'GET' }).reply(200, fixture('bbb', 'sitemap-business-profiles-1.xml'), HTML);
    pool.intercept({ path: '/sitemap-business-profiles-2.xml', method: 'GET' }).reply(200, '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', HTML);
    const urls = await discoverBbbProfileUrls(fetcher, new BbbBreaker(), { state: 'NJ', city: 'Edison' });
    expect(urls).toEqual([`${HOST}/us/nj/edison/profile/painting-contractors/nameless-painting-0221-3000001`]);
  });
});

describe('Cloudflare block and the circuit breaker', () => {
  it('a 403 with a Cloudflare marker is a block; a plain 403 or a 404 is not', () => {
    const body = fixture('bbb', 'cloudflare-403.html');
    expect(isCloudflareBlock({ status: 403, headers: { server: 'cloudflare' }, text: () => body })).toBe(true);
    expect(isCloudflareBlock({ status: 403, headers: {}, text: () => body })).toBe(true);
    expect(isCloudflareBlock({ status: 403, headers: {}, text: () => 'Forbidden' })).toBe(false);
    expect(isCloudflareBlock({ status: 404, headers: { server: 'cloudflare' }, text: () => body })).toBe(false);
  });

  it('the first Cloudflare 403 trips the breaker; later requests are refused WITHOUT any request', async () => {
    const { fetcher, agent, calls } = makeFetcher();
    agent.get(HOST).intercept({ path: '/robots.txt', method: 'GET' }).reply(403, fixture('bbb', 'cloudflare-403.html'), CF);
    const breaker = new BbbBreaker();
    await expect(bbbGet(fetcher, breaker, `${HOST}/robots.txt`)).rejects.toBeInstanceOf(BbbBlockedError);
    expect(breaker.tripped).toBe(true);
    const seen = calls().length;
    await expect(bbbGet(fetcher, breaker, JOHNS)).rejects.toBeInstanceOf(BbbBlockedError);
    await expect(bbbGet(fetcher, breaker, `${HOST}/anything`)).rejects.toBeInstanceOf(BbbBlockedError);
    expect(calls()).toHaveLength(seen);
    expect(calls().filter((c) => c.includes('bbb.org'))).toHaveLength(1);
  });
});

describe('capture and offline parse', () => {
  it('captures listed profile URLs as <sha256>.html.gz plus a manifest, and parses them offline', async () => {
    const { fetcher, agent } = makeFetcher();
    const pool = agent.get(HOST);
    const johns = fixture('bbb', 'profile-johns-painting.html');
    pool.intercept({ path: new URL(JOHNS).pathname, method: 'GET' }).reply(200, johns, HTML);
    pool.intercept({ path: '/us/nj/edison/profile/painting-contractors/gone-0221-1', method: 'GET' }).reply(404, 'not found', HTML);
    const dir = tempDir();
    const r = await captureBbb(fetcher, { urls: [JOHNS, `${HOST}/us/nj/edison/profile/painting-contractors/gone-0221-1`] }, dir, {
      now: () => new Date('2026-10-25T12:00:00Z'),
      note: 'unit test',
    });
    expect(r.blocked).toBe(false);
    expect(r.manifest.entries.map((e) => e.status)).toEqual([200, 404]);
    const files = readdirSync(dir).sort();
    expect(files).toContain('manifest.json');
    const gz = files.find((f) => f.endsWith('.html.gz')) as string;
    expect(gz).toBe(`${r.manifest.entries[0]?.sha256}.html.gz`);
    expect(gunzipSync(readFileSync(path.join(dir, gz))).toString('utf8')).toBe(johns);

    const parsed = await parseBbbDir(dir);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.page.profile.people[0]?.name).toBe('John Catapano');
    expect(parsed[0]?.page.capturedAt.toISOString()).toBe('2026-10-25T12:00:00.000Z');
    expect(parsed[0]?.page.sourceUrl).toBe(JOHNS);
  });

  it('a Cloudflare block stops the capture, is written to the manifest as blocked, and nothing else is requested', async () => {
    const { fetcher, agent, calls } = makeFetcher();
    agent.get(HOST).intercept({ path: new URL(JOHNS).pathname, method: 'GET' }).reply(403, fixture('bbb', 'cloudflare-403.html'), CF);
    const dir = tempDir();
    const r = await captureBbb(fetcher, { urls: [JOHNS, `${HOST}/us/nj/edison/profile/painting-contractors/x-0221-1`, `${HOST}/us/nj/edison/profile/painting-contractors/y-0221-2`] }, dir);
    expect(r.blocked).toBe(true);
    expect(r.manifest.entries.map((e) => e.status)).toEqual(['blocked']);
    expect(calls().filter((c) => c.includes('bbb.org'))).toHaveLength(1);
    expect((await parseBbbDir(dir))).toEqual([]);
  });
});
