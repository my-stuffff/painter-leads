import type { PageDriver } from './driver/types';

/** Scrolls in a row that add no card before the list is taken as finished (the probe waited for 6). */
export const STAGNANT_LIMIT = 4;

/** Google never returns more than this many cards for one search (PROBES §1). */
export const FEED_CARD_CAP = 120;

export interface FeedResult {
  cardCount: number;
  endReached: boolean;
  scrolls: number;
}

/**
 * Scrolls the results list until the end-of-list text shows, the 120-card cap is reached, `maxScrolls`
 * is used up, or four scrolls in a row add nothing. At the cap one more scroll is allowed to see whether
 * the end text appears; if not, end_reached is false (the list may have held more).
 */
export async function scrollFeedToEnd(driver: PageDriver, maxScrolls: number): Promise<FeedResult> {
  let stagnant = 0;
  let confirmedCap = false;
  let cardCount = 0;
  let scrolls = 0;
  while (scrolls < maxScrolls) {
    const r = await driver.scrollFeed();
    scrolls++;
    cardCount = r.cardCount;
    if (r.endReached) return { cardCount, endReached: true, scrolls };
    if (cardCount >= FEED_CARD_CAP) {
      if (confirmedCap) break;
      confirmedCap = true;
      continue;
    }
    stagnant = r.grew ? 0 : stagnant + 1;
    if (stagnant >= STAGNANT_LIMIT) break;
  }
  return { cardCount, endReached: false, scrolls };
}
