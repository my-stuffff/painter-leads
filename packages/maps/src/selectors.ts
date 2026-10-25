// Every selector the Maps driver uses, in one place. All of them are roles, aria-labels, href parts or
// data-item-id values — never CSS class names (those are obfuscated and change). Source of each:
// .planning/research/PROBES-2026-10-25.md §1 (live probe 2026-10-25) unless noted.

/** Results list; scrolling it loads more cards; ends with the end-of-list text. (PROBES §1) */
export const FEED = 'div[role="feed"]';
/** One link per card. The aria-label is the business name; the href carries !19s place id, !1s CID, !3d/!4d. (PROBES §1) */
export const CARD_LINK = 'a[href*="/maps/place/"]';
/** Card star rating: aria-label like "4.8 stars 1,083 Reviews". (PROBES §1) */
export const STAR_IMG = 'span[role="img"][aria-label*="star" i]';
/** The card's Website button (aria-label starts with "Website"). Confirmed live by smoke 1, see test/fixtures/README.md. */
export const CARD_WEBSITE = 'a[aria-label*="website" i]';
/** End of the feed, matched on text because Maps gives it no role. (PROBES §1) */
export const END_OF_LIST_RE = /you['’]ve reached the end of the list/i;

/** Place page. (PROBES §1) */
export const PLACE_H1 = 'h1';
export const PLACE_PHONE = 'button[data-item-id^="phone:tel:"]';
export const PLACE_WEBSITE = 'a[data-item-id="authority"]';
export const PLACE_ADDRESS = 'button[data-item-id="address"]';
export const PLACE_CATEGORY = 'button[jsaction*="category"]';
// No selector for the hours row: smoke 1 showed it has no data-item-id; the status line is read from the place panel text.
/** The Reviews tab. Only used to rule limited view out, so a miss here is harmless on a normal page. */
export const PLACE_REVIEWS_TAB = '[role="tab"][aria-label*="review" i]';

/** Block pages. (research Pattern 3) */
export const RECAPTCHA = 'iframe[src*="recaptcha"], form#captcha-form';
