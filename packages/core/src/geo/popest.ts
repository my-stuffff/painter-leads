import { parse } from 'csv-parse/sync';
import type { StateCode } from '../types';

/**
 * City catalog selection from the Census Vintage 2024 sub-county population estimates (sub-est2024.csv).
 * Pure functions: the build (build.ts) downloads the file and joins the result to the ZCTA relationship files.
 */

export const POPEST_URL =
  'https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/cities/totals/sub-est2024.csv';
export const CATALOG_MIN_POPULATION = 50_000;
export const CATALOG_POP_YEAR = 2024;
export const CATALOG_STATES: readonly StateCode[] = ['CA', 'TX', 'NJ'];
/** States whose county subdivisions (townships) are municipalities in their own right and join the catalog. */
export const CATALOG_COUSUB_STATES: readonly StateCode[] = ['NJ'];
export const STATE_FIPS: Record<StateCode, string> = { CA: '06', TX: '48', NJ: '34' };

/** SUMLEV 162 = incorporated place; 061 = minor civil division (county subdivision). */
export const SUMLEV_PLACE = '162';
export const SUMLEV_COUSUB = '061';

export interface PopEstRow {
  sumlev: string;
  state: string;
  county: string;
  place: string;
  cousub: string;
  name: string;
  population: number;
}

export interface CatalogCandidate {
  state: StateCode;
  kind: 'place' | 'cousub';
  /** place: state+place (7 digits); cousub: state+county+cousub (10 digits), as in the ZCTA relationship files. */
  geoid: string;
  /** NAME as the estimates file gives it, e.g. "Woodbridge township". */
  censusName: string;
  /** censusName without its legal description, e.g. "Woodbridge". */
  name: string;
  population: number;
}

const REQUIRED = ['SUMLEV', 'STATE', 'COUNTY', 'PLACE', 'COUSUB', 'NAME'];

/** Parses sub-est2024.csv (comma-separated, Latin-1: e.g. "La Cañada Flintridge city"). */
export function parsePopEstimates(buf: Buffer, popYear: number = CATALOG_POP_YEAR): PopEstRow[] {
  const popCol = `POPESTIMATE${popYear}`;
  const rows = parse(buf.toString('latin1'), {
    columns: (h: string[]) => h.map((x) => x.trim()),
    bom: true,
    skip_empty_lines: true,
  }) as Record<string, string>[];
  const header = rows[0] ? Object.keys(rows[0]) : [];
  const missing = [...REQUIRED, popCol].filter((c) => !header.includes(c));
  if (missing.length > 0) throw new Error(`population estimates file lacks column(s) ${missing.join(', ')}`);
  return rows.map((r) => ({
    sumlev: (r.SUMLEV ?? '').trim(),
    state: (r.STATE ?? '').trim(),
    county: (r.COUNTY ?? '').trim(),
    place: (r.PLACE ?? '').trim(),
    cousub: (r.COUSUB ?? '').trim(),
    name: (r.NAME ?? '').trim(),
    population: Number((r[popCol] ?? '').trim()),
  }));
}

const LSAD_SUFFIX = /\s+(city|town|township|borough|village|municipality|CDP)$/;

/** "Los Angeles city" -> "Los Angeles", "Union City city" -> "Union City", "Woodbridge township" -> "Woodbridge". */
export function shortName(censusName: string): string {
  return censusName.replace(LSAD_SUFFIX, '').trim();
}

/** "San Buenaventura (Ventura)" -> "san_buenaventura_ventura", "La Cañada" -> "la_canada". */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Biggest first; ties by name, then GEOID (deterministic, locale-independent). */
export function compareCatalog(
  a: Pick<CatalogCandidate, 'population' | 'name' | 'geoid'>,
  b: Pick<CatalogCandidate, 'population' | 'name' | 'geoid'>,
): number {
  if (a.population !== b.population) return b.population - a.population;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.geoid < b.geoid ? -1 : a.geoid > b.geoid ? 1 : 0;
}

export interface SelectOptions {
  minPopulation: number;
  states: readonly StateCode[];
  cousubStates: readonly StateCode[];
}

/**
 * Every incorporated place (SUMLEV 162) in the states with population >= minPopulation, plus, in cousubStates,
 * every county subdivision (SUMLEV 061) >= minPopulation that is not itself a place. A NJ city is both a place and a
 * county subdivision under the same 5-digit code (Newark city: PLACE 51000, COUSUB 51000), so a county subdivision
 * whose code is a place code in the same state is the same municipality and is left to the place row.
 * Other summary levels (157 place-in-county, 071 place-in-subdivision, 040, 050, 170, 172) are ignored.
 */
