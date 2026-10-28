import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load';
import { CATALOG_PATH, catalogFilePath, loadAreas, loadCatalog } from '../src/geo';
import { areasFilePath } from '../src/geo/areas';
import {
  CITY_SPECS,
  areaLandSharesByGeoid,
  checkCityGeoids,
  cityArea,
  cityRingZctas,
  namesByGeoid,
  parseGazetteer,
  sharesByGeoid,
} from '../src/geo/build';
import {
  CATALOG_COUSUB_STATES,
  CATALOG_MIN_POPULATION,
  CATALOG_STATES,
  POPEST_URL,
  assignAreaIds,
  compareCatalog,
  parsePopEstimates,
  selectCatalogCities,
  shortName,
  slugify,
  weightedCentre,
  type CatalogCandidate,
} from '../src/geo/popest';

// Rows cut unchanged from the Census files: sub-est2024.csv (Vintage 2024 sub-county estimates, Latin-1), the 2020
// ZCTA-to-place (Davis CA) and ZCTA-to-county-subdivision (Woodbridge NJ) relationship files, the 2025 Gazetteer.
const FIX = path.join(__dirname, 'fixtures', 'geo');
const pipe = (file: string) =>
  parse(readFileSync(path.join(FIX, file)), { delimiter: '|', bom: true, columns: true, skip_empty_lines: true }) as Record<string, string>[];
const popRows = parsePopEstimates(readFileSync(path.join(FIX, 'sub-est2024-sample.csv')));
const OPTS = { minPopulation: CATALOG_MIN_POPULATION, states: CATALOG_STATES, cousubStates: CATALOG_COUSUB_STATES };
const EXISTING = CITY_SPECS.map((c) => ({ id: c.id, geoid: c.geoid, kind: 'place' as const }));
const PILOT_IDS = ['edison_nj', 'austin_tx', 'san_diego_ca'];

describe('population estimates file', () => {
  it('reads the Vintage 2024 columns and decodes Latin-1 names', () => {
    expect(popRows).toHaveLength(24);
    expect(popRows.find((r) => r.place === '44000' && r.sumlev === '162')).toEqual({
      sumlev: '162', state: '06', county: '000', place: '44000', cousub: '00000', name: 'Los Angeles city', population: 3878704,
    });
    expect(popRows.some((r) => r.name === 'La Cañada Flintridge city')).toBe(true);
  });

  it('fails when the population column is missing (a different vintage or layout)', () => {
    expect(() => parsePopEstimates(readFileSync(path.join(FIX, 'sub-est2024-sample.csv')), 2025)).toThrow(/POPESTIMATE2025/);
    expect(() => parsePopEstimates(Buffer.from('SUMLEV,STATE,NAME\n162,06,X city\n'))).toThrow(/COUNTY, PLACE, COUSUB, POPESTIMATE2024/);
  });
});

