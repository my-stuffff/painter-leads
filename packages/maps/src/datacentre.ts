import type { PpConfig } from '@pp/core';
import { detectBlock } from './blocks';
import type { LoggedRequest } from './cap';
import type { PageDriver } from './driver/types';
import { scrollFeedToEnd } from './feed';
import { parseCard } from './parse/card';
import { parsePlace } from './parse/place';
import { withLocale } from './parse/url';
import { buildTextSearchUrl } from './query';
import { randomPause } from './throttle';

export interface DatacentreSummary {
  label: string;
  attempted: { searches: number; places: number };
  ok: number;
  blocked: { sorry: number; captcha: number; unusual_traffic: number };
  limitedView: number;
  cardsPerSearch: number[];
  msPerSearch: number[];
  avgCardsPerSearch: number | null;
  avgMsPerSearch: number | null;
  /** Set when a block stopped the test early. */
  stoppedOn: string | null;
}

export interface DatacentreOptions {
  label: string;
  config: PpConfig;
  /** Number of queries (from config.maps.dcTest.queries) to run. */
  searches: number;
  /** Number of place pages to open (the first card of each search), at most one per search. */
  places: number;
  driver: PageDriver;
  sleep(ms: number): Promise<void>;
  rng?: () => number;
  /** Optional sink for request_log rows (absent with --no-db). */
  log?: (entry: LoggedRequest) => Promise<void>;
  now?: () => Date;
}

const avg = (xs: number[]): number | null => (xs.length === 0 ? null : Math.round(xs.reduce((a, b) => a + b, 0) / xs.length));

/**
 * A small scripted batch against Maps that reports how many requests worked, were blocked or showed limited
 * view (D-30). It stops at the first block. The worker never runs this live; the orchestrator does (01-06).
 */
export async function runDatacentreTest(o: DatacentreOptions): Promise<DatacentreSummary> {
  const { config, driver } = o;
  const now = o.now ?? (() => new Date());
  const queries = config.maps.dcTest.queries.slice(0, o.searches);
  const summary: DatacentreSummary = {
    label: o.label,
    attempted: { searches: 0, places: 0 },
    ok: 0,
    blocked: { sorry: 0, captcha: 0, unusual_traffic: 0 },
    limitedView: 0,
    cardsPerSearch: [],
    msPerSearch: [],
    avgCardsPerSearch: null,
    avgMsPerSearch: null,
    stoppedOn: null,
  };
  const note = `dctest:${o.label}`;
  const record = async (entry: Omit<LoggedRequest, 'runId' | 'note' | 'at'>): Promise<void> => {
    await o.log?.({ ...entry, runId: null, note, at: now() });
  };
  const noteBlock = (signal: string): void => {
    if (signal === 'sorry' || signal === 'captcha' || signal === 'unusual_traffic') summary.blocked[signal]++;
    else summary.blocked.unusual_traffic++;
    summary.stoppedOn = signal;
  };

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i] as string;
    const url = buildTextSearchUrl(query);
    const started = Date.now();
    summary.attempted.searches++;
    const opened = await driver.open(url);
    const signals = await driver.pageSignals();
    const block = detectBlock(signals, opened.status);
    if (block) {
      await record({
        url,
        status: opened.status,
        ms: Date.now() - started,
        outcome: block === 'sorry' ? 'sorry' : block === 'captcha' ? 'captcha' : 'blocked',
      });
      noteBlock(block);
      return finish(summary);
    }
    await scrollFeedToEnd(driver, config.maps.maxScrolls);
    const cards = await driver.snapshotCards();
    const ms = Date.now() - started;
    summary.cardsPerSearch.push(cards.length);
    summary.msPerSearch.push(ms);
    summary.ok++;
    await record({ url, status: opened.status, ms, outcome: 'ok' });

    if (summary.attempted.places < o.places && cards[0]) {
      await o.sleep(randomPause(config.maps.placePauseMs, o.rng));
      const placeUrl = withLocale(parseCard(cards[0]).profileUrl);
      const placeStarted = Date.now();
      summary.attempted.places++;
      const placeOpened = await driver.open(placeUrl);
      const placeSignals = await driver.pageSignals();
      const placeBlock = detectBlock(placeSignals, placeOpened.status);
      if (placeBlock) {
        await record({
          url: placeUrl,
          status: placeOpened.status,
          ms: Date.now() - placeStarted,
          outcome: placeBlock === 'sorry' ? 'sorry' : placeBlock === 'captcha' ? 'captcha' : 'blocked',
        });
        noteBlock(placeBlock);
        return finish(summary);
      }
      const snapshot = await driver.snapshotPlace();
      const parsed = parsePlace(snapshot);
      const limited = parsed.limitedView;
      if (limited) summary.limitedView++;
      else if (parsed.loaded) summary.ok++;
      await record({
        url: placeUrl,
        status: placeOpened.status,
        ms: Date.now() - placeStarted,
        outcome: limited ? 'limited_view' : 'ok',
      });
    }
    if (i < queries.length - 1) await o.sleep(randomPause(config.maps.searchPauseMs, o.rng));
  }
  return finish(summary);
}

function finish(s: DatacentreSummary): DatacentreSummary {
  s.avgCardsPerSearch = avg(s.cardsPerSearch);
  s.avgMsPerSearch = avg(s.msPerSearch);
  return s;
}
