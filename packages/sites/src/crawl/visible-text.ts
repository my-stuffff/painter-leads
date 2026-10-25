import { load } from 'cheerio';

/** Minimal view of a parsed DOM node (domhandler's types are not a direct dependency). */
export interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

export interface TextLine {
  text: string;
  /** Offset of the line inside VisibleText.text. */
  offset: number;
  heading: boolean;
  inFooter: boolean;
  inNav: boolean;
  /** Inside a review / testimonial / blockquote element. */
  inReview: boolean;
}

/** One block of text. A heading and the line after it count as one block (team cards). */
export interface TextBlock {
  text: string;
  offset: number;
  inFooter: boolean;
  inNav: boolean;
  inReview: boolean;
}

export interface PageLink {
  href: string;
  text: string;
  inNav: boolean;
  inFooter: boolean;
}

export interface VisibleText {
  /** Visible text, one line per block-level element, lines joined with '\n'. */
  text: string;
  lines: TextLine[];
  blocks: TextBlock[];
  footerText: string;
  title: string;
  /** Text of every <h1>. */
  h1: string[];
  links: PageLink[];
  /** Every text node on its own (collapsed): scans that must not glue neighbouring elements together. */
  textNodes: string[];
}

const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head', 'iframe', 'canvas', 'object', 'embed']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'html', 'li', 'main', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul', 'button',
]);
const HEADING = /^h[1-6]$/;
const NAV_WORDS = /(^|[\s_-])(nav|navbar|navigation|menu)([\s_-]|$)/i;
const FOOTER_WORDS = /(^|[\s_-])footer([\s_-]|$)/i;
const REVIEW_WORDS = /review|testimonial/i;

interface Flags {
  inFooter: boolean;
  inNav: boolean;
  inReview: boolean;
}

function classId(n: DomNode): string {
  return `${n.attribs?.class ?? ''} ${n.attribs?.id ?? ''}`;
}

function childFlags(n: DomNode, f: Flags): Flags {
  if (n.type !== 'tag') return f;
  const name = n.name ?? '';
  const ci = classId(n);
  const role = n.attribs?.role ?? '';
  return {
    inFooter: f.inFooter || name === 'footer' || role === 'contentinfo' || FOOTER_WORDS.test(ci),
    inNav: f.inNav || name === 'nav' || role === 'navigation' || NAV_WORDS.test(ci),
    inReview:
      f.inReview ||
      name === 'blockquote' ||
      n.attribs?.itemprop?.toLowerCase() === 'review' ||
      (n.attribs?.itemtype ?? '').toLowerCase().endsWith('/review') ||
      REVIEW_WORDS.test(ci),
  };
}

function collapse(s: string): string {
  return s.replace(/[\s ​]+/g, ' ').trim();
}

function nodeText(n: DomNode): string {
  if (n.type === 'text') return n.data ?? '';
  if (n.type !== 'tag' || DROP.has(n.name ?? '')) return '';
  return (n.children ?? []).map(nodeText).join(n.name && BLOCK.has(n.name) ? ' ' : '');
}

/**
 * Parses a page into its visible text. Scripts, styles, templates and SVG are dropped; block-level
 * elements start a new line; inline elements are joined without adding spaces.
 */
export function visibleText(html: string): VisibleText {
  const $ = load(html);
  const root = $.root().get(0) as unknown as DomNode;

  const lines: Omit<TextLine, 'offset'>[] = [];
  const links: PageLink[] = [];
  const h1: string[] = [];
  const textNodes: string[] = [];
  let title = '';

  let buf = '';
  let bufFlags: Flags = { inFooter: false, inNav: false, inReview: false };
  let bufHeading = false;

  const flush = (): void => {
    const text = collapse(buf);
    if (text.length > 0) lines.push({ text, heading: bufHeading, ...bufFlags });
    buf = '';
    bufHeading = false;
  };

  const walk = (n: DomNode, flags: Flags, inHeading: boolean): void => {
    if (n.type === 'text') {
      const t = n.data ?? '';
      const c = collapse(t);
      if (c.length > 0) textNodes.push(c);
      if (t.trim().length > 0 || buf.length > 0) {
        if (buf.trim().length === 0) bufFlags = flags;
        buf += t;
        if (inHeading) bufHeading = true;
      }
      return;
    }
    if (n.type !== 'tag') return;
    const name = n.name ?? '';
    if (name === 'head') {
      // keep the title text, nothing else
      const t = $(n as never).find('title').first().text();
      if (t) title = collapse(t);
      return;
    }
    if (DROP.has(name)) return;
    const f = childFlags(n, flags);
    const isBlock = BLOCK.has(name);
    if (isBlock) flush();
    if (name === 'a' && n.attribs?.href) {
      links.push({ href: n.attribs.href, text: collapse(nodeText(n)), inNav: f.inNav, inFooter: f.inFooter });
    }
    if (name === 'h1') {
      const t = collapse(nodeText(n));
      if (t) h1.push(t);
    }
    const heading = inHeading || HEADING.test(name);
    for (const c of n.children ?? []) walk(c, f, heading);
    if (isBlock) flush();
  };

  const top: Flags = { inFooter: false, inNav: false, inReview: false };
  for (const c of root.children ?? []) walk(c, top, false);
  flush();
  if (!title) title = collapse($('title').first().text());

  let offset = 0;
  const withOffsets: TextLine[] = lines.map((l) => {
    const line = { ...l, offset };
    offset += l.text.length + 1;
    return line;
  });
  const text = withOffsets.map((l) => l.text).join('\n');

  const blocks: TextBlock[] = [];
  for (let i = 0; i < withOffsets.length; i++) {
    const l = withOffsets[i] as TextLine;
    const next = withOffsets[i + 1];
    if (l.heading && next && !next.heading) {
      blocks.push({
        text: `${l.text}\n${next.text}`,
        offset: l.offset,
        inFooter: l.inFooter && next.inFooter,
        inNav: l.inNav && next.inNav,
        inReview: l.inReview || next.inReview,
      });
      i++;
    } else {
      blocks.push({ text: l.text, offset: l.offset, inFooter: l.inFooter, inNav: l.inNav, inReview: l.inReview });
    }
  }

  const footerText = withOffsets
    .filter((l) => l.inFooter)
    .map((l) => l.text)
    .join('\n');

  return { text, lines: withOffsets, blocks, footerText, title, h1, links, textNodes };
}
