import { load } from 'cheerio';
import {
  RobotsDisallowedError,
  registrableDomain,
  type Db,
  type Fetcher,
  type Logger,
  type PpConfig,
  type SiteStatus,
} from '@pp/core';
import { inScope, resolveLink, selectInternalLinks, type LinkScope } from './links';
import { createRenderer, type Renderer } from './render';
import { visibleText, type VisibleText } from './visible-text';

/** Social and listing sites: never crawled (a company page there is not the company's own site). */
export const LISTING_HOSTS: readonly string[] = [
  'facebook.com',
  'instagram.com',
  'yelp.com',
  'nextdoor.com',
  'homeadvisor.com',
  'angi.com',
  'thumbtack.com',
  'houzz.com',
  'bbb.org',
  'linktr.ee',
  'x.com',
  'twitter.com',
  'linkedin.com',
  'youtube.com',
  'tiktok.com',
  'pinterest.com',
];

export interface CrawledPage {
  /** URL we asked for. */
  url: string;
  finalUrl: string;
  /** Fetcher cache key (request hash, or the render key for a rendered page). */
  sha256: string;
  cachePath: string | null;
  html: string;
  visible: VisibleText;
  rendered: boolean;
  /** The page needed Chromium and the render did not work. */
  renderFailed: boolean;
  fromCache: boolean;
  fetchedAt: Date;
}

export interface BundleFile {
  url: string;
  sha256: string;
  text: string;
}

export interface CrawlResult {
  status: SiteStatus;
  /** Home page first, then internal pages in the order they were fetched. */
  pages: CrawledPage[];
  bundles: BundleFile[];
  /** Registrable domains that count as the company's own (empty on a shared host). */
  ownDomains: string[];
  errors: { url: string; error: string }[];
}

export interface CrawlCtx {
  fetcher: Fetcher;
  config: PpConfig;
  log?: Logger;
  runId?: number | null;
  /** Fetcher cache only; never launches Chromium. */
  offline?: boolean;
  /** Lets a page that was rendered once be found again without a second render. */
  db?: Db | null;
  /** Injected renderer (tests); otherwise one is created on the first page that needs it. */
  renderer?: Renderer;
  /** Defaults to config.crawl.maxInternalPages. */
  maxInternalPages?: number;
  /** Default true. */
  fetchBundles?: boolean;
}

const SKIP_BUNDLE = /(?:jquery|wp-includes|polyfill|gtag|analytics|google-analytics|recaptcha|bootstrap|swiper|slick)/i;

export function normaliseWebsiteUrl(raw: string): URL | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

function isListingHost(host: string): boolean {
  const reg = registrableDomain(host).domain ?? host;
  if (host === 'sites.google.com') return false;
  if (reg === 'google.com') return true;
  return LISTING_HOSTS.some((s) => reg === s || reg.endsWith(`.${s}`));
}

function scopeFor(u: URL): LinkScope {
  const reg = registrableDomain(u.hostname);
  if (reg.sharedHost) {
    const seg = u.pathname.split('/').filter((s) => s.length > 0);
    const prefix = u.hostname === 'sites.google.com' && seg.length >= 2 ? `/${seg[0]}/${seg[1]}` : '/';
    return { domain: null, host: u.hostname.toLowerCase(), pathPrefix: prefix };
  }
  return { domain: reg.domain, host: u.hostname.toLowerCase(), pathPrefix: '/' };
}

async function findRendered(ctx: CrawlCtx, url: string): Promise<{ html: string; sha256: string; cachePath: string | null } | null> {
  if (!ctx.db) return null;
  try {
    const r = await ctx.db.$client.query<{ sha256: string; cache_path: string | null }>(
      'SELECT sha256, cache_path FROM pages WHERE url = $1 AND rendered = true ORDER BY fetched_at DESC LIMIT 1',
      [url],
    );
    const row = r.rows[0];
    if (!row) return null;
    const body = await ctx.fetcher.readCached(row.sha256);
    return body ? { html: body.toString('utf8'), sha256: row.sha256, cachePath: row.cache_path } : null;
  } catch {
    return null;
  }
}

function scriptSources(html: string, base: string): URL[] {
  const $ = load(html);
  const out: URL[] = [];
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    const u = src ? resolveLink(src, base) : null;
    if (u) out.push(u);
  });
  return out;
}

/**
 * D-16: crawls one company website through the core fetcher (robots, 1 request/second per host,
 * SSRF guard and disk cache are the fetcher's job; this never touches the network itself).
 */
