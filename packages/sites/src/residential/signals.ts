import { makeSnippet, type ResidentialSignal } from '@pp/core';
import { visibleText, type VisibleText } from '../crawl/visible-text';
import {
  CATEGORY_COMMERCIAL,
  CATEGORY_RESIDENTIAL,
  COMBINED_PHRASE,
  COMMERCIAL_PHRASES,
  NAME_WORDS,
  NEGATION_PHRASES,
  RESIDENTIAL_PHRASES,
  SERVICE_PAGE,
  TARGET_PHRASES,
  TITLE_COMMERCIAL,
  TITLE_RESIDENTIAL,
  type PhraseDef,
} from './tables';

/** A matched phrase. `negated` commercial hits sit in the same sentence as a negation ("we do not do commercial work"). */
export interface SignalHit extends ResidentialSignal {
  negated: boolean;
  /** Order key inside the page (line offset + position in the line). */
  position: number;
}

export interface SignalPage {
  url: string;
  html: string;
  rendered?: boolean;
  sha256?: string | null;
  visible?: VisibleText;
}

/** NFKC, whitespace collapsed, "&amp;" read as "&". Case is kept (the patterns are case-insensitive). */
export function normaliseText(s: string): string {
  return s.normalize('NFKC').replace(/&amp;/gi, '&').replace(/[\s ]+/g, ' ').trim();
}

interface Raw {
  id: string;
  polarity: ResidentialSignal['polarity'];
  index: number;
  length: number;
  negated: boolean;
}

function sentenceBounds(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?;]+\s+/g)) {
    const end = m.index + m[0].length;
    out.push({ start, end });
    start = end;
  }
  out.push({ start, end: text.length });
  return out;
}

function matches(text: string, defs: readonly PhraseDef[], polarity: Raw['polarity']): Raw[] {
  const out: Raw[] = [];
  for (const d of defs) {
    for (const m of text.matchAll(d.re)) out.push({ id: d.id, polarity, index: m.index, length: m[0].length, negated: false });
  }
  return out;
}

function scanText(text: string, heading: boolean): Raw[] {
  const raw: Raw[] = [
    ...matches(text, RESIDENTIAL_PHRASES, 'residential'),
    ...matches(text, COMMERCIAL_PHRASES, 'commercial'),
    ...matches(text, NEGATION_PHRASES, 'negation'),
  ];
  for (const m of text.matchAll(COMBINED_PHRASE.re)) {
    raw.push({ id: `com:${COMBINED_PHRASE.id}`, polarity: 'commercial', index: m.index, length: m[0].length, negated: false });
    raw.push({ id: `res:${COMBINED_PHRASE.id}`, polarity: 'residential', index: m.index, length: m[0].length, negated: false });
  }
  const targets = matches(text, TARGET_PHRASES, 'commercial');
  if (new Set(targets.map((t) => t.id)).size >= 2) raw.push(...targets);
  if (heading) {
    if (TITLE_COMMERCIAL.test(text)) raw.push({ id: 'com:title-commercial', polarity: 'commercial', index: 0, length: text.length, negated: false });
    if (TITLE_RESIDENTIAL.test(text)) raw.push({ id: 'res:title-residential', polarity: 'residential', index: 0, length: text.length, negated: false });
  }

  // A negation cancels the commercial hits in its own sentence.
  const negations = raw.filter((r) => r.polarity === 'negation');
  if (negations.length > 0) {
    const bounds = sentenceBounds(text);
    const sentenceOf = (i: number): number => bounds.findIndex((b) => i >= b.start && i < b.end);
    const negated = new Set(negations.map((n) => sentenceOf(n.index)));
    for (const r of raw) if (r.polarity === 'commercial' && negated.has(sentenceOf(r.index))) r.negated = true;
  }
  return raw;
}

/**
 * Residential and commercial signals (D-25) from crawled pages and, optionally, the Google
 * categories and the company name. Hits in a footer are weak, everything else strong. Repeated
 * menus count once. Output order is stable: source (Google, then website), page URL, position, id.
 */
