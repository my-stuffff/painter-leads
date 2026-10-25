import { launchBrowser, type LaunchedBrowser, type PpConfig } from '@pp/core';
import type { Page } from 'playwright-core';
import * as S from '../selectors';
import { MAPS_HOST } from '../version';
import type { CardSnapshot, OpenResult, PageDriver, PageSignals, PlaceSnapshot, ScrollResult } from './types';

/** The driver only ever navigates to https://www.google.com/maps… */
export function assertMapsUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`refusing to navigate: not a URL: ${url}`);
  }
  if (u.protocol !== 'https:' || u.hostname !== MAPS_HOST || !(u.pathname === '/maps' || u.pathname.startsWith('/maps/'))) {
    throw new Error(`refusing to navigate outside https://${MAPS_HOST}/maps: ${url}`);
  }
}

// The scripts below run inside the page. They are plain JavaScript strings (not TypeScript functions) so a
// transpiler can never inject helpers that do not exist in the browser. DOM reads only: roles, aria-labels,
// hrefs and data-item-id values (selectors.ts).
const j = JSON.stringify;

const SIGNALS_SCRIPT = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const feed = document.querySelector(${j(S.FEED)});
  const h1 = document.querySelector(${j(S.PLACE_H1)});
  const h1Text = h1 ? (h1.innerText || '').trim() : '';
  const placePanel = h1Text.length > 0 && (/\\/maps\\/place\\//.test(location.href) || !!document.querySelector('[data-item-id]'));
  return {
    hasRecaptcha: !!document.querySelector(${j(S.RECAPTCHA)}),
    hasFeed: !!feed,
    hasPlacePanel: placePanel,
    bodyHasUnusualTraffic: /unusual traffic/i.test(text),
    endOfListText: new RegExp(${j(S.END_OF_LIST_RE.source)}, 'i').test(text),
  };
})()`;

const SCROLL_SCRIPT = `(() => {
  const feed = document.querySelector(${j(S.FEED)});
  if (!feed) return false;
  feed.scrollBy(0, 4000);
  return { top: feed.scrollTop, height: feed.scrollHeight, client: feed.clientHeight };
})()`;

const COUNT_SCRIPT = `(() => {
  const feed = document.querySelector(${j(S.FEED)});
  if (!feed) return { cardCount: 0, endReached: false };
  return {
    cardCount: feed.querySelectorAll(${j(S.CARD_LINK)}).length,
    // Page-wide, as the probe did: the end text is not guaranteed to sit inside the feed element.
    endReached: new RegExp(${j(S.END_OF_LIST_RE.source)}, 'i').test((document.body && document.body.innerText) || ''),
  };
})()`;

const CARDS_SCRIPT = `(() => {
  const links = Array.from(document.querySelectorAll(${j(S.FEED + ' ' + S.CARD_LINK)}));
  return links.map((a) => {
    const jsa = a.closest('div[jsaction]');
    const card = (jsa && jsa.parentElement) || a.parentElement;
    const star = card ? card.querySelector(${j(S.STAR_IMG)}) : null;
    const site = card ? card.querySelector(${j(S.CARD_WEBSITE)}) : null;
    return {
      name: a.getAttribute('aria-label'),
      href: a.href.split('?')[0],
      ratingAria: star ? star.getAttribute('aria-label') : null,
      text: ((card && card.innerText) || '').replace(/\\s+\\n/g, '\\n').slice(0, 600),
      websiteHref: site ? site.href : null,
    };
  });
})()`;

const PLACE_SCRIPT = `(() => {
  const q = (s) => document.querySelector(s);
  const aria = (s) => { const e = q(s); return e ? e.getAttribute('aria-label') : null; };
  const body = (document.body && document.body.innerText) || '';
  const h1 = q(${j(S.PLACE_H1)});
  const phone = q(${j(S.PLACE_PHONE)});
  const site = q(${j(S.PLACE_WEBSITE)});
  const star = q(${j(S.STAR_IMG)});
  let reviewCountAria = null;
  for (const e of Array.from(document.querySelectorAll('[aria-label]'))) {
    const l = e.getAttribute('aria-label') || '';
    if (/^\\s*[\\d,]+\\s+reviews?\\s*$/i.test(l)) { reviewCountAria = l.trim(); break; }
  }
  const cats = Array.from(document.querySelectorAll(${j(S.PLACE_CATEGORY)})).map((e) => (e.innerText || '').trim()).filter((t) => t.length > 0);
  // Status line of the place panel: "Permanently closed", else the first "Open ..." / "Closed ..." line
  // (smoke 1 showed the hours row has no data-item-id, so this reads the panel text).
  const main = q('[role="main"]');
  const panelText = (main && main.innerText) || body;
  let closedText = null;
  if (/^\\s*permanently closed\\s*$/im.test(panelText)) closedText = 'Permanently closed';
  else {
    for (const line of panelText.split('\\n')) {
      const t = line.trim();
      if (t.length < 80 && /^(open|closed)(\\s*[\\u22c5\\u00b7]|\\s+24 hours$|$)|^temporarily closed/i.test(t)) { closedText = t; break; }
    }
  }
  return {
    url: location.href,
    h1: h1 ? (h1.innerText || '').trim() : null,
    phoneItemId: phone ? phone.getAttribute('data-item-id') : null,
    phoneAria: phone ? phone.getAttribute('aria-label') : null,
    authorityHref: site ? site.href : null,
    addressAria: aria(${j(S.PLACE_ADDRESS)}),
    ratingAria: star ? star.getAttribute('aria-label') : null,
    reviewCountAria,
    reviewsTabPresent: !!q(${j(S.PLACE_REVIEWS_TAB)}),
    categoryTexts: cats,
    closedText,
    bodyHasLimitedViewText: /limited view/i.test(body),
  };
})()`;

const DEBUG_SCRIPT = `(() => {
  const items = Array.from(document.querySelectorAll('[data-item-id]')).map((e) => ({
    tag: e.tagName, id: e.getAttribute('data-item-id'), aria: e.getAttribute('aria-label'), text: (e.innerText || '').slice(0, 120),
  }));
  const aria = Array.from(document.querySelectorAll('[aria-label]')).slice(0, 200).map((e) => e.tagName + ' | ' + e.getAttribute('role') + ' | ' + e.getAttribute('aria-label'));
  const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((e) => e.getAttribute('aria-label') + ' | ' + (e.innerText || ''));
  const firstCard = document.querySelector(${j(S.FEED + ' ' + S.CARD_LINK)});
  const jsa = firstCard ? firstCard.closest('div[jsaction]') : null;
  const card = (jsa && jsa.parentElement) || (firstCard && firstCard.parentElement);
  const cardLinks = card ? Array.from(card.querySelectorAll('a')).map((a) => (a.getAttribute('aria-label') || '') + ' | ' + a.getAttribute('data-value') + ' | ' + a.href) : [];
  const feed = document.querySelector(${j(S.FEED)});
  const feedText = feed ? (feed.innerText || '') : '';
  const bodyText = (document.body && document.body.innerText) || '';
  const endLike = Array.from(document.querySelectorAll('span,div,p')).filter((e) => e.children.length === 0 && /end of the list|reached the end|no more results/i.test(e.textContent || '')).map((e) => e.tagName + ' | ' + (e.textContent || '').trim().slice(0, 100));
  return { url: location.href, title: document.title, items, aria, tabs, cardLinks, feedTail: feedText.slice(-300), bodyTail: bodyText.slice(-300), endLike };
})()`;

export class PlaywrightDriver implements PageDriver {
  private lastCount = 0;
  private scrollLog: unknown[] = [];

  /** `launched` is closed with the driver; pass only `page` when something else owns the browser (tests). */
  constructor(
    private readonly page: Page,
    private readonly launched?: LaunchedBrowser,
  ) {}

  /** Starts Chromium through the one core launcher (refuses unless PP_LIVE=1). */
  static async launch(config: PpConfig): Promise<PlaywrightDriver> {
    const launched = await launchBrowser({ purpose: 'maps', config });
    const page = await launched.context.newPage();
    return new PlaywrightDriver(page, launched);
  }

  async open(url: string): Promise<OpenResult> {
    assertMapsUrl(url);
    this.lastCount = 0;
    this.scrollLog = [];
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Wait for any page we know how to read; a block page has a reCAPTCHA or lands on /sorry/.
    await this.page
      .waitForSelector(`${S.FEED}, ${S.PLACE_H1}, ${S.RECAPTCHA}`, { timeout: 30_000 })
      .catch(() => undefined);
    return { landedUrl: this.page.url(), status: response ? response.status() : null };
  }

  async scrollFeed(): Promise<ScrollResult> {
    const pos = await this.page.evaluate(SCROLL_SCRIPT);
    await this.page.waitForTimeout(1000 + Math.floor(Math.random() * 500));
    let r = (await this.page.evaluate(COUNT_SCRIPT)) as { cardCount: number; endReached: boolean };
    if (r.cardCount <= this.lastCount && !r.endReached) {
      // Nothing new yet: give Maps a little longer before counting this scroll as empty.
      await this.page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
      r = (await this.page.evaluate(COUNT_SCRIPT)) as { cardCount: number; endReached: boolean };
    }
    const grew = r.cardCount > this.lastCount;
    this.lastCount = r.cardCount;
    this.scrollLog.push({ ...r, grew, pos });
    return { cardCount: r.cardCount, endReached: r.endReached, grew };
  }

  async snapshotCards(): Promise<CardSnapshot[]> {
    return (await this.page.evaluate(CARDS_SCRIPT)) as CardSnapshot[];
  }

  async snapshotPlace(): Promise<PlaceSnapshot> {
    await this.page.waitForSelector(S.PLACE_H1, { timeout: 30_000 }).catch(() => undefined);
    await this.page.waitForTimeout(2500);
    return (await this.page.evaluate(PLACE_SCRIPT)) as PlaceSnapshot;
  }

  async pageSignals(): Promise<PageSignals> {
    const s = (await this.page.evaluate(SIGNALS_SCRIPT)) as Omit<PageSignals, 'landedUrl'>;
    return { landedUrl: this.page.url(), ...s };
  }

  async debugDump(): Promise<unknown> {
    const dump = (await this.page.evaluate(DEBUG_SCRIPT)) as Record<string, unknown>;
    return { ...dump, scrollLog: this.scrollLog };
  }

  async close(): Promise<void> {
    if (this.launched) await this.launched.close();
    else await this.page.close();
  }
}
