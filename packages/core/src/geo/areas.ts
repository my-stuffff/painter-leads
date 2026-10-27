import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PpConfig } from '../config/schema';
import { REPO_ROOT } from '../paths';
import type { StateCode } from '../types';

export interface AreaZcta {
  zcta: string;
  /** Fraction of the ZCTA's land that lies inside the area (Census AREALAND_PART / AREALAND_ZCTA5_20). */
  share: number;
  lat: number;
  lng: number;
}

export interface AreaDef {
  /** Pilot areas: edison_nj, austin_tx, san_diego_ca. Whole-city areas: e.g. los_angeles_ca (see `kind`). */
  id: string;
  /**
   * 'city' = a whole Census place searched in full (pilotZctas = every ZCTA in allZctas). Absent on the three
   * pilot areas, whose pilotZctas are a fixed subset.
   */
  kind?: 'city';
  label: string;
  state: StateCode;
  city: string;
  censusKind: 'place' | 'cousub';
  geoid: string;
  allZctas: AreaZcta[];
  pilotZctas: string[];
  expansionZctas: string[];
  poBoxZips: string[];
  /** false = the PO-box ZIPs were not checked against USPS (research A3). */
  poBoxZipsVerified?: boolean;
}

export function areasFilePath(config: PpConfig): string {
  const f = config.areas.file;
  return path.isAbsolute(f) ? f : path.join(REPO_ROOT, f);
}

export function loadAreas(config: PpConfig): AreaDef[] {
  const file = areasFilePath(config);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AreaDef[];
  } catch (e) {
    throw new Error(`Cannot read areas file ${file} (run: pp geo build): ${(e as Error).message}`);
  }
}

export function getArea(config: PpConfig, id: string): AreaDef {
  const area = loadAreas(config).find((a) => a.id === id);
  if (!area) throw new Error(`Unknown area "${id}"`);
  return area;
}

/** A ZIP belongs to the area when it is one of its ZCTAs, an expansion ZCTA or a listed PO-box ZIP. */
export function isZipInArea(area: AreaDef, zip: string): boolean {
  return (
    area.allZctas.some((z) => z.zcta === zip) || area.expansionZctas.includes(zip) || area.poBoxZips.includes(zip)
  );
}
