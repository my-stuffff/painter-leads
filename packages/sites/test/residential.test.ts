import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SiteStatus } from '@pp/core';
import { classifyResidential } from '../src/residential/classify';
import { crawlStats, extractSignals, normaliseText, type SignalPage } from '../src/residential/signals';
import { FIXTURES, html, loadSite } from './helpers';

function folder(name: string): SignalPage[] {
  const dir = path.join(FIXTURES, 'residential', name);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)))
    .map((f) => ({ url: `https://acme-painter.test/${f === 'index.html' ? '' : f.replace('.html', '')}`, html: readFileSync(path.join(dir, f), 'utf8') }));
}

function decide(
  pages: SignalPage[],
  o: { categories?: string[]; name?: string; njHicActive?: boolean | null; siteStatus?: SiteStatus | null } = {},
) {
  const stats = crawlStats(pages);
  return classifyResidential({
    signals: extractSignals(pages, { categories: o.categories, name: o.name }),
    siteStatus: o.siteStatus === undefined ? (pages.length > 0 ? 'ok' : 'no_website') : o.siteStatus,
    pagesCrawled: stats.pages,
    visibleChars: stats.chars,
    hasServiceContent: stats.serviceContent,
    njHicActive: o.njHicActive ?? null,
  });
}

const one = (body: string) => [{ url: 'https://acme-painter.test/', html: html(body) }];
const text = (s: string) => `<p>${s}</p>`;
const FILL = text('Our crews arrive on time, protect floors and furniture and leave every job clean. '.repeat(6));

describe('synthetic fixtures', () => {
  for (const name of ['residential-only', 'nav-commercial', 'both-phrase', 'negated', 'commercial-only', 'footer-seo', 'thin-site']) {
    it(`${name} gets its labelled result`, () => {
      const expected = JSON.parse(readFileSync(path.join(FIXTURES, 'residential', name, 'label.json'), 'utf8')) as { expect: string };
      expect(decide(folder(name)).label).toBe(expected.expect);
    });
  }

  it('residential only: lists the deciding signals with page URL and snippet, no commercial signal', () => {
    const d = decide(folder('residential-only'));
    expect(d.label).toBe('residential_only');
    const ids = new Set(d.signals.map((s) => s.id));
    for (const id of ['res:interior-painting', 'res:exterior-painting', 'res:cabinet-painting', 'res:homeowners']) expect(ids.has(id), id).toBe(true);
    expect(d.signals.every((s) => s.polarity === 'residential' && s.sourceUrl.startsWith('https://acme-painter.test') && s.snippet.length > 0)).toBe(true);
    expect(d.signals.some((s) => s.sourceUrl.endsWith('/services'))).toBe(true);
  });

  it('a Commercial menu item or service page means also commercial', () => {
    const d = decide(folder('nav-commercial'));
    expect(d.label).toBe('residential_and_commercial');
    expect(d.signals.some((s) => s.id === 'com:title-commercial' && s.strength === 'strong')).toBe(true);
  });

  it('commercial only', () => {
    const d = decide(folder('commercial-only'));
    expect(d.label).toBe('commercial_only');
    const ids = new Set(d.signals.map((s) => s.id));
    for (const id of ['com:office-buildings', 'com:warehouse', 'com:property-management', 'com:tenant-improvement', 'com:hoa']) expect(ids.has(id), id).toBe(true);
  });

  it('"commercial" in a footer SEO list only: unclear, with that reason', () => {
    const d = decide(folder('footer-seo'));
    expect(d.label).toBe('unclear');
    expect(d.reason).toBe('commercial mentioned only in footer');
    expect(extractSignals(folder('footer-seo')).filter((h) => h.id === 'com:commercial-painting').map((h) => h.strength)).toEqual(['weak']);
  });
});

describe('residential and commercial wording (QUAL-02 adjacency)', () => {
  it.each([
    'residential and commercial painting',
    'residential &amp; commercial painting',
    'residential & commercial painting',
    'commercial and residential painting',
    'Residential, and Commercial painting',
    'RESIDENTIAL   AND\n COMMERCIAL painting',
  ])('%s -> residential_and_commercial', (phrase) => {
    const d = decide(one(`${text(`We do ${phrase} across the county.`)}${text('Interior painting and exterior painting for homeowners.')}${FILL}<a href="/services">Services</a>`).concat([{ url: 'https://acme-painter.test/services', html: html(`<h1>Services</h1>${FILL}`) }]));
    expect(d.label).toBe('residential_and_commercial');
  });

  it('"we do not do commercial work" with residential phrases is residential_only; the commercial hit is kept as negated', () => {
    const pages = folder('negated');
    const hits = extractSignals(pages);
    const commercial = hits.filter((h) => h.polarity === 'commercial');
    expect(commercial.length).toBeGreaterThan(0);
    expect(commercial.every((h) => h.negated)).toBe(true);
    expect(hits.some((h) => h.id === 'neg:no-commercial-work' && !h.negated)).toBe(true);
    const d = decide(pages);
    expect(d.label).toBe('residential_only');
    expect(d.signals.some((s) => s.polarity === 'commercial')).toBe(false);
    expect(d.reason).toContain('negated');
  });

  it('each negation form cancels commercial in its own sentence only', () => {
    for (const neg of ['We do not do commercial work.', "We don't offer commercial painting.", 'Residential only, no commercial.', 'We are exclusively residential, never commercial painting.', 'We only do residential. Commercial painting is not for us.']) {
      const hits = extractSignals(one(text(neg)));
      expect(hits.some((h) => h.polarity === 'negation'), neg).toBe(true);
    }
    const mixed = extractSignals(one(text('We do not do commercial work. We also paint office buildings.')));
    expect(mixed.find((h) => h.id === 'com:office-buildings')?.negated).toBe(false);
    expect(mixed.find((h) => h.id === 'neg:no-commercial-work')).toBeDefined();
  });

  it('service targets count only when two appear together', () => {
    expect(extractSignals(one(text('Great schools nearby.'))).some((h) => h.id === 'com:schools')).toBe(false);
    const ids = extractSignals(one(text('We paint restaurants, schools and churches.'))).map((h) => h.id);
    expect(ids).toEqual(expect.arrayContaining(['com:restaurants', 'com:schools', 'com:churches']));
  });
});