export async function crawlSite(
  ctx: CrawlCtx,
  site: { companyId?: number; websiteUrl: string | null },
): Promise<CrawlResult> {
  const result: CrawlResult = { status: 'ok', pages: [], bundles: [], ownDomains: [], errors: [] };
  const start = site.websiteUrl ? normaliseWebsiteUrl(site.websiteUrl) : null;
  if (!start) {
    result.status = 'no_website';
    return result;
  }
  if (isListingHost(start.hostname)) {
    result.status = 'shared_host';
    return result;
  }

  const cfg = ctx.config.crawl;
  const opts = { source: 'websites' as const, cache: 'use' as const, runId: ctx.runId ?? null };
  let ownRenderer: Renderer | null = null;
  const renderer = (): Renderer => {
    if (ctx.renderer) return ctx.renderer;
    ownRenderer ??= createRenderer({ fetcher: ctx.fetcher, config: ctx.config });
    return ownRenderer;
  };

  async function loadPage(url: string): Promise<CrawledPage> {
    const res = await ctx.fetcher.get(url, { ...opts, offline: ctx.offline });
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers['content-type'];
    if (ct && !/html|xml|text\/plain/i.test(ct)) throw new Error(`not a web page (${ct})`);
    let html = res.text();
    let visible = visibleText(html);
    const page: CrawledPage = {
      url,
      finalUrl: res.finalUrl,
      sha256: res.sha256,
      cachePath: res.cachePath,
      html,
      visible,
      rendered: false,
      renderFailed: false,
      fromCache: res.fromCache,
      fetchedAt: res.fetchedAt,
    };
    if (visible.text.length < cfg.renderIfVisibleCharsBelow) {
      const again = await findRendered(ctx, url);
      if (again) {
        html = again.html;
        visible = visibleText(html);
        Object.assign(page, { html, visible, sha256: again.sha256, cachePath: again.cachePath, rendered: true });
      } else if (ctx.offline) {
        page.renderFailed = true;
      } else {
        try {
          html = await renderer().render(res.finalUrl);
          const stored = await ctx.fetcher.storeRendered(url, html, { source: 'websites', runId: ctx.runId ?? null });
          visible = visibleText(html);
          Object.assign(page, { html, visible, sha256: stored.sha256, cachePath: stored.cachePath, rendered: true });
        } catch (e) {
          page.renderFailed = true;
          result.errors.push({ url, error: `render failed: ${(e as Error).message}` });
        }
      }
    }
    return page;
  }

  try {
    let home: CrawledPage;
    try {
      home = await loadPage(start.toString());
    } catch (e) {
      result.status = e instanceof RobotsDisallowedError ? 'robots_disallowed' : 'fetch_failed';
      result.errors.push({ url: start.toString(), error: (e as Error).message });
      return result;
    }

    const finalUrl = new URL(home.finalUrl);
    if (isListingHost(finalUrl.hostname)) {
      result.status = 'shared_host';
      return result;
    }
    const scope = scopeFor(finalUrl);
    const startReg = registrableDomain(start.hostname);
    result.ownDomains = [
      ...new Set([scope.domain, startReg.sharedHost ? null : startReg.domain].filter((d): d is string => d !== null)),
    ];
    result.pages.push(home);
    if (home.renderFailed) result.status = 'render_failed';

    const max = ctx.maxInternalPages ?? cfg.maxInternalPages;
    const targets = selectInternalLinks(home.visible.links, home.finalUrl, scope, cfg.linkPattern, max);
    for (const url of targets) {
      try {
        result.pages.push(await loadPage(url));
      } catch (e) {
        result.errors.push({ url, error: (e as Error).message });
      }
    }

    if ((ctx.fetchBundles ?? true) && cfg.maxBundles > 0) {
      const wanted = scriptSources(home.html, home.finalUrl)
        .filter((u) => inScope(u, scope) && /\.m?js$/i.test(u.pathname) && !SKIP_BUNDLE.test(u.pathname))
        .slice(0, cfg.maxBundles);
      for (const u of wanted) {
        try {
          const res = await ctx.fetcher.get(u.toString(), {
            ...opts,
            offline: ctx.offline,
            maxBytes: cfg.maxBundleBytes,
          });
          if (res.status < 400) result.bundles.push({ url: u.toString(), sha256: res.sha256, text: res.text() });
        } catch (e) {
          result.errors.push({ url: u.toString(), error: (e as Error).message });
        }
      }
    }
    return result;
  } finally {
    if (ownRenderer) await (ownRenderer as Renderer).close();
  }
}
