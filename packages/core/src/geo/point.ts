import { readFileSync } from 'node:fs';
import path from 'node:path';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { REPO_ROOT } from '../paths';

interface ZctaFeature {
  type: 'Feature';
  properties: { ZCTA5: string };
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
}

interface Indexed {
  zcta: string;
  bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
  feature: ZctaFeature;
}

let index: Indexed[] | null = null;

export const ZCTA_GEOJSON_PATH = path.join(REPO_ROOT, 'data', 'geo', 'pilot-zcta.geojson');

function bboxOf(coords: unknown): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [x, y] = c as [number, number];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    } else if (Array.isArray(c)) {
      for (const inner of c) walk(inner);
    }
  };
  walk(coords);
  return [minX, minY, maxX, maxY];
}

function load(): Indexed[] {
  if (!index) {
    const fc = JSON.parse(readFileSync(ZCTA_GEOJSON_PATH, 'utf8')) as { features: ZctaFeature[] };
    index = fc.features.map((feature) => ({
      zcta: feature.properties.ZCTA5,
      bbox: bboxOf(feature.geometry.coordinates),
      feature,
    }));
  }
  return index;
}

/** The ZCTA containing the point (bbox prefilter, then point-in-polygon), or null. GeoJSON order is [lng, lat]. */
export function zctaForPoint(lat: number, lng: number): string | null {
  for (const item of load()) {
    const [minX, minY, maxX, maxY] = item.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    if (booleanPointInPolygon([lng, lat], item.feature as never)) return item.zcta;
  }
  return null;
}