export function extractSignals(
  pages: SignalPage[],
  opts: { categories?: string[]; name?: string; googleUrl?: string } = {},
): SignalHit[] {
  const hits: SignalHit[] = [];
  const seen = new Set<string>();

  const sorted = [...pages].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  for (const page of sorted) {
    const visible = page.visible ?? visibleText(page.html);
    const units: { text: string; position: number; footer: boolean; heading: boolean }[] = [];
    if (visible.title) units.push({ text: visible.title, position: -2, footer: false, heading: true });
    for (const h of visible.h1) units.push({ text: h, position: -1, footer: false, heading: true });
    for (const l of visible.lines) units.push({ text: l.text, position: l.offset, footer: l.inFooter, heading: l.heading || l.inNav });

    for (const u of units) {
      const text = normaliseText(u.text);
      if (text.length === 0) continue;
      for (const r of scanText(text, u.heading)) {
        const key = `${r.id}|${text.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          polarity: r.polarity,
          id: r.id,
          text: text.slice(r.index, r.index + r.length),
          sourceType: 'website',
          sourceUrl: page.url,
          snippet: makeSnippet(text, r.index, r.length),
          strength: u.footer ? 'weak' : 'strong',
          negated: r.negated,
          position: u.position + r.index,
        });
      }
    }
  }

  const google: SignalHit[] = [];
  const url = opts.googleUrl ?? 'https://www.google.com/maps';
  for (const c of opts.categories ?? []) {
    const cat = normaliseText(c);
    if (CATEGORY_COMMERCIAL.test(cat)) {
      google.push(googleHit('commercial', 'com:category-commercial', cat, url, `Google category: ${cat}`, google.length));
    } else if (CATEGORY_RESIDENTIAL.test(cat)) {
      google.push(googleHit('residential', 'res:category-house-painter', cat, url, `Google category: ${cat}`, google.length));
    }
  }
  const name = normaliseText(opts.name ?? '');
  for (const w of NAME_WORDS) {
    const m = w.re.exec(name);
    if (m) google.push(googleHit('commercial', w.id, m[0], url, `Company name: ${name}`, google.length));
  }
  return [...google, ...hits];
}

function googleHit(polarity: 'residential' | 'commercial', id: string, text: string, url: string, snippet: string, position: number): SignalHit {
  return { polarity, id, text, sourceType: 'google_maps', sourceUrl: url, snippet, strength: 'strong', negated: false, position };
}

export interface CrawlStats {
  /** Pages with readable text. */
  pages: number;
  /** Visible characters over all pages. */
  chars: number;
  /** A services page was crawled, or the home page lists at least two residential services. */
  serviceContent: boolean;
}

/** What the classifier needs to know about how much of the site was read. */
export function crawlStats(pages: SignalPage[]): CrawlStats {
  const parsed = pages.map((p) => ({ url: p.url, visible: p.visible ?? visibleText(p.html) }));
  const readable = parsed.filter((p) => p.visible.text.length > 0);
  const chars = readable.reduce((n, p) => n + p.visible.text.length, 0);
  const home = parsed[0];
  const others = parsed.slice(1);
  const servicesPage = others.some((p) => {
    let path = '';
    try {
      path = decodeURIComponent(new URL(p.url).pathname);
    } catch {
      path = p.url;
    }
    return SERVICE_PAGE.test(path) || p.visible.h1.some((h) => SERVICE_PAGE.test(h)) || SERVICE_PAGE.test(p.visible.title);
  });
  let homeList = false;
  if (home) {
    const ids = new Set<string>();
    for (const l of home.visible.lines) {
      if (l.inFooter) continue;
      for (const d of RESIDENTIAL_PHRASES) if (new RegExp(d.re.source, d.re.flags).test(normaliseText(l.text))) ids.add(d.id);
    }
    homeList = ids.size >= 2;
  }
  return { pages: readable.length, chars, serviceContent: servicesPage || homeList };
}
