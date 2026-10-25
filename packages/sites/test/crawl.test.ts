import { describe, expect, it } from 'vitest';
import { crawlSite } from '../src/crawl/crawl';
import { selectInternalLinks } from '../src/crawl/links';
import type { Renderer } from '../src/crawl/render';
import { visibleText } from '../src/crawl/visible-text';
import { html, makeFetcher, serve, testConfig } from './helpers';

const PATTERN = 'contact|about|team|our-story|meet|owner|services|residential|commercial';
const scope = { domain: 'acme.com', host: 'acme.com', pathPrefix: '/' };

function lots(text: string): string {
  return `<p>${text} ${'We paint homes and take pride in every job. '.repeat(10)}</p>`;
}

describe('visible text', () => {
  it('drops scripts, styles, templates and svg; block elements start lines; inline elements do not', () => {
    const v = visibleText(
      html(
        `<script>var a="x@y.com"</script><style>p{}</style><svg><text>no</text></svg><template><p>no</p></template>
         <h1>Acme <b>Painting</b></h1><p>Call <a href="/contact">us</a> today</p><div>One</div><div>Two</div>`,
      ),
    );
    expect(v.lines.map((l) => l.text)).toEqual(['Acme Painting', 'Call us today', 'One', 'Two']);
    expect(v.h1).toEqual(['Acme Painting']);
    expect(v.title).toBe('t');
    expect(v.text).not.toContain('x@y.com');
  });

  it('joins a heading and the line after it as one block (team cards) and flags footer, nav and review text', () => {
    const v = visibleText(
      html(
        `<nav><a href="/services">Services</a></nav><h3>Jane Roe</h3><p>Owner</p><p>Plain paragraph</p>
         <div class="testimonial"><p>Great work</p></div><footer><p>Footer words</p></footer>`,
      ),
    );
    expect(v.blocks.map((b) => b.text)).toEqual(['Services', 'Jane Roe\nOwner', 'Plain paragraph', 'Great work', 'Footer words']);
    expect(v.lines.find((l) => l.text === 'Services')?.inNav).toBe(true);
    expect(v.lines.find((l) => l.text === 'Great work')?.inReview).toBe(true);
    expect(v.lines.find((l) => l.text === 'Footer words')?.inFooter).toBe(true);
    expect(v.footerText).toBe('Footer words');
    expect(v.links[0]).toMatchObject({ href: '/services', text: 'Services', inNav: true });
  });

  it('keeps each text node separate for scans that must not glue neighbours', () => {
    const v = visibleText(html('<span>Email us</span><span>info@acme.com</span>'));
    expect(v.text).toBe('Email usinfo@acme.com');
    expect(v.textNodes).toEqual(['Email us', 'info@acme.com']);
  });
});

describe('internal link selection (D-16)', () => {
  const links = [
    { href: '/services/interior', text: 'Interior', inNav: true, inFooter: false },
    { href: '/about-us/', text: 'About', inNav: true, inFooter: false },
    { href: '/contact', text: 'Contact us', inNav: true, inFooter: false },
    { href: 'https://other.com/contact', text: 'Contact', inNav: false, inFooter: false },
    { href: 'mailto:a@acme.com', text: 'Contact', inNav: false, inFooter: false },
    { href: '/contact#form', text: 'Contact again', inNav: false, inFooter: false },
    { href: '/gallery', text: 'Gallery', inNav: false, inFooter: false },
    { href: '/flyer.pdf', text: 'About flyer', inNav: false, inFooter: false },
    { href: 'https://www.acme.com/team', text: 'Our Team', inNav: false, inFooter: false },
    { href: '/', text: 'About home', inNav: false, inFooter: false },
  ];

  it('orders by the pattern word order, dedupes, keeps same-domain pages only', () => {
    expect(selectInternalLinks(links, 'https://acme.com/', scope, PATTERN, 7)).toEqual([
      'https://acme.com/contact',
      'https://acme.com/about-us/',
      'https://www.acme.com/team',
      'https://acme.com/services/interior',
    ]);
  });

  it('caps the number of pages', () => {
    expect(selectInternalLinks(links, 'https://acme.com/', scope, PATTERN, 2)).toHaveLength(2);
    expect(selectInternalLinks(links, 'https://acme.com/', scope, PATTERN, 0)).toEqual([]);
  });

  it('stays under the path prefix on a shared host', () => {
    const shared = { domain: null, host: 'sites.google.com', pathPrefix: '/view/acme' };
    const got = selectInternalLinks(
      [
        { href: '/view/acme/contact', text: 'Contact', inNav: false, inFooter: false },
        { href: '/view/other/contact', text: 'Contact', inNav: false, inFooter: false },
      ],
      'https://sites.google.com/view/acme',
      shared,
      PATTERN,
      7,
    );
    expect(got).toEqual(['https://sites.google.com/view/acme/contact']);
  });
});

