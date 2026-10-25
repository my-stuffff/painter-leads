import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir, loadAreas, zctaForPoint, type AreaDef, type PpConfig } from '@pp/core';
import { detectBlock } from './blocks';
import type { CardSnapshot, DriverFactory, FixturePage, PageDriver } from './driver/types';
import { scrollFeedToEnd } from './feed';
import { parseCard } from './parse/card';
import { parsePlace } from './parse/place';
import { withLocale } from './parse/url';
import { buildSearchUrl, type QueryForm } from './query';
import { randomPause } from './throttle';

interface Budget {
  searches: number;
  placePages: number;
}

export function budgetFile(config: PpConfig): string {
  return path.join(dataDir(config), 'maps', 'smoke-budget.json');
}

function readBudget(file: string, worker: string): Budget {
  try {
    const all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Budget>;
    return all[worker] ?? { searches: 0, placePages: 0 };
  } catch {
    return { searches: 0, placePages: 0 };
  }
}

function writeBudget(file: string, worker: string, b: Budget): void {
  let all: Record<string, Budget> = {};
  try {
    all = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Budget>;
  } catch {
    all = {};
  }
  all[worker] = b;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2));
}

export class SmokeBudgetError extends Error {}

export interface SmokeOptions {
  config: PpConfig;
  zip: string;
  term: string;
  form: QueryForm;
  /** Place pages to open after the search (counts against the budget). */
  places: number;
  saveFixturesDir?: string;
  worker?: string;
  driverFactory: DriverFactory;
  sleep(ms: number): Promise<void>;
  rng?: () => number;
  budgetPath?: string;
}

export interface SmokeReport {
  searchNumber: number;
  url: string;
  landedUrl: string;
  cardCount: number;
  endReached: boolean;
  blocked: string | null;
  locality: Locality | null;
  placesOpened: { name: string | null; landedUrl: string; limitedView: boolean; loaded: boolean; savedAs: string | null }[];
  budgetUsed: Budget;
  budgetAllowed: Budget;
  savedFixtures: string[];
}

export interface Locality {
  area: string | null;
  cardsWithCoords: number;
  inAreaZctas: number;
  inAreaOrNeighbourRing: number;
  inTargetZip: number;
  shareInAreaOrRing: number | null;
  shareInArea: number | null;
  topZctas: { zcta: string; cards: number }[];
}

function areaForZip(config: PpConfig, zip: string): AreaDef | null {
  const areas = loadAreas(config);
  return (
    areas.find(
      (a) => a.allZctas.some((z) => z.zcta === zip) || a.expansionZctas.includes(zip) || a.poBoxZips.includes(zip),
    ) ?? null
  );
}

/** Where the cards' coordinates fall: in the area's ZCTAs, in the pilot ZCTA file (area + neighbour ring), or elsewhere. */
export function localityShare(config: PpConfig, zip: string, cards: CardSnapshot[]): Locality {
  const area = areaForZip(config, zip);
  const areaZctas = new Set<string>(
    area ? [...area.allZctas.map((z) => z.zcta), ...area.expansionZctas, ...area.poBoxZips] : [],
  );
  const counts = new Map<string, number>();
  let withCoords = 0;
  let inArea = 0;
  let inRing = 0;
  let inTarget = 0;
  for (const c of cards) {
    const p = parseCard(c);
    if (p.lat.value === null || p.lng.value === null) continue;
    withCoords++;
    const z = zctaForPoint(p.lat.value, p.lng.value);
    if (!z) continue;
    inRing++;
    counts.set(z, (counts.get(z) ?? 0) + 1);
    if (areaZctas.has(z)) inArea++;
    if (z === zip) inTarget++;
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([zcta, n]) => ({ zcta, cards: n }));
  return {
    area: area?.id ?? null,
    cardsWithCoords: withCoords,
    inAreaZctas: inArea,
    inAreaOrNeighbourRing: inRing,
    inTargetZip: inTarget,
    shareInAreaOrRing: withCoords === 0 ? null : inRing / withCoords,
    shareInArea: withCoords === 0 ? null : inArea / withCoords,
    topZctas: top,
  };
}

function save(dir: string, name: string, page: FixturePage): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `${JSON.stringify(page, null, 2)}\n`);
  return file;
}

async function dump(config: PpConfig, driver: PageDriver, name: string): Promise<void> {
  if (!driver.debugDump) return;
  const dir = path.join(dataDir(config), 'maps', 'smoke-debug');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), JSON.stringify(await driver.debugDump(), null, 2));
}

/**
 * One live smoke search (plus a few place pages), under the all-time per-worker budget in
 * dataDir/maps/smoke-budget.json (D-15). Refuses once the budget is used. The budget is spent BEFORE the
 * request, so a crash cannot give extra requests.
 */
