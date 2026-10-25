import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Agent } from 'undici';
import { addressResolverFor, createLookup, dnsServersFor, hostMatchesGlob } from '../src/fetch/dns';
import { closeDispatchers, getDispatcher } from '../src/fetch/dispatcher';
import {
  BodyTooLargeError,
  OfflineCacheMissError,
  RobotsDisallowedError,
  SourceDisabledError,
  SsrfRefusedError,
} from '../src/fetch/errors';
import { makeTestFetcher, testConfig, PUBLIC_IP } from './helpers';

const HOST = 'https://example-painting.test';
const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } };

describe('fetcher: cache', () => {
  it('GET returns the body, writes a gzip file under pages/ab/cd/<sha>.html.gz, and a second GET is served from disk', async () => {
    const { fetcher, agent, dataDir } = makeTestFetcher();
    agent.get(HOST).intercept({ path: '/about', method: 'GET' }).reply(200, '<html>About us</html>', HTML);

    const first = await fetcher.get(`${HOST}/about`, { source: 'websites' });
    expect(first.status).toBe(200);
    expect(first.text()).toContain('About us');
    expect(first.fromCache).toBe(false);
    expect(first.cachePath).toMatch(/pages[\\/][0-9a-f]{2}[\\/][0-9a-f]{2}[\\/][0-9a-f]{64}\.html\.gz$/);
    expect(first.cachePath!.startsWith(dataDir)).toBe(true);
    expect(existsSync(first.cachePath!)).toBe(true);
    expect(path.basename(first.cachePath!)).toBe(`${first.sha256}.html.gz`);

    // No second interceptor: a network call would throw (disableNetConnect).
    const second = await fetcher.get(`${HOST}/about`, { source: 'websites' });
    expect(second.fromCache).toBe(true);
    expect(second.text()).toBe(first.text());
    expect(second.sha256).toBe(first.sha256);
  });

  it('cache "refresh" goes to the network again and "none" neither reads nor writes', async () => {
    const { fetcher, agent } = makeTestFetcher();
    const pool = agent.get(HOST);
    pool.intercept({ path: '/a' }).reply(200, 'v1', HTML);
    pool.intercept({ path: '/a' }).reply(200, 'v2', HTML);
    pool.intercept({ path: '/n' }).reply(200, 'n1', HTML);
    expect((await fetcher.get(`${HOST}/a`, { source: 'websites' })).text()).toBe('v1');
    expect((await fetcher.get(`${HOST}/a`, { source: 'websites', cache: 'refresh' })).text()).toBe('v2');
    const none = await fetcher.get(`${HOST}/n`, { source: 'websites', cache: 'none' });
    expect(none.cachePath).toBeNull();
  });

  it('does not cache non-2xx responses', async () => {
    const { fetcher, agent } = makeTestFetcher();
    agent.get(HOST).intercept({ path: '/missing' }).reply(404, 'nope', HTML);
    const res = await fetcher.get(`${HOST}/missing`, { source: 'websites' });
    expect(res.status).toBe(404);
    expect(res.cachePath).toBeNull();
  });

  it('offline: true with an empty cache throws OfflineCacheMissError; after a cached fetch it returns the cached body', async () => {
    const { fetcher, agent } = makeTestFetcher();
    await expect(fetcher.get(`${HOST}/x`, { source: 'websites', offline: true })).rejects.toBeInstanceOf(OfflineCacheMissError);

    agent.get(HOST).intercept({ path: '/x' }).reply(200, 'cached body', HTML);
    await fetcher.get(`${HOST}/x`, { source: 'websites' });
    const off = await fetcher.get(`${HOST}/x`, { source: 'websites', offline: true });
    expect(off.fromCache).toBe(true);
    expect(off.text()).toBe('cached body');
  });

  it('readCached returns the stored body by sha256 and refuses non-hash keys', async () => {
    const { fetcher, agent } = makeTestFetcher();
    agent.get(HOST).intercept({ path: '/r' }).reply(200, 'readable', HTML);
    const res = await fetcher.get(`${HOST}/r`, { source: 'websites' });
    expect((await fetcher.readCached(res.sha256))?.toString()).toBe('readable');
    expect(await fetcher.readCached('../../etc/passwd')).toBeNull();
  });

  it('decodes gzip responses and follows a redirect, recording finalUrl', async () => {
    const { gzipSync } = await import('node:zlib');
    const { fetcher, agent } = makeTestFetcher();
    const pool = agent.get(HOST);
    pool.intercept({ path: '/old' }).reply(301, '', { headers: { location: '/new' } });
    pool.intercept({ path: '/new' }).reply(200, gzipSync(Buffer.from('zipped hello')), {
      headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
    });
    const res = await fetcher.get(`${HOST}/old`, { source: 'websites' });
    expect(res.finalUrl).toBe(`${HOST}/new`);
    expect(res.requestedUrl).toBe(`${HOST}/old`);
    expect(res.text()).toBe('zipped hello');
  });
});

