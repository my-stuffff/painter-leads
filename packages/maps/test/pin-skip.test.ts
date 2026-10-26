import { getArea, type AreaDef } from '@pp/core';
import { describe, expect, it } from 'vitest';
import { areaZips, createPinSkipper, distanceToShapesKm, loadZctaShapes, PIN_SKIP_KM, type ZctaShape } from '../src/pin-skip';
import { testConfig } from './helpers';

/** A 0.1° x 0.1° square (about 8.5 km x 11 km at 40°N) with its south-west corner at (lat, lng). */
const square = (zcta: string, lat: number, lng: number): ZctaShape => ({
  zcta,
  polygons: [
    [
      [
        [lng, lat],
        [lng + 0.1, lat],
        [lng + 0.1, lat + 0.1],
        [lng, lat + 0.1],
        [lng, lat],
      ],
    ],
  ],
});

const area = (over: Partial<AreaDef> = {}): AreaDef => ({
  id: 'edison_nj',
  label: 'Test area',
  state: 'NJ',
  city: 'Edison',
  censusKind: 'cousub',
  geoid: '0',
  allZctas: [{ zcta: '11111', share: 1, lat: 40.05, lng: -74.95 }],
  pilotZctas: ['11111'],
  expansionZctas: [],
  poBoxZips: [],
  ...over,
});

describe('distanceToShapesKm', () => {
  const shapes = [square('11111', 40, -75)];

  it('is 0 for a point inside the polygon', () => {
    expect(distanceToShapesKm(shapes, new Set(['11111']), 40.05, -74.95)).toBe(0);
  });

  it('measures the straight distance to the nearest edge for a point outside', () => {
    // 0.05° of latitude north of the top edge = about 5.56 km.
    const km = distanceToShapesKm(shapes, new Set(['11111']), 40.15, -74.95);
    expect(km).toBeGreaterThan(5.4);
    expect(km).toBeLessThan(5.7);
  });

  it('measures to the nearest corner when the point is diagonal to the polygon', () => {
    // 0.05° north and 0.05° east of the north-east corner: sqrt(5.56² + 4.25²) = about 7.0 km.
    const km = distanceToShapesKm(shapes, new Set(['11111']), 40.15, -74.85);
    expect(km).toBeGreaterThan(6.8);
    expect(km).toBeLessThan(7.2);
  });

  it('treats a hole in a polygon as outside it', () => {
    const donut: ZctaShape = {
      zcta: '22222',
      polygons: [
        [
          [
            [-75, 40],
            [-74.9, 40],
            [-74.9, 40.1],
            [-75, 40.1],
            [-75, 40],
          ],
          [
            [-74.96, 40.04],
            [-74.94, 40.04],
            [-74.94, 40.06],
            [-74.96, 40.06],
            [-74.96, 40.04],
          ],
        ],
      ],
    };
    const km = distanceToShapesKm([donut], new Set(['22222']), 40.05, -74.95);
    expect(km).toBeGreaterThan(0.8);
    expect(km).toBeLessThan(1.2);
  });

  it('looks only at the wanted ZIPs and returns null when none has a polygon', () => {
    expect(distanceToShapesKm(shapes, new Set(['99999']), 40.05, -74.95)).toBeNull();
    const two = [square('11111', 40, -75), square('33333', 45, -75)];
    expect(distanceToShapesKm(two, new Set(['11111']), 45.05, -74.95)).toBeGreaterThan(500);
  });
});

describe('createPinSkipper', () => {
  const shapes = [square('11111', 40, -75), square('44444', 40, -74.6)];

  it('returns the distance for a pin farther than the threshold from every area polygon', () => {
    const skip = createPinSkipper(area(), shapes);
    const km = skip(41, -73);
    expect(km).not.toBeNull();
    expect(km as number).toBeGreaterThan(PIN_SKIP_KM);
  });

  it('returns null for a pin inside the area', () => {
    expect(createPinSkipper(area(), shapes)(40.05, -74.95)).toBeNull();
  });

  it('returns null for a pin outside the polygon but inside the threshold', () => {
    // 0.02° north of the top edge = about 2.2 km, under the threshold.
    expect(createPinSkipper(area(), shapes)(40.12, -74.95)).toBeNull();
  });

  it('counts expansion ZIPs as area', () => {
    // The pin lies inside 44444, 0.4° east of the pilot square (about 34 km).
    const pin: [number, number] = [40.05, -74.55];
    expect(createPinSkipper(area(), shapes)(...pin)).not.toBeNull();
    expect(createPinSkipper(area({ expansionZctas: ['44444'] }), shapes)(...pin)).toBeNull();
  });

  it('never skips when the area has no polygon at all', () => {
    expect(createPinSkipper(area({ allZctas: [{ zcta: '00000', share: 1, lat: 0, lng: 0 }] }), shapes)(41, -73)).toBeNull();
  });

  it('honours a custom threshold', () => {
    expect(createPinSkipper(area(), shapes, 1)(40.12, -74.95)).not.toBeNull();
  });
});

describe('real pilot geometry', () => {
  const shapes = loadZctaShapes();
  const cfg = testConfig();

  it('has a polygon for every ZIP of every pilot area, expansion included', () => {
    const have = new Set(shapes.map((s) => s.zcta));
    for (const id of ['edison_nj', 'austin_tx', 'san_diego_ca']) {
      const a = getArea(cfg, id);
      expect(areaZips(a).filter((z) => !have.has(z))).toEqual([]);
    }
  });

  it('puts an Edison ZIP centroid in the area and downtown San Diego far outside Edison', () => {
    const edison = getArea(cfg, 'edison_nj');
    const skip = createPinSkipper(edison, shapes);
    const c = edison.allZctas[0];
    expect(c).toBeDefined();
    expect(skip(c?.lat ?? 0, c?.lng ?? 0)).toBeNull();
    expect(skip(32.7157, -117.1611)).toBeGreaterThan(3000);
  });
});