describe('crawlSite', () => {
  const home = html(
    `${lots('Acme Painting')}<a href="/contact">Contact</a><a href="/about">About</a><a href="/gallery">Gallery</a>
     <a href="https://other.com/team">Team</a>`,
  );

  it('crawls the home page plus matching internal pages through the fetcher and caches them', async () => {
    const { fetcher, agent } = makeFetcher();
    serve(agent, 'https://acme.com', { '/': home, '/contact': html(lots('Contact page')), '/about': html(lots('About page')) });
    const ctx = { fetcher, config: testConfig() };
    const r = await crawlSite(ctx, { websiteUrl: 'https://acme.com' });
    expect(r.status).toBe('ok');
    expect(r.pages.map((p) => p.url)).toEqual(['https://acme.com/', 'https://acme.com/contact', 'https://acme.com/about']);
    expect(r.ownDomains).toEqual(['acme.com']);
    expect(r.pages.every((p) => !p.rendered && !p.fromCache && p.sha256.length === 64 && p.cachePath)).toBe(true);

    const again = await crawlSite(ctx, { websiteUrl: 'https://acme.com' });
    expect(again.pages.every((p) => p.fromCache)).toBe(true);
  });

  it('adds https:// when the address has no scheme', async () => {
    const { fetcher, agent } = makeFetcher();
    serve(agent, 'https://acme.com', { '/': html(lots('Acme')) });
    const r = await crawlSite({ fetcher, config: testConfig() }, { websiteUrl: 'acme.com' });
    expect(r.status).toBe('ok');
  });

  it('respects the internal page cap from the config', async () => {
    const { fetcher, agent } = makeFetcher();
    serve(agent, 'https://acme.com', { '/': home, '/contact': html(lots('c')), '/about': html(lots('a')) });
    const r = await crawlSite({ fetcher, config: testConfig({ maxInternalPages: 1 }) }, { websiteUrl: 'https://acme.com' });
    expect(r.pages.map((p) => p.url)).toEqual(['https://acme.com/', 'https://acme.com/contact']);
  });

  it('stays at or under one request per second per domain', async () => {
    const { fetcher, agent, waits } = makeFetcher(testConfig({}, 1000));
    serve(agent, 'https://acme.com', { '/': home, '/contact': html(lots('c')), '/about': html(lots('a')) });
    await crawlSite({ fetcher, config: testConfig({}, 1000) }, { websiteUrl: 'https://acme.com' });
    const real = waits.filter((w) => w > 0);
    expect(real.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...real)).toBeLessThanOrEqual(1000);
  });

  it('honours robots.txt: a disallowed home page is robots_disallowed, a disallowed internal page is skipped', async () => {
    const a = makeFetcher();
    serve(a.agent, 'https://acme.com', { '/': home }, 'User-agent: *\nDisallow: /\n');
    expect((await crawlSite({ fetcher: a.fetcher, config: testConfig() }, { websiteUrl: 'https://acme.com' })).status).toBe('robots_disallowed');

    const b = makeFetcher();
    serve(b.agent, 'https://acme.com', { '/': home, '/contact': html(lots('c')), '/about': html(lots('a')) }, 'User-agent: *\nDisallow: /contact\n');
    const r = await crawlSite({ fetcher: b.fetcher, config: testConfig() }, { websiteUrl: 'https://acme.com' });
    expect(r.status).toBe('ok');
    expect(r.pages.map((p) => p.url)).toEqual(['https://acme.com/', 'https://acme.com/about']);
    expect(r.errors.some((e) => e.url.endsWith('/contact'))).toBe(true);
  });

  it('listing and social hosts are never crawled', async () => {
    const { fetcher } = makeFetcher();
    for (const u of ['https://www.facebook.com/acmepainting', 'https://yelp.com/biz/acme', 'https://linktr.ee/acme', 'https://www.google.com/maps/place/x']) {
      const r = await crawlSite({ fetcher, config: testConfig() }, { websiteUrl: u });
      expect(r.status, u).toBe('shared_host');
      expect(r.pages).toEqual([]);
    }
  });

  it('a shared host is crawled only under its own host and path, and has no company domain', async () => {
    const { fetcher, agent } = makeFetcher();
    serve(agent, 'https://sites.google.com', {
      '/view/acme': html(lots('Acme') + '<a href="/view/acme/contact">Contact</a><a href="/view/other/contact">Contact</a>'),
      '/view/acme/contact': html(lots('Contact')),
    });
    const r = await crawlSite({ fetcher, config: testConfig() }, { websiteUrl: 'https://sites.google.com/view/acme' });
    expect(r.status).toBe('ok');
    expect(r.ownDomains).toEqual([]);
    expect(r.pages.map((p) => p.url)).toEqual(['https://sites.google.com/view/acme', 'https://sites.google.com/view/acme/contact']);
  });

  it('no website and failed fetches', async () => {
    const { fetcher, agent } = makeFetcher();
    expect((await crawlSite({ fetcher, config: testConfig() }, { websiteUrl: null })).status).toBe('no_website');
    expect((await crawlSite({ fetcher, config: testConfig() }, { websiteUrl: '  ' })).status).toBe('no_website');
    serve(agent, 'https://down.com', { '/': { status: 500, body: 'oops' } });
    expect((await crawlSite({ fetcher, config: testConfig() }, { websiteUrl: 'https://down.com' })).status).toBe('fetch_failed');
    serve(agent, 'https://pdf.com', { '/': { body: '%PDF', type: 'application/pdf' } });
    expect((await crawlSite({ fetcher, config: testConfig() }, { websiteUrl: 'https://pdf.com' })).status).toBe('fetch_failed');
  });

  it('re-renders a nearly empty page in Chromium and records rendered true', async () => {
    const { fetcher, agent } = makeFetcher();
    serve(agent, 'https://spa.com', { '/': html('<div id="root"></div>') });
    const rendered = html(`${lots('Rendered Painting')}<a href="/contact">Contact</a>`);
    serve(agent, 'https://spa.com', { '/contact': html(lots('Contact page')) });
    const seen: string[] = [];
    let closed = false;
    const renderer: Renderer = {
      async render(url) {
        seen.push(url);
        return rendered;
      },
      async close() {
        closed = true;
      },
    };
    const r = await crawlSite({ fetcher, config: testConfig(), renderer }, { websiteUrl: 'https://spa.com' });
    expect(seen).toEqual(['https://spa.com/']);
    expect(r.status).toBe('ok');
    expect(r.pages[0]).toMatchObject({ rendered: true, renderFailed: false });
    expect(r.pages[0]?.visible.text).toContain('Rendered Painting');
    expect(r.pages[0]?.cachePath).toBeTruthy();
    expect(r.pages.map((p) => p.url)).toEqual(['https://spa.com/', 'https://spa.com/contact']);
    expect(closed).toBe(false); // an injected renderer belongs to the caller
  });

  it('a failed render is render_failed, never an empty ok page', async () => {
    const { fetcher, agent } = makeFetcher();
    serve(agent, 'https://spa.com', { '/': html('<div id="root"></div>') });
    const renderer: Renderer = {
      async render() {
        throw new Error('boom');
      },
      async close() {},
    };
    const r = await crawlSite({ fetcher, config: testConfig(), renderer }, { websiteUrl: 'https://spa.com' });
    expect(r.status).toBe('render_failed');
    expect(r.pages[0]?.renderFailed).toBe(true);
  });

  it('offline mode uses the cache only: no network, no browser', async () => {
    const { fetcher, agent } = makeFetcher();
    serve(agent, 'https://acme.com', { '/': home, '/contact': html(lots('c')), '/about': html(lots('a')) });
    await crawlSite({ fetcher, config: testConfig() }, { websiteUrl: 'https://acme.com' });
    const off = await crawlSite({ fetcher, config: testConfig(), offline: true }, { websiteUrl: 'https://acme.com' });
    expect(off.status).toBe('ok');
    expect(off.pages).toHaveLength(3);

    const miss = await crawlSite({ fetcher, config: testConfig(), offline: true }, { websiteUrl: 'https://never-seen.com' });
    expect(miss.status).toBe('fetch_failed');

    const emptyCache = makeFetcher();
    serve(emptyCache.agent, 'https://spa.com', { '/': html('<div id="root"></div>') });
    await crawlSite({ fetcher: emptyCache.fetcher, config: testConfig(), renderer: { render: async () => html(lots('x')), close: async () => {} } }, { websiteUrl: 'https://spa.com' });
    // the plain page is cached but its rendered copy cannot be found without a database
    const spaOff = await crawlSite({ fetcher: emptyCache.fetcher, config: testConfig(), offline: true }, { websiteUrl: 'https://spa.com' });
    expect(spaOff.pages[0]?.renderFailed).toBe(true);
  });

  it('fetches at most maxBundles same-site scripts and skips off-site, library and oversized ones', async () => {
    const { fetcher, agent } = makeFetcher();
    const scripts = ['/a.js', '/b.js', '/wp-includes/js/jquery.js', 'https://cdn.other.com/x.js', '/c.js', '/d.js']
      .map((s) => `<script src="${s}"></script>`)
      .join('');
    serve(agent, 'https://acme.com', {
      '/': html(lots('Acme') + scripts),
      '/a.js': { body: 'var a="hello@acme.com"', type: 'application/javascript' },
      '/b.js': { body: 'x'.repeat(3000), type: 'application/javascript' },
      '/c.js': { body: 'var c=1', type: 'application/javascript' },
      '/d.js': { body: 'var d=1', type: 'application/javascript' },
    });
    const cfg = testConfig({ maxBundles: 2, maxBundleBytes: 2000 });
    const r = await crawlSite({ fetcher, config: cfg }, { websiteUrl: 'https://acme.com' });
    expect(r.bundles.map((b) => b.url)).toEqual(['https://acme.com/a.js']);
    expect(r.errors.some((e) => e.url.endsWith('/b.js'))).toBe(true);
    const none = await crawlSite({ fetcher, config: cfg, fetchBundles: false }, { websiteUrl: 'https://acme.com' });
    expect(none.bundles).toEqual([]);
  });
});
