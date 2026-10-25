import { normaliseUrlForCompare, registrableDomain } from '@pp/core';
import type { PageLink } from './visible-text';

export interface LinkScope {
  /** Registrable domain of the company site; null on a shared host (then host + pathPrefix decide). */
  domain: string | null;
  host: string;
  /** Only used on a shared host: links must stay under this path. */
  pathPrefix: string;
}

const SKIP_EXT = /\.(?:jpe?g|png|gif|webp|svg|ico|pdf|docx?|xlsx?|pptx?|zip|rar|mp3|mp4|mov|avi|css|js|json|xml|woff2?|ttf)$/i;

/** Resolves an href against the page URL; null for anything that is not an http(s) page link. */
export function resolveLink(href: string, base: string): URL | null {
  const h = href.trim();
  if (h.length === 0 || h.startsWith('#') || /^(?:mailto|tel|sms|javascript|data|whatsapp):/i.test(h)) return null;
  let u: URL;
  try {
    u = new URL(h, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  return u;
}

export function inScope(u: URL, scope: LinkScope): boolean {
  if (scope.domain !== null) return registrableDomain(u.hostname).domain === scope.domain;
  return u.hostname.toLowerCase() === scope.host && u.pathname.startsWith(scope.pathPrefix);
}

/**
 * D-16: up to `max` internal pages whose link text or URL matches the pattern, ordered by the
 * position of the matching word in the pattern (contact before about before team ...), then by
 * document order. Same registrable domain (or host + path prefix on a shared host), deduped by
 * normaliseUrlForCompare, never the page itself.
 */
export function selectInternalLinks(
  links: PageLink[],
  baseUrl: string,
  scope: LinkScope,
  pattern: string,
  max: number,
): string[] {
  if (max <= 0) return [];
  const words = pattern.split('|').map((w) => w.trim()).filter((w) => w.length > 0);
  const res = words.map((w) => new RegExp(w.replace(/[-_]/g, '[-_ ]?'), 'i'));
  const self = normaliseUrlForCompare(baseUrl);

  const seen = new Set<string>([self]);
  const hits: { url: string; rank: number; order: number }[] = [];
  links.forEach((l, order) => {
    const u = resolveLink(l.href, baseUrl);
    if (!u || !inScope(u, scope) || SKIP_EXT.test(u.pathname)) return;
    let path = u.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep the encoded path
    }
    const haystack = `${l.text} ${path}`;
    const rank = res.findIndex((re) => re.test(haystack));
    if (rank === -1) return;
    const key = normaliseUrlForCompare(u.toString());
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ url: u.toString(), rank, order });
  });
  hits.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return hits.slice(0, max).map((h) => h.url);
}
