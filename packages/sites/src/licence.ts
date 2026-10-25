import { makeSnippet } from '@pp/core';
import { visibleText, type VisibleText } from './crawl/visible-text';

export interface LicenceFinding {
  /** Upper-case, e.g. 13VH06084400. */
  number: string;
  pageUrl: string;
  pageSha256: string | null;
  rendered: boolean;
  snippet: string;
}

export interface LicencePage {
  url: string;
  html: string;
  rendered: boolean;
  sha256?: string | null;
  visible?: VisibleText;
}

const NJ_HIC = /\b13VH\d{8}\b/gi;

/** D-16: a New Jersey home-improvement registration number shown on the site (the direct join key for 01-03). One per (number, page). */
export function scanNjHicNumbers(pages: LicencePage[]): LicenceFinding[] {
  const out: LicenceFinding[] = [];
  for (const page of pages) {
    const text = (page.visible ?? visibleText(page.html)).text;
    const seen = new Set<string>();
    for (const m of text.matchAll(NJ_HIC)) {
      const number = m[0].toUpperCase();
      if (seen.has(number)) continue;
      seen.add(number);
      out.push({ number, pageUrl: page.url, pageSha256: page.sha256 ?? null, rendered: page.rendered, snippet: makeSnippet(text, m.index, m[0].length) });
    }
  }
  return out;
}
