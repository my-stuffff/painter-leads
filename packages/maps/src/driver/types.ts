export interface CardSnapshot {
  /** aria-label of the card's a[href*="/maps/place/"] link. */
  name: string | null;
  href: string;
  /** span[role="img"] aria-label such as "4.8 stars 1,083 Reviews", or null when the card has none. */
  ratingAria: string | null;
  /** The card's innerText. */
  text: string;
  /** The card's Website button link, or null when it has none. */
  websiteHref?: string | null;
}

export interface PlaceSnapshot {
  url: string;
  h1: string | null;
  /** data-item-id of the phone button, e.g. "phone:tel:+15123730002". */
  phoneItemId: string | null;
  phoneAria: string | null;
  /** href of a[data-item-id="authority"]. */
  authorityHref: string | null;
  /** aria-label of button[data-item-id="address"], e.g. "Address: 12357 Riata Trace Pkwy, Austin, TX 78727". */
  addressAria: string | null;
  /** Rating star aria-label, e.g. "4.8 stars". */
  ratingAria: string | null;
  /** The aria-label that is exactly "<n> reviews", e.g. "1,083 reviews". */
  reviewCountAria: string | null;
  reviewsTabPresent: boolean;
  categoryTexts: string[];
  /** Text that says whether the place is closed ("Permanently closed", "Open ⋅ Closes 5 PM"), or null. */
  closedText: string | null;
  /** True when the body text contains "limited view" — recorded for audit, never used to decide anything. */
  bodyHasLimitedViewText: boolean;
}

export interface PageSignals {
  landedUrl: string;
  hasRecaptcha: boolean;
  hasFeed: boolean;
  hasPlacePanel: boolean;
  bodyHasUnusualTraffic: boolean;
  endOfListText: boolean;
}

export interface OpenResult {
  landedUrl: string;
  status: number | null;
}

export interface ScrollResult {
  cardCount: number;
  endReached: boolean;
  grew: boolean;
}

/** One browser page. Everything the scraper needs from Google Maps goes through this interface. */
export interface PageDriver {
  open(url: string): Promise<OpenResult>;
  scrollFeed(): Promise<ScrollResult>;
  snapshotCards(): Promise<CardSnapshot[]>;
  snapshotPlace(): Promise<PlaceSnapshot>;
  pageSignals(): Promise<PageSignals>;
  /** Optional live-only aid for the smoke command: ids and aria-labels found on the page. */
  debugDump?(): Promise<unknown>;
  close(): Promise<void>;
}

export type DriverFactory = () => Promise<PageDriver>;

/** What a saved smoke fixture file holds (and what FixtureDriver replays). */
export type FixturePage =
  | {
      kind: 'search';
      url?: string;
      landedUrl?: string;
      status?: number | null;
      cards: CardSnapshot[];
      endReached?: boolean;
      signals?: Partial<PageSignals>;
    }
  | {
      kind: 'place';
      url?: string;
      landedUrl?: string;
      status?: number | null;
      place: PlaceSnapshot;
      signals?: Partial<PageSignals>;
    }
  | {
      /** A page that is neither a feed nor a place (block pages, interstitials). */
      kind: 'other';
      url?: string;
      landedUrl?: string;
      status?: number | null;
      signals: Partial<PageSignals>;
    }
  | { kind: 'throw'; error: Error };