describe('fetcher: source switch', () => {
  it('refuses a source that is switched off in the config', async () => {
    const { fetcher } = makeTestFetcher();
    await expect(fetcher.get('https://data.texas.gov/x', { source: 'tx_comptroller' })).rejects.toBeInstanceOf(SourceDisabledError);
  });
});

describe('fetcher: robots.txt per source', () => {
  it('refuses a disallowed path, allows the rest, and fetches robots.txt once per origin', async () => {
    const { fetcher, agent } = makeTestFetcher({ websitesRobots: 'respect' });
    const pool = agent.get(HOST);
    pool.intercept({ path: '/robots.txt' }).reply(200, 'User-agent: *\nDisallow: /private', { headers: { 'content-type': 'text/plain' } });
    pool.intercept({ path: '/ok' }).reply(200, 'fine', HTML);

    await expect(fetcher.get(`${HOST}/private/x`, { source: 'websites' })).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect((await fetcher.get(`${HOST}/ok`, { source: 'websites' })).text()).toBe('fine');
    expect(await fetcher.robotsAllowed(`${HOST}/private/y`, 'websites')).toBe(false);
  });

  it('robots.txt 404 allows everything', async () => {
    const { fetcher, agent } = makeTestFetcher({ websitesRobots: 'respect' });
    const pool = agent.get(HOST);
    pool.intercept({ path: '/robots.txt' }).reply(404, 'not found');
    pool.intercept({ path: '/private/x' }).reply(200, 'open', HTML);
    expect((await fetcher.get(`${HOST}/private/x`, { source: 'websites' })).text()).toBe('open');
  });

  it('robots.txt 5xx disallows everything (RFC 9309)', async () => {
    const { fetcher, agent } = makeTestFetcher({ websitesRobots: 'respect' });
    agent.get(HOST).intercept({ path: '/robots.txt' }).reply(503, 'down');
    await expect(fetcher.get(`${HOST}/anything`, { source: 'websites' })).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it('an unreachable robots.txt disallows everything', async () => {
    const { fetcher, agent } = makeTestFetcher({ websitesRobots: 'respect' });
    agent.get(HOST).intercept({ path: '/robots.txt' }).replyWithError(new Error('connection reset'));
    await expect(fetcher.get(`${HOST}/anything`, { source: 'websites' })).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it('a source configured robots "override" is allowed without fetching robots.txt', async () => {
    const { fetcher, agent } = makeTestFetcher({ websitesRobots: 'override' });
    // robots.txt is not intercepted: fetching it would fail the request.
    agent.get(HOST).intercept({ path: '/private/x' }).reply(200, 'allowed', HTML);
    expect((await fetcher.get(`${HOST}/private/x`, { source: 'websites' })).text()).toBe('allowed');
    expect(await fetcher.robotsAllowed(`${HOST}/private/x`, 'websites')).toBe(true);
  });
});

describe('fetcher: per-host rate limit', () => {
  it('spaces two requests to one host by minIntervalMs and does not delay other hosts', async () => {
    const { fetcher, agent, clock } = makeTestFetcher({ websitesIntervalMs: 1000 });
    const starts: Record<string, number[]> = { a: [], b: [] };
    const mk = (origin: string, key: 'a' | 'b') =>
      agent.get(origin).intercept({ path: /^\/p\d$/ }).reply(200, () => {
        starts[key].push(clock.ms());
        return 'x';
      }, HTML).persist();
    mk('https://a.test', 'a');
    mk('https://b.test', 'b');

    const t0 = clock.ms();
    await fetcher.get('https://a.test/p1', { source: 'websites', cache: 'none' });
    await fetcher.get('https://a.test/p2', { source: 'websites', cache: 'none' });
    await fetcher.get('https://b.test/p1', { source: 'websites', cache: 'none' });

    expect(starts.a[0]).toBe(t0);
    expect((starts.a[1] as number) - (starts.a[0] as number)).toBeGreaterThanOrEqual(1000);
    expect(starts.b[0]).toBe(starts.a[1]); // b was not delayed by a's spacing
  });
});

describe('fetcher: SSRF guard', () => {
  it.each(['http://127.0.0.1/x', 'http://10.1.2.3/x', 'http://172.16.0.1/x', 'http://172.31.255.255/x', 'http://192.168.1.1/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x', 'http://[fc00::1]/x', 'http://[fd12:3456::1]/x', 'http://0.0.0.0/x'])(
    'refuses %s',
    async (url) => {
      const { fetcher } = makeTestFetcher();
      await expect(fetcher.get(url, { source: 'websites' })).rejects.toBeInstanceOf(SsrfRefusedError);
    },
  );

  it('refuses a hostname that resolves to a private address', async () => {
    const { fetcher } = makeTestFetcher({ hosts: { 'internal.test': ['10.0.0.5'], 'mixed.test': [PUBLIC_IP, '127.0.0.1'] } });
    await expect(fetcher.get('https://internal.test/', { source: 'websites' })).rejects.toBeInstanceOf(SsrfRefusedError);
    await expect(fetcher.get('https://mixed.test/', { source: 'websites' })).rejects.toBeInstanceOf(SsrfRefusedError);
  });

  it.each(['file:///c:/windows/win.ini', 'ftp://example.com/x', 'javascript:alert(1)', 'data:text/html,hi'])('refuses the scheme of %s', async (url) => {
    const { fetcher } = makeTestFetcher();
    await expect(fetcher.get(url, { source: 'websites' })).rejects.toBeInstanceOf(SsrfRefusedError);
  });

  it('assertPublicUrl: private and file URLs throw SsrfRefusedError, public ones pass', async () => {
    const { fetcher } = makeTestFetcher();
    await expect(fetcher.assertPublicUrl('http://127.0.0.1/x')).rejects.toBeInstanceOf(SsrfRefusedError);
    await expect(fetcher.assertPublicUrl('file:///c:/x')).rejects.toBeInstanceOf(SsrfRefusedError);
    await expect(fetcher.assertPublicUrl('https://www.example-painting.test/')).resolves.toBeUndefined();
  });

  it('re-checks every redirect target', async () => {
    const { fetcher, agent } = makeTestFetcher();
    agent.get(HOST).intercept({ path: '/go' }).reply(302, '', { headers: { location: 'http://127.0.0.1/admin' } });
    await expect(fetcher.get(`${HOST}/go`, { source: 'websites' })).rejects.toBeInstanceOf(SsrfRefusedError);
  });

  it('fails after maxRedirects (5) hops', async () => {
    const { fetcher, agent } = makeTestFetcher({ maxRedirects: 5 });
    agent.get(HOST).intercept({ path: /^\/r\d*$/ }).reply(302, '', { headers: { location: '/r1' } }).persist();
    await expect(fetcher.get(`${HOST}/r`, { source: 'websites' })).rejects.toThrow(/too many redirects/);
  });
});

describe('fetcher: DNS overrides (D-21)', () => {
  const cfg = testConfig();

  it('matches *.texas.gov hosts but not the bare parent or other hosts', () => {
    expect(hostMatchesGlob('data.texas.gov', '*.texas.gov')).toBe(true);
    expect(hostMatchesGlob('comptroller.texas.gov', '*.texas.gov')).toBe(true);
    expect(hostMatchesGlob('texas.gov', '*.texas.gov')).toBe(false);
    expect(hostMatchesGlob('nottexas.gov', '*.texas.gov')).toBe(false);
    expect(dnsServersFor('data.texas.gov', cfg)).toEqual(['1.1.1.1', '8.8.8.8']);
    expect(dnsServersFor('example.com', cfg)).toBeNull();
  });

  it('routes data.texas.gov through the override servers and its lookup returns an ARRAY for {all: true}', async () => {
    let usedServers: string[] = [];
    const resolver = addressResolverFor('data.texas.gov', cfg, (servers) => {
      usedServers = servers;
      return {
        resolveMx: async () => [],
        resolve4: async () => ['104.18.1.1'],
        resolve6: async () => {
          throw new Error('no AAAA');
        },
      };
    });
    const lookup = createLookup(resolver) as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void;

    const all = await new Promise<unknown[]>((resolve) => lookup('data.texas.gov', { hints: 0, all: true }, (err, addrs) => resolve([err, addrs])));
    expect(usedServers).toEqual(['1.1.1.1', '8.8.8.8']);
    expect(all[0]).toBeNull();
    expect(all[1]).toEqual([{ address: '104.18.1.1', family: 4 }]);

    const single = await new Promise<unknown[]>((resolve) => lookup('data.texas.gov', {}, (err, addr, fam) => resolve([err, addr, fam])));
    expect(single).toEqual([null, '104.18.1.1', 4]);
  });

  it('the connect-time lookup refuses a host that resolves to a non-public address', async () => {
    const lookup = createLookup(async () => [{ address: '10.0.0.1', family: 4 }]) as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void;
    const err = await new Promise<unknown>((resolve) => lookup('rebind.test', { all: true }, (e) => resolve(e)));
    expect(err).toBeInstanceOf(SsrfRefusedError);
  });

  it('builds a dedicated undici Agent per host outside the test guard', async () => {
    const prev = process.env.PP_NETWORK_GUARD;
    delete process.env.PP_NETWORK_GUARD;
    try {
      const a = getDispatcher('data.texas.gov', cfg, { resolver: async () => [{ address: '104.18.1.1', family: 4 }] });
      expect(a).toBeInstanceOf(Agent);
      expect(getDispatcher('data.texas.gov', cfg)).toBe(a);
      await closeDispatchers();
    } finally {
      process.env.PP_NETWORK_GUARD = prev;
    }
  });
});

describe('fetcher: size limits', () => {
  it('aborts a response over maxBodyBytes with BodyTooLargeError', async () => {
    const { fetcher, agent } = makeTestFetcher({ maxBodyBytes: 100 });
    agent.get(HOST).intercept({ path: '/big' }).reply(200, 'x'.repeat(500), HTML);
    await expect(fetcher.get(`${HOST}/big`, { source: 'websites' })).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('a per-request maxBytes overrides the configured limit', async () => {
    const { fetcher, agent } = makeTestFetcher();
    agent.get(HOST).intercept({ path: '/mid' }).reply(200, 'x'.repeat(500), HTML);
    await expect(fetcher.get(`${HOST}/mid`, { source: 'websites', maxBytes: 10 })).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('download streams to disk with a sha256 and honours maxDownloadBytes', async () => {
    const { fetcher, agent, dataDir } = makeTestFetcher({ maxDownloadBytes: 2000 });
    const payload = Buffer.from('a|b|c\n1|2|3\n'.repeat(50));
    const pool = agent.get(HOST);
    pool.intercept({ path: '/file.txt' }).reply(200, payload, { headers: { 'content-type': 'text/plain' } });
    const dest = path.join(dataDir, 'downloads', 'file.txt');
    const r = await fetcher.download(`${HOST}/file.txt`, dest, { source: 'websites' });
    expect(r.bytes).toBe(payload.length);
    expect(r.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
    expect(readFileSync(dest).equals(payload)).toBe(true);

    pool.intercept({ path: '/huge.bin' }).reply(200, Buffer.alloc(5000, 1));
    const dest2 = path.join(dataDir, 'downloads', 'huge.bin');
    await expect(fetcher.download(`${HOST}/huge.bin`, dest2, { source: 'websites' })).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(existsSync(dest2)).toBe(false);
    expect(existsSync(`${dest2}.part`)).toBe(false);
  });

  it('download supports a POST form body', async () => {
    const { fetcher, agent, dataDir } = makeTestFetcher();
    agent.get(HOST).intercept({ path: '/dl', method: 'POST', body: 'a=1&b=2' }).reply(200, 'posted file');
    const dest = path.join(dataDir, 'downloads', 'posted.txt');
    const r = await fetcher.download(`${HOST}/dl`, dest, { source: 'websites', method: 'POST', form: { a: '1', b: '2' } });
    expect(r.bytes).toBe('posted file'.length);
  });
});

describe('fetcher: sessions', () => {
  it('keeps cookies across get/post, never shares them between sessions', async () => {
    const { fetcher, agent } = makeTestFetcher();
    const pool = agent.get(HOST);
    pool.intercept({ path: '/start' }).reply(200, '<form></form>', {
      headers: { 'content-type': 'text/html', 'set-cookie': ['ASP.NET_SessionId=abc123; path=/; HttpOnly', 'antiforgery=zzz; path=/'] },
    });
    pool.intercept({ path: '/submit', method: 'POST', headers: { cookie: (v: string) => v.includes('ASP.NET_SessionId=abc123') && v.includes('antiforgery=zzz') } }).reply(200, 'logged in');
    pool.intercept({ path: '/start' }).reply(200, 'other', { headers: { 'set-cookie': 'ASP.NET_SessionId=other; path=/' } });

    const s1 = fetcher.session('flow-1', 'websites');
    await s1.get(`${HOST}/start`);
    expect(s1.cookies()).toEqual({ 'ASP.NET_SessionId': 'abc123', antiforgery: 'zzz' });
    const res = await s1.post(`${HOST}/submit`, { name: 'x' });
    expect(res.text()).toBe('logged in');

    const s2 = fetcher.session('flow-2', 'websites');
    expect(s2.cookies()).toEqual({});
    await s2.get(`${HOST}/start`);
    expect(s2.cookies()).toEqual({ 'ASP.NET_SessionId': 'other' });
    expect(s1.cookies()['ASP.NET_SessionId']).toBe('abc123');
  });

  it('session responses are not cached by default', async () => {
    const { fetcher, agent } = makeTestFetcher();
    const pool = agent.get(HOST);
    pool.intercept({ path: '/s' }).reply(200, 'one', HTML);
    pool.intercept({ path: '/s' }).reply(200, 'two', HTML);
    const s = fetcher.session('nocache', 'websites');
    expect((await s.get(`${HOST}/s`)).text()).toBe('one');
    expect((await s.get(`${HOST}/s`)).text()).toBe('two');
  });
});

describe('fetcher: rendered pages', () => {
  it('storeRendered writes the HTML into the same cache and readCached returns it', async () => {
    const { fetcher } = makeTestFetcher();
    const html = '<html><body>Rendered by Chromium</body></html>';
    const stored = await fetcher.storeRendered(`${HOST}/spa`, html, { source: 'websites' });
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(stored.cachePath)).toBe(true);
    expect((await fetcher.readCached(stored.sha256))?.toString()).toBe(html);
  });
});