export async function runSmoke(o: SmokeOptions): Promise<SmokeReport> {
  const { config } = o;
  const worker = o.worker ?? process.env.PP_WORKER ?? 'default';
  const file = o.budgetPath ?? budgetFile(config);
  const allowed = config.maps.smokeBudget;
  const used = readBudget(file, worker);
  if (used.searches >= allowed.searches) {
    throw new SmokeBudgetError(
      `smoke budget used up for worker "${worker}": ${used.searches}/${allowed.searches} searches (${file})`,
    );
  }
  if (o.places > allowed.placePages - used.placePages) {
    throw new SmokeBudgetError(
      `smoke budget allows ${allowed.placePages - used.placePages} more place pages for worker "${worker}", asked for ${o.places}`,
    );
  }

  let center: { lat: number; lng: number } | null = null;
  if (o.form === 'viewport') {
    const z = areaForZip(config, o.zip)?.allZctas.find((x) => x.zcta === o.zip);
    if (!z) throw new Error(`no Gazetteer centroid for ZIP ${o.zip} in the areas file`);
    center = { lat: z.lat, lng: z.lng };
  }
  const url = buildSearchUrl(
    { term: o.term, zip: o.zip, centerLat: center?.lat ?? null, centerLng: center?.lng ?? null },
    o.form,
  );

  used.searches++;
  writeBudget(file, worker, used);
  const searchNumber = used.searches;
  const report: SmokeReport = {
    searchNumber,
    url,
    landedUrl: '',
    cardCount: 0,
    endReached: false,
    blocked: null,
    locality: null,
    placesOpened: [],
    budgetUsed: used,
    budgetAllowed: allowed,
    savedFixtures: [],
  };

  const driver = await o.driverFactory();
  try {
    const opened = await driver.open(url);
    report.landedUrl = opened.landedUrl;
    const signals = await driver.pageSignals();
    const block = detectBlock(signals, opened.status);
    if (block) {
      report.blocked = block;
      if (o.saveFixturesDir) {
        report.savedFixtures.push(
          save(o.saveFixturesDir, `smoke-${searchNumber}-blocked.json`, {
            kind: 'other',
            url,
            landedUrl: opened.landedUrl,
            status: opened.status,
            signals,
          }),
        );
      }
      return report;
    }
    const feed = await scrollFeedToEnd(driver, config.maps.maxScrolls);
    const cards = await driver.snapshotCards();
    report.cardCount = cards.length;
    report.endReached = feed.endReached;
    report.locality = localityShare(config, o.zip, cards);
    await dump(config, driver, `${worker}-search-${searchNumber}.json`);
    if (o.saveFixturesDir) {
      report.savedFixtures.push(
        save(o.saveFixturesDir, `smoke-${searchNumber}-search.json`, {
          kind: 'search',
          url,
          landedUrl: opened.landedUrl,
          status: opened.status,
          cards,
          endReached: feed.endReached,
          signals: { ...signals, hasFeed: true },
        }),
      );
    }

    // Place pages: the first card, then (if there is one) a service-area business with no street, then the rest.
    const parsed = cards.map((c) => ({ c, p: parseCard(c) }));
    const picks: CardSnapshot[] = [];
    const first = parsed[0];
    if (first) picks.push(first.c);
    const serviceArea = parsed.find((x, i) => i > 0 && x.p.street.status !== 'captured' && x.p.profileUrl);
    if (serviceArea && o.places >= 2) picks.push(serviceArea.c);
    for (const x of parsed) {
      if (picks.length >= o.places) break;
      if (!picks.includes(x.c)) picks.push(x.c);
    }

    for (const card of picks.slice(0, o.places)) {
      used.placePages++;
      writeBudget(file, worker, used);
      await o.sleep(randomPause(config.maps.placePauseMs, o.rng));
      const placeUrl = withLocale(parseCard(card).profileUrl);
      const placeOpened = await driver.open(placeUrl);
      const placeSignals = await driver.pageSignals();
      const placeBlock = detectBlock(placeSignals, placeOpened.status);
      if (placeBlock) {
        report.blocked = placeBlock;
        break;
      }
      const place = await driver.snapshotPlace();
      const pp = parsePlace(place);
      let savedAs: string | null = null;
      await dump(config, driver, `${worker}-place-${used.placePages}.json`);
      if (o.saveFixturesDir) {
        savedAs = save(o.saveFixturesDir, `smoke-place-${used.placePages}.json`, {
          kind: 'place',
          url: placeUrl,
          landedUrl: placeOpened.landedUrl,
          status: placeOpened.status,
          place,
          signals: { ...placeSignals, hasPlacePanel: true },
        });
        report.savedFixtures.push(savedAs);
      }
      report.placesOpened.push({
        name: pp.name,
        landedUrl: placeOpened.landedUrl,
        limitedView: pp.limitedView,
        loaded: pp.loaded,
        savedAs,
      });
    }
    return report;
  } finally {
    await driver.close();
  }
}
