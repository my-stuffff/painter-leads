import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { MockAgent } from 'undici';
import { createFetcher, loadConfig, type DnsResolver, type Fetcher, type PpConfig } from '@pp/core';
import type { EmailBundle, EmailPage } from '../src/emails/extract';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, 'fixtures');

export const SITE_URLS: Record<string, string> = {
  johnspaint: 'https://www.johnspaint.com',
  njpaintingco: 'https://njpaintingco.com',
  bartonspringspainting: 'https://bartonspringspainting.com',
  rutgerspainting: 'https://rutgerspainting.com',
  wepainttexas: 'https://www.wepainttexas.com',
};

interface FixtureEntry {
  url: string;
  sha256: string;
  rendered: boolean;
  kind?: 'bundle';
}

export interface SiteFixture {
  websiteUrl: string;
  pages: (EmailPage & { sha256: string })[];
  bundles: (EmailBundle & { sha256: string })[];
}

/** A probe site captured through the real fetcher (see test/fixtures/README.md). */
export function loadSite(name: keyof typeof SITE_URLS): SiteFixture {
  const dir = path.join(FIXTURES, 'sites', name);
  const entries = JSON.parse(readFileSync(path.join(dir, 'pages.json'), 'utf8')) as FixtureEntry[];
  const body = (e: FixtureEntry): string => gunzipSync(readFileSync(path.join(dir, `${e.sha256}.html.gz`))).toString('utf8');
  return {
    websiteUrl: SITE_URLS[name] as string,
    pages: entries
      .filter((e) => e.kind !== 'bundle')
      .map((e) => ({ url: e.url, sha256: e.sha256, rendered: e.rendered, html: body(e) })),
    bundles: entries.filter((e) => e.kind === 'bundle').map((e) => ({ url: e.url, sha256: e.sha256, text: body(e) })),
  };
}

export function page(url: string, html: string, rendered = false): EmailPage {
  return { url, html, rendered };
}

export function html(body: string, head = ''): string {
  return `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
}

/** A DNS resolver that never leaves the machine: every domain in `mx` has MX, `a` only A records, `nullMx` a null MX. */
export function fakeResolver(o: { mx?: string[]; a?: string[]; nullMx?: string[]; broken?: string[] } = {}): DnsResolver & { calls: string[] } {
  const calls: string[] = [];
  const err = (code: string): Error => Object.assign(new Error(code), { code });
  return {
    calls,
    async resolveMx(d) {
      calls.push(`mx:${d}`);
      if (o.broken?.includes(d)) throw err('ETIMEOUT');
      if (o.mx?.includes(d)) return [{ exchange: `mail.${d}`, priority: 10 }];
      if (o.nullMx?.includes(d)) return [{ exchange: '', priority: 0 }];
      if (o.a?.includes(d)) throw err('ENODATA');
      throw err('ENOTFOUND');
    },
    async resolve4(d) {
      calls.push(`a:${d}`);
      if (o.a?.includes(d)) return ['93.184.216.34'];
      throw err('ENODATA');
    },
    async resolve6(d) {
      calls.push(`aaaa:${d}`);
      throw err('ENODATA');
    },
  };
}

export const ALL_PROBE_DOMAINS = ['johnspaint.com', 'njpaintingco.com', 'bartonspringspainting.com', 'rutgerspainting.com', 'wepainttexas.com'];

export function testConfig(over: Partial<PpConfig['crawl']> = {}, intervalMs = 0): PpConfig {
  const base = loadConfig();
  return {
    ...base,
    sources: { ...base.sources, websites: { enabled: true, minIntervalMs: intervalMs, robots: 'respect' } },
    crawl: { ...base.crawl, ...over },
  };
}

/** A real fetcher (robots, rate limit, SSRF guard, cache) wired to a MockAgent and a fake clock. */
export function makeFetcher(config: PpConfig = testConfig()): {
  fetcher: Fetcher;
  agent: MockAgent;
  dataDir: string;
  waits: number[];
} {
  const agent = new MockAgent();
  agent.disableNetConnect();
  let t = Date.parse('2026-10-25T12:00:00Z');
  const waits: number[] = [];
  const dataDir = mkdtempSync(path.join(tmpdir(), 'pp-sites-'));
  const fetcher = createFetcher({
    config,
    db: null,
    dispatcher: agent,
    dataDir,
    now: () => new Date(t),
    sleep: async (ms) => {
      waits.push(ms);
      t += ms;
    },
    resolveHost: async () => ['93.184.216.34'],
  });
  return { fetcher, agent, dataDir, waits };
}

export interface MockPage {
  status?: number;
  body: string;
  type?: string;
}

/** Serves `pages` (path -> page) for one origin; robots.txt is `robots` (default: allow all). */
export function serve(agent: MockAgent, origin: string, pages: Record<string, MockPage | string>, robots = 'User-agent: *\nAllow: /\n'): void {
  const pool = agent.get(origin);
  pool.intercept({ path: '/robots.txt', method: 'GET' }).reply(200, robots, { headers: { 'content-type': 'text/plain' } }).persist();
  for (const [p, v] of Object.entries(pages)) {
    const spec: MockPage = typeof v === 'string' ? { body: v } : v;
    pool
      .intercept({ path: p, method: 'GET' })
      .reply(spec.status ?? 200, spec.body, { headers: { 'content-type': spec.type ?? 'text/html; charset=utf-8' } })
      .persist();
  }
}