export function selectCatalogCities(rows: PopEstRow[], o: SelectOptions): CatalogCandidate[] {
  const stateByFips = new Map(o.states.map((s) => [STATE_FIPS[s], s] as const));
  const placeCodes = new Set(rows.filter((r) => r.sumlev === SUMLEV_PLACE).map((r) => `${r.state}${r.place}`));
  const out: CatalogCandidate[] = [];
  for (const r of rows) {
    const state = stateByFips.get(r.state);
    if (!state || !Number.isFinite(r.population) || r.population < o.minPopulation) continue;
    if (r.sumlev === SUMLEV_PLACE) {
      out.push({ state, kind: 'place', geoid: `${r.state}${r.place}`, censusName: r.name, name: shortName(r.name), population: r.population });
    } else if (r.sumlev === SUMLEV_COUSUB && o.cousubStates.includes(state) && !placeCodes.has(`${r.state}${r.cousub}`)) {
      out.push({
        state,
        kind: 'cousub',
        geoid: `${r.state}${r.county}${r.cousub}`,
        censusName: r.name,
        name: shortName(r.name),
        population: r.population,
      });
    }
  }
  const seen = new Set<string>();
  for (const c of out) {
    const key = `${c.kind}:${c.geoid}`;
    if (seen.has(key)) throw new Error(`population estimates list ${c.kind} ${c.geoid} (${c.censusName}) twice`);
    seen.add(key);
  }
  return out.sort(compareCatalog);
}

export interface ExistingCityArea {
  id: string;
  geoid: string;
  kind: 'place' | 'cousub';
}

/**
 * Area id per catalog city, in the given (biggest-first) order. A city that already has a whole-city area keeps
 * its id (los_angeles_ca, austin_tx_city, ...). A new city gets "<name slug>_<state>"; when that is taken (e.g.
 * edison_nj, a pilot area) it gets "_city" appended, and failing that its GEOID. Ids never repeat.
 */
export function assignAreaIds<T extends CatalogCandidate>(
  cands: T[],
  existing: readonly ExistingCityArea[],
  reserved: Iterable<string>,
): (T & { areaId: string })[] {
  const existingByKey = new Map(existing.map((e) => [`${e.kind}:${e.geoid}`, e.id] as const));
  const taken = new Set<string>([...reserved, ...existing.map((e) => e.id)]);
  const out = cands.map((c) => {
    const id = existingByKey.get(`${c.kind}:${c.geoid}`);
    return { ...c, areaId: id ?? '' };
  });
  for (const c of out) {
    if (c.areaId) continue;
    const base = `${slugify(c.name)}_${c.state.toLowerCase()}`;
    const id = [base, `${base}_city`, `${base}_${c.geoid}`].find((x) => !taken.has(x));
    if (!id) throw new Error(`no free area id for ${c.censusName} ${c.state} (${c.geoid})`);
    c.areaId = id;
    taken.add(id);
  }
  const ids = out.map((c) => c.areaId);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) throw new Error(`duplicate catalog area id(s): ${[...new Set(dupes)].join(', ')}`);
  return out;
}

/**
 * Weighted centre of ZCTA internal points (weight = the ZCTA's share of the city's land); the plain mean when no
 * weight is known. Rounded to 5 decimals (~1 m).
 */
export function weightedCentre(
  zctas: readonly { zcta: string; lat: number; lng: number }[],
  weights: ReadonlyMap<string, number> | undefined,
): { lat: number; lng: number } {
  let w = 0;
  let lat = 0;
  let lng = 0;
  for (const z of zctas) {
    const k = weights?.get(z.zcta) ?? 0;
    w += k;
    lat += k * z.lat;
    lng += k * z.lng;
  }
  if (!(w > 0)) {
    if (zctas.length === 0) throw new Error('no ZCTA to take a centre from');
    w = zctas.length;
    lat = zctas.reduce((s, z) => s + z.lat, 0);
    lng = zctas.reduce((s, z) => s + z.lng, 0);
  }
  const r5 = (x: number) => Math.round(x * 100_000) / 100_000;
  return { lat: r5(lat / w), lng: r5(lng / w) };
}
