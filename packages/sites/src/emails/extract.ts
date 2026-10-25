import { load } from 'cheerio';
import { makeSnippet, normaliseEmail, registrableDomain } from '@pp/core';
import { visibleText, type DomNode, type VisibleText } from '../crawl/visible-text';
import { decodeCfEmail } from './cfemail';
import { DESIGNER_CREDIT, filterEmail, type EmailMethod } from './filters';
import { deobfuscate } from './obfuscated';

export type { EmailMethod } from './filters';

/** Strongest first: the method listed in attrs.method is the first one that found the address. */
export const METHOD_ORDER: readonly EmailMethod[] = ['mailto', 'jsonld', 'cfemail', 'text', 'obfuscated', 'bundle'];

export interface EmailPage {
  url: string;
  html: string;
  rendered: boolean;
  sha256?: string | null;
  visible?: VisibleText;
}

export interface EmailBundle {
  url: string;
  text: string;
  sha256?: string | null;
}

export interface EmailSite {
  websiteUrl: string;
  /** Registrable domains of the company's own site; derived from websiteUrl when omitted. */
  ownDomains?: readonly string[];
}

/** One address found on one page (or bundle), with every method that found it there. */
export interface EmailFinding {
  /** Lower-case address. */
  address: string;
  pageUrl: string;
  pageSha256: string | null;
  rendered: boolean;
  methods: EmailMethod[];
  snippet: string;
  accepted: boolean;
  rejectReason: string | null;
  /** Position in the crawl (page order, then position) - used for ranking ties. */
  firstSeen: number;
}

export const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}\b/gi;

interface Candidate {
  address: string;
  method: EmailMethod;
  snippet: string;
  designerCredit: boolean;
}

const FOOTERISH = /(^|[\s_-])footer([\s_-]|$)/i;

export function siteDomains(site: EmailSite): string[] {
  if (site.ownDomains) return [...site.ownDomains];
  const reg = registrableDomain(site.websiteUrl);
  return reg.sharedHost || !reg.domain ? [] : [reg.domain];
}

function splitMailto(href: string): string[] {
  let h = href.trim().replace(/^mailto:/i, '');
  h = h.replace(/\?.*$/, '');
  try {
    h = decodeURIComponent(h);
  } catch {
    // keep the raw form
  }
  return h
    .split(/[,;]/)
    .map((a) => normaliseEmail(a))
    .filter((a) => a.includes('@'));
}

function walkEmails(node: unknown, out: { address: string; name: string | null }[]): void {
  if (Array.isArray(node)) {
    for (const n of node) walkEmails(n, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : typeof obj.legalName === 'string' ? obj.legalName : null;
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === 'email') {
      for (const e of Array.isArray(v) ? v : [v]) {
        if (typeof e === 'string') out.push({ address: normaliseEmail(e), name });
      }
    } else {
      walkEmails(v, out);
    }
  }
}

function snippetFor(visible: VisibleText, address: string, fallback: string): string {
  const idx = visible.text.toLowerCase().indexOf(address);
  return idx >= 0 ? makeSnippet(visible.text, idx, address.length) : fallback;
}

function isFooterElement(el: DomNode | undefined): boolean {
  for (let n = el as (DomNode & { parent?: DomNode }) | undefined; n; n = n.parent) {
    if (n.type === 'tag' && (n.name === 'footer' || n.attribs?.role === 'contentinfo' || FOOTERISH.test(`${n.attribs?.class ?? ''} ${n.attribs?.id ?? ''}`))) {
      return true;
    }
  }
  return false;
}

