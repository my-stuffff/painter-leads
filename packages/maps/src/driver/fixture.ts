import type {
  CardSnapshot,
  FixturePage,
  OpenResult,
  PageDriver,
  PageSignals,
  PlaceSnapshot,
  ScrollResult,
} from './types';

const NO_SIGNALS: Omit<PageSignals, 'landedUrl'> = {
  hasRecaptcha: false,
  hasFeed: false,
  hasPlacePanel: false,
  bodyHasUnusualTraffic: false,
  endOfListText: false,
};

/**
 * Replays saved snapshots instead of driving a browser. Each open() consumes the next page in the list
 * (or throws, or returns a block page when the list says so). A search page reveals its cards in steps of
 * `cardsPerScroll` so the scroll loop is exercised.
 */
export class FixtureDriver implements PageDriver {
  readonly opened: string[] = [];
  closed = false;
  private index = 0;
  private current: FixturePage | null = null;
  private landedUrl = '';
  private revealed = 0;
  private scrolls = 0;

  constructor(
    private readonly pages: FixturePage[],
    private readonly o: { cardsPerScroll?: number } = {},
  ) {}

  get pagesLeft(): number {
    return this.pages.length - this.index;
  }

  async open(url: string): Promise<OpenResult> {
    this.opened.push(url);
    const page = this.pages[this.index++];
    if (!page) throw new Error(`FixtureDriver has no page left for ${url}`);
    if (page.kind === 'throw') throw page.error;
    this.current = page;
    this.landedUrl = page.landedUrl ?? url;
    this.scrolls = 0;
    this.revealed = 0;
    return { landedUrl: this.landedUrl, status: page.status ?? 200 };
  }

  async scrollFeed(): Promise<ScrollResult> {
    const page = this.current;
    if (!page || page.kind !== 'search') return { cardCount: 0, endReached: false, grew: false };
    const step = this.o.cardsPerScroll ?? 1000;
    const before = this.revealed;
    this.revealed = Math.min(page.cards.length, this.revealed + step);
    this.scrolls++;
    const allShown = this.revealed >= page.cards.length;
    return {
      cardCount: this.revealed,
      endReached: allShown && (page.endReached ?? false),
      grew: this.revealed > before,
    };
  }

  async snapshotCards(): Promise<CardSnapshot[]> {
    const page = this.current;
    if (!page || page.kind !== 'search') return [];
    return page.cards.slice(0, this.revealed || page.cards.length);
  }

  async snapshotPlace(): Promise<PlaceSnapshot> {
    const page = this.current;
    if (!page || page.kind !== 'place') throw new Error('FixtureDriver: current page is not a place page');
    return { ...page.place, url: page.place.url || this.landedUrl };
  }

  async pageSignals(): Promise<PageSignals> {
    const page = this.current;
    if (!page) return { landedUrl: this.landedUrl, ...NO_SIGNALS };
    const base: PageSignals = { landedUrl: this.landedUrl, ...NO_SIGNALS };
    if (page.kind === 'search') {
      base.hasFeed = true;
      base.endOfListText = (page.endReached ?? false) && this.revealed >= page.cards.length;
    } else if (page.kind === 'place') {
      base.hasPlacePanel = true;
    }
    return { ...base, ...(page.kind === 'throw' ? {} : page.signals), landedUrl: this.landedUrl };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
