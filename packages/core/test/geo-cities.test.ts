import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load';
import { getArea, loadAreas, zctaForPoint } from '../src/geo';
import {
  CITY_SPECS,
  checkCityGeoids,
  cityArea,
  cityRingZctas,
  namesByGeoid,
  parseGazetteer,
  sharesByGeoid,
} from '../src/geo/build';
import { ZCTA_GEOJSON_PATH } from '../src/geo/point';

// Rows cut unchanged from the Census 2020 ZCTA-to-place relationship file and the 2025 ZCTA Gazetteer
// (Elizabeth NJ 3421000 and Plano TX 4858016 only).
const FIX = path.join(__dirname, 'fixtures', 'geo');
const placeRows = parse(readFileSync(path.join(FIX, 'place-rel-elizabeth-plano.txt')), {
  delimiter: '|',
  bom: true,
  columns: true,
  skip_empty_lines: true,
}) as Record<string, string>[];
const gaz = parseGazetteer(readFileSync(path.join(FIX, 'gaz-elizabeth-plano.txt')));
const spec = (id: string) => CITY_SPECS.find((c) => c.id === id)!;
const shares = sharesByGeoid(placeRows, 'GEOID_PLACE_20', new Set(['3421000', '4858016']));

const OWNER_ORDER = [
  'los_angeles_ca', 'houston_tx', 'san_antonio_tx', 'san_diego_ca_city', 'dallas_tx', 'san_jose_ca', 'austin_tx_city',
  'fort_worth_tx', 'san_francisco_ca', 'el_paso_tx', 'fresno_ca', 'sacramento_ca', 'long_beach_ca', 'oakland_ca',
  'bakersfield_ca', 'arlington_tx', 'anaheim_ca', 'corpus_christi_tx', 'newark_nj', 'plano_tx', 'jersey_city_nj',
  'lubbock_tx', 'paterson_nj', 'elizabeth_nj',
];

describe('whole-city selection (fixtures)', () => {
  it('checks each city GEOID against its Census place name', () => {
    const names = namesByGeoid(placeRows, 'GEOID_PLACE_20', 'NAMELSAD_PLACE_20', new Set(['3421000', '4858016']));
    expect(names.get('3421000')).toBe('Elizabeth city');
    expect(() => checkCityGeoids([spec('elizabeth_nj'), spec('plano_tx')], names)).not.toThrow();
    expect(() => checkCityGeoids([{ ...spec('plano_tx'), geoid: '3421000' }], names)).toThrow(/plano_tx: GEOID 3421000 is "Elizabeth city"/);
    expect(() => checkCityGeoids([spec('newark_nj')], names)).toThrow(/newark_nj: GEOID 3451000 is "missing"/);
  });

  it('searches every ZCTA at share >= zctaMinShare and nothing below it', () => {
    const plano = cityArea(spec('plano_tx'), shares.get('4858016')!, gaz, 0.2);
    expect(plano).toMatchObject({ id: 'plano_tx', kind: 'city', label: 'Plano city, TX', state: 'TX', city: 'Plano', censusKind: 'place', geoid: '4858016' });
    expect(plano.pilotZctas).toEqual(['75023', '75024', '75025', '75074', '75075', '75093']);
    expect(plano.allZctas.map((z) => z.zcta).sort()).toEqual(plano.pilotZctas);
    expect(plano.allZctas[0]).toEqual({ zcta: '75023', share: 1, lat: 33.056789, lng: -96.730859 });
    expect(plano.expansionZctas).toEqual([]);
    expect(plano.poBoxZips).toEqual([]);
    // 75094 (0.09) and the slivers (75010 is under 0.0001) are only the neighbour ring.
    expect(cityRingZctas(shares.get('4858016')!, 0.2)).toEqual(['75002', '75010', '75013', '75056', '75082', '75094', '75252', '75287']);
    expect(cityArea(spec('plano_tx'), shares.get('4858016')!, gaz, 0.05).pilotZctas).toContain('75094');
  });

  it('a city fully covered by its ZCTAs searches all of them', () => {
    const elizabeth = cityArea(spec('elizabeth_nj'), shares.get('3421000')!, gaz, 0.2);
    expect(elizabeth.pilotZctas).toEqual(['07201', '07202', '07206', '07208']);
    expect(elizabeth.label).toBe('Elizabeth city, NJ');
  });

  it('fails loudly when a ZCTA has no Gazetteer centre', () => {
    expect(() => cityArea(spec('plano_tx'), new Map([['99999', 1]]), gaz, 0.2)).toThrow(/99999 is missing from the Gazetteer/);
  });

  it('city ids are unique, in the owner order, and never reuse a pilot id', () => {
    expect(CITY_SPECS.map((c) => c.id)).toEqual(OWNER_ORDER);
    for (const id of ['edison_nj', 'austin_tx', 'san_diego_ca']) expect(CITY_SPECS.some((c) => c.id === id)).toBe(false);
  });
});

describe('committed whole-city areas', () => {
  const config = loadConfig();
  const areas = loadAreas(config);
  const polygons = new Set(
    (JSON.parse(readFileSync(ZCTA_GEOJSON_PATH, 'utf8')) as { features: { properties: { ZCTA5: string } }[] }).features.map(
      (f) => f.properties.ZCTA5,
    ),
  );
  const cities = areas.filter((a) => a.kind === 'city');

  it('keeps the three pilots first and unchanged, then the cities in the owner order', () => {
    expect(areas.slice(0, 3).map((a) => [a.id, a.kind, a.pilotZctas.length])).toEqual([
      ['edison_nj', undefined, 3],
      ['austin_tx', undefined, 12],
      ['san_diego_ca', undefined, 12],
    ]);
    // The catalog's new cities (geo-catalog.test.ts) follow the 24 in the owner order.
    expect(cities.slice(0, OWNER_ORDER.length).map((a) => a.id)).toEqual(OWNER_ORDER);
    // Owner ruling 01-06 survives a rebuild: La Jolla 92037 in place of the campus ZIP 92092.
    expect(getArea(config, 'san_diego_ca').pilotZctas[3]).toBe('92037');
    expect(getArea(config, 'san_diego_ca').pilotZctas).not.toContain('92092');
    expect(getArea(config, 'los_angeles_ca').city).toBe('Los Angeles');
  });

  it('searches every area ZCTA of each city, each with a polygon and a centre inside it', () => {
    for (const a of cities) {
      expect(a.pilotZctas, a.id).toEqual(a.allZctas.map((z) => z.zcta).sort());
      if (a.zctaRule !== 'city-land') expect(a.allZctas.every((z) => z.share >= config.search.zctaMinShare), a.id).toBe(true);
      for (const z of a.allZctas) {
        expect(polygons.has(z.zcta), `${a.id} ${z.zcta} polygon`).toBe(true);
        expect(zctaForPoint(z.lat, z.lng), `${a.id} ${z.zcta} centre`).toBe(z.zcta);
      }
    }
    const austin = getArea(config, 'austin_tx_city');
    expect(austin.allZctas).toEqual(getArea(config, 'austin_tx').allZctas);
    expect(getArea(config, 'los_angeles_ca').pilotZctas).toHaveLength(116);
  });
});