describe('catalog selection', () => {
  const picked = selectCatalogCities(popRows, OPTS);
  const keys = picked.map((c) => `${c.state} ${c.kind} ${c.geoid} ${c.censusName} ${c.population}`);

  it('takes places >= 50,000 in CA, TX, NJ and NJ townships that are not places, biggest first', () => {
    expect(keys).toEqual([
      'CA place 0644000 Los Angeles city 3878704',
      'CA place 0666000 San Diego city 1404452',
      'TX place 4805000 Austin city 993588',
      'NJ place 3451000 Newark city 317303',
      'CA place 0669000 Santa Ana city 316184',
      'NJ cousub 3402320230 Edison township 110002',
      'NJ cousub 3402382000 Woodbridge township 106101',
      'NJ place 3474630 Union City city 66918',
      'TX place 4867496 Sherman city 50229',
      'NJ cousub 3402347280 Monroe township 50157',
      'CA place 0630014 Glendora city 50101',
    ]);
  });

  it('threshold: >= minPopulation is in, one person short is out', () => {
    expect(keys.some((k) => k.includes('Ceres city'))).toBe(false); // 49,253
    expect(keys.some((k) => k.includes('Cedar Hill city'))).toBe(false); // 49,618
    expect(keys.some((k) => k.includes('West Orange township'))).toBe(false); // 49,211
    const glendora = popRows.filter((r) => r.name === 'Glendora city');
    expect(selectCatalogCities(glendora, { ...OPTS, minPopulation: 50_101 })).toHaveLength(1);
    expect(selectCatalogCities(glendora, { ...OPTS, minPopulation: 50_102 })).toHaveLength(0);
  });

  it('ignores state, county, place-in-county (157) and place-in-subdivision (071) rows', () => {
    expect(picked.filter((c) => c.censusName === 'Los Angeles city')).toHaveLength(1);
    expect(picked.filter((c) => c.censusName === 'Newark city')).toHaveLength(1);
    expect(picked.some((c) => c.censusName === 'California' || c.censusName.endsWith('County'))).toBe(false);
  });

  it('a NJ city listed as place and county subdivision under the same code is the place only', () => {
    expect(picked.find((c) => c.censusName === 'Newark city')).toMatchObject({ kind: 'place', geoid: '3451000' });
    expect(picked.find((c) => c.censusName === 'Union City city')).toMatchObject({ kind: 'place', geoid: '3474630' });
    // The same code as a place in ANOTHER state does not drop a NJ township.
    const nj = popRows.filter((r) => r.name === 'Edison township');
    const otherStatePlace = { ...nj[0]!, sumlev: '162', state: '36', county: '000', place: '20230', cousub: '00000', name: 'X city' };
    expect(selectCatalogCities([...nj, otherStatePlace], OPTS).map((c) => c.censusName)).toEqual(['Edison township']);
  });

  it('state filter: New York places and towns are out; county subdivisions only count in NJ', () => {
    expect(keys.some((k) => /New York city|Hempstead/.test(k))).toBe(false);
    const ny = popRows.filter((r) => r.state === '36');
    expect(selectCatalogCities(ny, { ...OPTS, states: [...CATALOG_STATES] })).toEqual([]);
    const txTownship = { sumlev: '061', state: '48', county: '201', place: '00000', cousub: '90000', name: 'Some CCD', population: 900_000 };
    expect(selectCatalogCities([txTownship], OPTS)).toEqual([]);
    expect(selectCatalogCities([txTownship], { ...OPTS, cousubStates: ['TX'] })).toHaveLength(1);
  });

  it('sorts by population, ties by name then GEOID', () => {
    const c = (name: string, population: number, geoid: string) => ({ name, population, geoid });
    const list = [c('B', 10, '2'), c('A', 10, '3'), c('C', 99, '1'), c('A', 10, '1')].sort(compareCatalog);
    expect(list.map((x) => `${x.name}${x.geoid}`)).toEqual(['C1', 'A1', 'A3', 'B2']);
  });
});

describe('catalog area ids', () => {
  const withIds = assignAreaIds(selectCatalogCities(popRows, OPTS), EXISTING, PILOT_IDS);
  const idOf = (censusName: string) => withIds.find((c) => c.censusName === censusName)?.areaId;

  it('reuses the existing whole-city ids, including the _city ids of Austin and San Diego', () => {
    expect(idOf('Los Angeles city')).toBe('los_angeles_ca');
    expect(idOf('Austin city')).toBe('austin_tx_city');
    expect(idOf('San Diego city')).toBe('san_diego_ca_city');
    expect(idOf('Newark city')).toBe('newark_nj');
  });

  it('new ids are <name>_<state>, with _city when a pilot id has it', () => {
    expect(idOf('Santa Ana city')).toBe('santa_ana_ca');
    expect(idOf('Woodbridge township')).toBe('woodbridge_nj');
    expect(idOf('Union City city')).toBe('union_city_nj');
    expect(idOf('Edison township')).toBe('edison_nj_city');
    const ids = withIds.map((c) => c.areaId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of PILOT_IDS) expect(ids).not.toContain(id);
  });

  it('never repeats an id: same-name cities get _city, then their GEOID', () => {
    const cand = (geoid: string, population: number): CatalogCandidate => ({
      state: 'NJ', kind: 'cousub', geoid, censusName: 'Hamilton township', name: 'Hamilton', population,
    });
    const out = assignAreaIds([cand('3402129310', 93_911), cand('3400129430', 60_000), cand('3400199999', 55_000)], [], []);
    expect(out.map((c) => c.areaId)).toEqual(['hamilton_nj', 'hamilton_nj_city', 'hamilton_nj_3400199999']);
    // An id already used by an existing area is never handed to a new city.
    expect(assignAreaIds([cand('3400199999', 1)], [{ id: 'hamilton_nj', geoid: '3402129310', kind: 'cousub' }], [])[0]!.areaId).toBe('hamilton_nj_city');
  });

  it('names and slugs', () => {
    expect(shortName('Union City city')).toBe('Union City');
    expect(shortName('West New York town')).toBe('West New York');
    expect(shortName('Parsippany-Troy Hills township')).toBe('Parsippany-Troy Hills');
    expect(slugify('Parsippany-Troy Hills')).toBe('parsippany_troy_hills');
    expect(slugify('San Buenaventura (Ventura)')).toBe('san_buenaventura_ventura');
    expect(slugify('La Cañada Flintridge')).toBe('la_canada_flintridge');
  });
});

