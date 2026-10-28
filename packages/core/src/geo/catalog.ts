import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PpConfig } from '../config/schema';
import { REPO_ROOT } from '../paths';
import type { StateCode } from '../types';
import { areasFilePath } from './areas';

/** One city the web app offers: a Census incorporated place (or, in NJ, a county subdivision) and its area. */
export interface CatalogCity {
  /** The whole-city area in pilot-areas.json (kind 'city') that searches this city. */
  areaId: string;
  state: StateCode;
  /** Plain name, e.g. "Los Angeles", "Woodbridge". */
  name: string;
  /** Census name with its legal description, e.g. "Los Angeles city", "Woodbridge township". */
  censusName: string;
  /** 'place' = Census incorporated place (GEOID state+place, 7 digits); 'cousub' = NJ county subdivision (10 digits). */
  kind: 'place' | 'cousub';
  geoid: string;
  population: number;
  popYear: number;
  /** Centre of the city's searched ZCTAs (Gazetteer internal points weighted by the land each has inside the city). */
  lat: number;
  lng: number;
  /** ZIPs searched for this city (= the area's pilotZctas length). */
  zipCount: number;
}

export interface CatalogFile {
  builtAt: string;
  sources: string[];
  minPopulation: number;
  popYear: number;
  /** Biggest first (population descending, ties by name). */
  cities: CatalogCity[];
}

export const CATALOG_FILE_NAME = 'catalog.json';

/** The committed catalog in the repo (data/geo/catalog.json). */
export const CATALOG_PATH = path.join(REPO_ROOT, 'data', 'geo', CATALOG_FILE_NAME);

/** catalog.json lives next to the areas file (config.areas.file). */
export function catalogFilePath(config: PpConfig): string {
  return path.join(path.dirname(areasFilePath(config)), CATALOG_FILE_NAME);
}

export function loadCatalog(config: PpConfig): CatalogFile {
  const file = catalogFilePath(config);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CatalogFile;
  } catch (e) {
    throw new Error(`Cannot read city catalog ${file} (run: pp geo build): ${(e as Error).message}`);
  }
}