describe('Google category, company name and NJ registration', () => {
  const resPages = folder('residential-only');

  it('company name words and the Commercial painter category are commercial signals; House painter is residential', () => {
    for (const name of ['Acme Commercial Painting', 'Acme Industrial Coatings', 'Acme Epoxy Floors', 'Acme Contracting Group']) {
      expect(decide(resPages, { name }).label, name).toBe('residential_and_commercial');
      expect(decide([], { name, siteStatus: 'no_website' }).label, name).toBe('commercial_only');
    }
    expect(decide(resPages, { categories: ['Commercial painter'] }).label).toBe('residential_and_commercial');
    const house = extractSignals([], { categories: ['House painter', 'Painter'] });
    expect(house.map((h) => [h.polarity, h.id, h.sourceType])).toEqual([['residential', 'res:category-house-painter', 'google_maps']]);
    expect(decide([], { categories: ['House painter'], siteStatus: 'no_website' })).toMatchObject({ label: 'unclear', reason: 'insufficient evidence' });
  });

  it('an active NJ HIC registration is a weak residential signal and never makes residential_only by itself', () => {
    const thin = one(text('Acme Painting. Interior painting for our neighbors.')).concat([{ url: 'https://acme-painter.test/services', html: html(`<h1>Services</h1>${text('Free estimates.')}${FILL}`) }]);
    const d = decide(thin, { njHicActive: true });
    expect(d.label).toBe('unclear');
    expect(d.reason).toBe('fewer than two residential signals');
    const weak = decide(resPages, { njHicActive: true }).signals.find((s) => s.id === 'res:nj-hic-active');
    expect(weak).toMatchObject({ strength: 'weak', sourceType: 'nj_hic_roster' });
    expect(decide([], { njHicActive: true, siteStatus: 'no_website' }).label).toBe('unclear');
    // supporting evidence next to a commercial signal turns commercial-only into both
    expect(decide(folder('commercial-only'), { njHicActive: true }).label).toBe('residential_and_commercial');
  });
});

describe('insufficient evidence (never residential_only)', () => {
  const statuses: (SiteStatus | null)[] = ['no_website', 'render_failed', 'fetch_failed', 'robots_disallowed', 'shared_host', null];
  it.each(statuses)('site status %s -> unclear, insufficient evidence', (siteStatus) => {
    const d = decide(folder('residential-only'), { siteStatus });
    expect(d).toMatchObject({ label: 'unclear', reason: 'insufficient evidence' });
  });

  it('too little visible text, or no page at all', () => {
    expect(decide(folder('thin-site'))).toMatchObject({ label: 'unclear', reason: 'insufficient evidence' });
    expect(decide([])).toMatchObject({ label: 'unclear', reason: 'insufficient evidence' });
  });

  it('a single page, or no services page, is not enough for residential_only', () => {
    const home = folder('residential-only').slice(0, 1);
    expect(decide(home)).toMatchObject({ label: 'unclear', reason: 'fewer than two pages crawled' });
  });
});

describe('text normalisation (QUAL-02 encoding)', () => {
  it('matches case-insensitively on NFKC, whitespace-normalised text', () => {
    expect(normaliseText('  ＣＯＭＭＥＲＣＩＡＬ   PAINTING &amp; more\n')).toBe('COMMERCIAL PAINTING & more');
    const ids = (s: string) => extractSignals(one(text(s))).map((h) => h.id);
    expect(ids('ＣＯＭＭＥＲＣＩＡＬ ＰＡＩＮＴＩＮＧ')).toContain('com:commercial-painting');
    expect(ids('Commercial  Painting')).toContain('com:commercial-painting');
    expect(ids('INTERIOR & EXTERIOR PAINTING')).toEqual(expect.arrayContaining(['res:interior-painting', 'res:exterior-painting']));
    expect(ids('interior and exterior painting')).toEqual(expect.arrayContaining(['res:interior-painting', 'res:exterior-painting']));
    expect(ids('homeowners association')).toEqual(['com:hoa']);
  });
});

describe('ordering (QUAL-02 stability)', () => {
  it('signals are ordered by page URL, then position, and re-classifying gives an identical result', () => {
    const pages = folder('nav-commercial');
    const a = decide(pages);
    const b = decide([...pages].reverse());
    expect(b).toEqual(a);
    expect(decide(pages)).toEqual(a);
    const hits = extractSignals(pages).filter((h) => h.sourceType === 'website');
    const urls = hits.map((h) => h.sourceUrl);
    expect(urls).toEqual([...urls].sort());
    for (const url of new Set(urls)) {
      const pos = hits.filter((h) => h.sourceUrl === url).map((h) => h.position);
      expect(pos).toEqual([...pos].sort((x, y) => x - y));
    }
  });

  it('a menu repeated on every page counts once', () => {
    const hits = extractSignals(folder('nav-commercial')).filter((h) => h.id === 'com:title-commercial');
    expect(hits.length).toBe(1);
  });
});

describe('probe sites through the classifier', () => {
  it('wepainttexas says "residential, and commercial": also commercial', () => {
    const s = loadSite('wepainttexas');
    expect(decide(s.pages, { name: 'We Paint Texas' }).label).toBe('residential_and_commercial');
  });
});