function pageCandidates(page: EmailPage, visible: VisibleText): Candidate[] {
  const out: Candidate[] = [];
  const $ = load(page.html);
  const lineOf = (address: string): { text: string; inFooter: boolean } | null => {
    const i = visible.lines.findIndex((l) => l.text.toLowerCase().includes(address));
    if (i < 0) return null;
    const line = visible.lines[i] as VisibleText['lines'][number];
    return { text: line.text, inFooter: line.inFooter };
  };

  // mailto links
  $('a[href^="mailto:" i]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const anchor = $(el).text().replace(/\s+/g, ' ').trim();
    const block = $(el).closest('p, li, div, footer, td').text().replace(/\s+/g, ' ').trim().slice(0, 300);
    for (const address of splitMailto(href)) {
      out.push({
        address,
        method: 'mailto',
        snippet: snippetFor(visible, address, `mailto link "${anchor || address}" -> ${address}`),
        designerCredit: isFooterElement(el as unknown as DomNode) && DESIGNER_CREDIT.test(block),
      });
    }
  });

  // JSON-LD
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (raw.length === 0) return;
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const found: { address: string; name: string | null }[] = [];
    walkEmails(data, found);
    for (const f of found) {
      out.push({
        address: f.address,
        method: 'jsonld',
        snippet: snippetFor(visible, f.address, `JSON-LD "email": "${f.address}"${f.name ? ` (${f.name})` : ''}`),
        designerCredit: false,
      });
    }
  });

  // Cloudflare data-cfemail and /cdn-cgi/l/email-protection#HEX links
  const cf = new Set<string>();
  $('[data-cfemail]').each((_, el) => {
    const v = $(el).attr('data-cfemail');
    if (v) cf.add(v);
  });
  $('a[href*="/cdn-cgi/l/email-protection#"]').each((_, el) => {
    const v = ($(el).attr('href') ?? '').split('#')[1];
    if (v) cf.add(v);
  });
  for (const hex of cf) {
    const decoded = decodeCfEmail(hex);
    if (!decoded) continue;
    const address = normaliseEmail(decoded);
    out.push({
      address,
      method: 'cfemail',
      snippet: snippetFor(visible, address, `Cloudflare-protected address decoded to ${address}`),
      designerCredit: false,
    });
  }

  // visible text, one text node at a time (a label in one element must not glue onto an address in the next)
  for (const node of visible.textNodes) {
    for (const m of node.matchAll(EMAIL_RE)) {
      const address = normaliseEmail(m[0]);
      const line = lineOf(address);
      out.push({
        address,
        method: 'text',
        snippet: snippetFor(visible, address, makeSnippet(node, m.index, m[0].length)),
        designerCredit: line !== null && line.inFooter && DESIGNER_CREDIT.test(line.text),
      });
    }
  }

  // bracketed at/dot forms
  for (const m of deobfuscate(visible.text)) {
    const address = normaliseEmail(m.address);
    out.push({
      address,
      method: 'obfuscated',
      snippet: makeSnippet(visible.text, m.index, m.length),
      designerCredit: false,
    });
  }
  return out;
}

/**
 * ENR-01 / D-17: every address on the given pages (and same-site bundles), each with the methods
 * that found it and an accept / reject decision (reject keeps the reason, so the pilot can count it).
 * One finding per (address, page); letter case is ignored. The MX check is applied afterwards.
 */
export function extractEmails(pages: EmailPage[], site: EmailSite, bundles: EmailBundle[] = []): EmailFinding[] {
  const domains = siteDomains(site);
  type Group = { finding: EmailFinding; accepted: Candidate[]; reasons: string[]; all: Candidate[] };
  const groups = new Map<string, Group>();
  let seen = 0;

  const add = (src: { url: string; sha: string | null; rendered: boolean }, c: Candidate): void => {
    const key = `${c.address}\u0000${src.url}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        finding: {
          address: c.address,
          pageUrl: src.url,
          pageSha256: src.sha,
          rendered: src.rendered,
          methods: [],
          snippet: c.snippet,
          accepted: false,
          rejectReason: null,
          firstSeen: seen++,
        },
        accepted: [],
        reasons: [],
        all: [],
      };
      groups.set(key, g);
    }
    g.all.push(c);
    const verdict = filterEmail(c.address, { siteDomains: domains, method: c.method, designerCredit: c.designerCredit });
    if (verdict.accept) g.accepted.push(c);
    else g.reasons.push(verdict.reason);
  };

  for (const page of pages) {
    const visible = page.visible ?? visibleText(page.html);
    for (const c of pageCandidates(page, visible)) {
      add({ url: page.url, sha: page.sha256 ?? null, rendered: page.rendered }, c);
    }
  }
  for (const b of bundles) {
    for (const m of b.text.matchAll(EMAIL_RE)) {
      const address = normaliseEmail(m[0]);
      add(
        { url: b.url, sha: b.sha256 ?? null, rendered: false },
        { address, method: 'bundle', snippet: makeSnippet(b.text, m.index, m[0].length), designerCredit: false },
      );
    }
  }

  const findings: EmailFinding[] = [];
  for (const g of groups.values()) {
    const f = g.finding;
    const winners = g.accepted.length > 0 ? g.accepted : g.all;
    f.methods = METHOD_ORDER.filter((m) => winners.some((c) => c.method === m));
    const best = METHOD_ORDER.map((m) => winners.find((c) => c.method === m)).find((c) => c !== undefined);
    if (best) f.snippet = best.snippet;
    f.accepted = g.accepted.length > 0;
    f.rejectReason = f.accepted ? null : (g.reasons[0] ?? 'rejected');
    findings.push(f);
  }

  // A rejected row for an address that is accepted somewhere else adds nothing (e.g. the same
  // address in a bundle): keep only rows that tell us something.
  const acceptedAddresses = new Set(findings.filter((f) => f.accepted).map((f) => f.address));
  return findings.filter((f) => f.accepted || !acceptedAddresses.has(f.address));
}

/** Accepted addresses only, lower-case, in first-seen order (the golden replayer's view). */
export function acceptedAddresses(findings: EmailFinding[]): string[] {
  const out: string[] = [];
  for (const f of findings) if (f.accepted && !out.includes(f.address)) out.push(f.address);
  return out;
}