describe('catalog city areas (fixtures)', () => {
  const gaz = parseGazetteer(readFileSync(path.join(FIX, 'gaz-davis-woodbridge.txt')));

  it('a NJ township is a county-subdivision area built by the share rule', () => {
    const rows = pipe('cousub-rel-woodbridge.txt');
    const wanted = new Set(['3402382000']);
    const spec = { id: 'woodbridge_nj', state: 'NJ' as const, city: 'Woodbridge', geoid: '3402382000', censusName: 'Woodbridge township', censusKind: 'cousub' as const };
    expect(() => checkCityGeoids([spec], namesByGeoid(rows, 'GEOID_COUSUB_20', 'NAMELSAD_COUSUB_20', wanted))).not.toThrow();
    expect(() => checkCityGeoids([{ ...spec, censusName: 'Woodbridge city' }], namesByGeoid(rows, 'GEOID_COUSUB_20', 'NAMELSAD_COUSUB_20', wanted))).toThrow(
      /woodbridge_nj: GEOID 3402382000 is "Woodbridge township", expected "Woodbridge city"/,
    );
    const shares = sharesByGeoid(rows, 'GEOID_COUSUB_20', wanted).get('3402382000')!;
    const land = areaLandSharesByGeoid(rows, 'GEOID_COUSUB_20', 'AREALAND_COUSUB_20', wanted).get('3402382000')!;
    const area = cityArea(spec, shares, gaz, 0.2, land);
    expect(area).toMatchObject({ id: 'woodbridge_nj', kind: 'city', label: 'Woodbridge township, NJ', censusKind: 'cousub', city: 'Woodbridge' });
    expect(area.pilotZctas).toEqual(['07001', '07064', '07067', '07077', '07095', '08830', '08832', '08863']);
    expect(area.zctaRule).toBeUndefined();
    expect(cityRingZctas(shares, 0.2, area.pilotZctas)).toEqual(['07008', '08837', '08840', '08861']);
  });

  it('a small city inside large rural ZIPs falls back to the ZIPs holding >= 20% of its own land', () => {
    const rows = pipe('place-rel-davis.txt');
    const wanted = new Set(['0618100']);
    const spec = { id: 'davis_ca', state: 'CA' as const, city: 'Davis', geoid: '0618100', censusName: 'Davis city' };
    const shares = sharesByGeoid(rows, 'GEOID_PLACE_20', wanted).get('0618100')!;
    const land = areaLandSharesByGeoid(rows, 'GEOID_PLACE_20', 'AREALAND_PLACE_20', wanted).get('0618100')!;
    // 95616 has 18% of its land in Davis, 95618 14%: neither reaches 0.2, but they hold 55% and 45% of the city.
    expect(land.get('95616')).toBeCloseTo(14122563 / 25826324, 9);
    expect(() => cityArea(spec, shares, gaz, 0.2)).toThrow(/no ZCTA of davis_ca \(0618100\) reaches share 0.2/);
    const area = cityArea(spec, shares, gaz, 0.2, land);
    expect(area.zctaRule).toBe('city-land');
    expect(area.pilotZctas).toEqual(['95616', '95618']);
    expect(area.allZctas.map((z) => z.share)).toEqual([0.1826, 0.1406]);
    // Zero ZCTAs even by the city's land fails the build.
    expect(() => cityArea(spec, shares, gaz, 0.6, land)).toThrow(/no ZCTA of davis_ca .* of its own land or of the city land/);
    // Centre: internal points weighted by the city's land.
    const centre = weightedCentre(area.allZctas, land);
    const w = 14122563 / 25826324;
    expect(centre.lat).toBeCloseTo(w * 38.554147 + (1 - w) * 38.543019, 5);
    expect(centre.lng).toBeCloseTo(w * -121.798514 + (1 - w) * -121.690538, 5);
    expect(weightedCentre([{ zcta: 'a', lat: 1, lng: 3 }, { zcta: 'b', lat: 2, lng: 5 }], undefined)).toEqual({ lat: 1.5, lng: 4 });
  });
});

