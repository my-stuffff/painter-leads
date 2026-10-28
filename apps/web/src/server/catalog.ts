import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '@pp/core';
import type pg from 'pg';
import type { Catalog, CatalogCity, CatalogState, StateCode } from '../shared/api';
import { iso, q } from './sql';

/** One city of data/geo/catalog.json (written by `pp geo build`). */
export interface CatalogFileCity {
  areaId: string;
  state: StateCode;
  name: string;
  population: number;
  popYear: number;
  lat: number;
  lng: number;
  zipCount: number;
}

export const STATES: CatalogState[] = [
  { code: 'CA', name: 'California', ownerSources: ['CSLB contractor licences'] },
  { code: 'TX', name: 'Texas', ownerSources: ['Texas Comptroller'] },
  { code: 'NJ', name: 'New Jersey', ownerSources: ['NJ home improvement register'] },
];

interface AreaFileEntry {
  id: string;
  kind?: string;
  state: StateCode;
  city: string;
  allZctas: { lat: number; lng: number }[];
  pilotZctas: string[];
}

/**
 * The cities a search can cover, biggest first. Reads data/geo/catalog.json; when it is missing, falls back to
 * the whole-city areas of pilot-areas.json (population unknown = 0) so the app still works.
 */
export function loadCatalogCities(root = REPO_ROOT): CatalogFileCity[] {
  try {
    const file = JSON.parse(readFileSync(path.join(root, 'data/geo/catalog.json'), 'utf8')) as { cities: CatalogFileCity[] };
    return file.cities;
  } catch {
    const areas = JSON.parse(readFileSync(path.join(root, 'data/geo/pilot-areas.json'), 'utf8')) as AreaFileEntry[];
    return areas
      .filter((a) => a.kind === 'city')
      .map((a) => {
        const n = Math.max(1, a.allZctas.length);
        return {
          areaId: a.id,
          state: a.state,
          name: a.city,
          population: 0,
          popYear: 0,
          lat: a.allZctas.reduce((s, z) => s + z.lat, 0) / n,
          lng: a.allZctas.reduce((s, z) => s + z.lng, 0) / n,
          zipCount: a.pilotZctas.length,
        };
      });
  }
}

/** Newest finished run per area. */
export async function lastRuns(pool: pg.Pool): Promise<Map<string, { runId: number; finishedAt: string }>> {
  const rows = await q<{ area_id: string; id: number; finished_at: Date }>(
    pool,
    `SELECT DISTINCT ON (area_id) area_id, id, finished_at FROM runs
      WHERE status = 'done' AND finished_at IS NOT NULL ORDER BY area_id, finished_at DESC`,
  );
  return new Map(rows.map((r) => [r.area_id, { runId: r.id, finishedAt: iso(r.finished_at) ?? '' }]));
}

export async function buildCatalog(pool: pg.Pool, cities: CatalogFileCity[]): Promise<Catalog> {
  const runs = await lastRuns(pool);
  const out: CatalogCity[] = cities.map((c) => ({
    areaId: c.areaId,
    state: c.state,
    name: c.name,
    population: c.population,
    popYear: c.popYear,
    lat: c.lat,
    lng: c.lng,
    zipCount: c.zipCount,
    lastRun: runs.get(c.areaId) ?? null,
  }));
  return { states: STATES, cities: out };
}