describe('committed catalog (data/geo/catalog.json)', () => {
  const config = loadConfig();
  const catalog = loadCatalog(config);
  const areas = loadAreas(config);
  const byId = new Map(areas.map((a) => [a.id, a] as const));
  const city = (id: string) => catalog.cities.find((c) => c.areaId === id);

  it('lives next to the areas file and names its sources', () => {
    expect(catalogFilePath(config)).toBe(path.join(path.dirname(areasFilePath(config)), 'catalog.json'));
    expect(catalogFilePath(config)).toBe(CATALOG_PATH);
    expect(catalog).toMatchObject({ minPopulation: 50_000, popYear: 2024 });
    expect(catalog.sources).toContain(POPEST_URL);
  });

  it('holds 292 cities >= 50,000 (CA 178, TX 75, NJ 39), biggest first', () => {
    const n = (s: string) => catalog.cities.filter((c) => c.state === s).length;
    expect([catalog.cities.length, n('CA'), n('TX'), n('NJ')]).toEqual([292, 178, 75, 39]);
    expect(catalog.cities.filter((c) => c.kind === 'cousub').every((c) => c.state === 'NJ')).toBe(true);
    for (let i = 1; i < catalog.cities.length; i++) expect(compareCatalog(catalog.cities[i - 1]!, catalog.cities[i]!)).toBeLessThan(0);
    expect(catalog.cities.every((c) => c.population >= 50_000 && c.popYear === 2024)).toBe(true);
  });

  it('points every city at its own whole-city area, zipCount = ZIPs searched', () => {
    const ids = catalog.cities.map((c) => c.areaId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of catalog.cities) {
      const a = byId.get(c.areaId);
      expect(a, c.areaId).toBeDefined();
      expect([a!.kind, a!.geoid, a!.censusKind, a!.state, a!.city], c.areaId).toEqual(['city', c.geoid, c.kind, c.state, c.name]);
      expect(c.zipCount, c.areaId).toBe(a!.pilotZctas.length);
      expect(c.zipCount, c.areaId).toBeGreaterThan(0);
    }
    expect([city('los_angeles_ca')?.zipCount, city('houston_tx')?.zipCount, city('san_antonio_tx')?.zipCount, city('newark_nj')?.zipCount]).toEqual([116, 92, 51, 9]);
    expect(city('austin_tx_city')?.name).toBe('Austin');
    expect(city('san_diego_ca_city')?.name).toBe('San Diego');
    expect(city('edison_nj_city')).toMatchObject({ kind: 'cousub', geoid: '3402320230', censusName: 'Edison township' });
    for (const id of ['edison_nj', 'austin_tx', 'san_diego_ca']) expect(city(id)).toBeUndefined();
    for (const spec of CITY_SPECS) expect(city(spec.id)?.geoid, spec.id).toBe(spec.geoid);
  });

  it('keeps the 27 existing areas first, then the new cities biggest first; no duplicate ids', () => {
    const ids = areas.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 27)).toEqual([...PILOT_IDS, ...CITY_SPECS.map((c) => c.id)]);
    const existing = new Set(ids.slice(0, 27));
    expect(ids.slice(27)).toEqual(catalog.cities.map((c) => c.areaId).filter((id) => !existing.has(id)));
  });

  it('centres fall inside their state', () => {
    const box = { CA: [32.5, 42, -124.5, -114.1], TX: [25.8, 36.5, -106.7, -93.5], NJ: [38.9, 41.4, -75.6, -73.9] } as const;
    for (const c of catalog.cities) {
      const [s, n, w, e] = box[c.state];
      expect(c.lat >= s && c.lat <= n && c.lng >= w && c.lng <= e, `${c.areaId} ${c.lat},${c.lng}`).toBe(true);
    }
  });

  it('the city-land rule is used only where no ZCTA reaches zctaMinShare', () => {
    const fallback = areas.filter((a) => a.zctaRule === 'city-land');
    expect(fallback.map((a) => a.id)).toContain('davis_ca');
    expect(fallback).toHaveLength(17);
    for (const a of fallback) expect(a.allZctas.every((z) => z.share < config.search.zctaMinShare), a.id).toBe(true);
    for (const a of areas.filter((x) => x.zctaRule !== 'city-land')) {
      expect(a.allZctas.every((z) => z.share >= config.search.zctaMinShare), a.id).toBe(true);
    }
  });
});
