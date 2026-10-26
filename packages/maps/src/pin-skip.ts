import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, type AreaDef } from '@pp/core';

/**
 * A listing whose search-card map pin lies farther than this from every ZIP polygon of the run's area is not
 * opened (no place page). Chosen from run 8 / run 9 data, see the fix-skipfar report.
 */
export const PIN_SKIP_KM = 5;

/** One ring is a list of [lng, lat] points; the first ring of a polygon is its outline, the rest are holes. */
type Ring = number[][];
type Polygon = Ring[];

export interface ZctaShape {
  zcta: string;
  polygons: Polygon[];
}

export const ZCTA_SHAPES_PATH = path.join(REPO_ROOT, 'data', 'geo', 'pilot-zcta.geojson');

const EARTH_KM_PER_DEGREE = 111.195;

let cached: ZctaShape[] | null = null;

/** The ZCTA polygons of data/geo/pilot-zcta.geojson (read once). */
export function loadZctaShapes(file: string = ZCTA_SHAPES_PATH): ZctaShape[] {
  if (file === ZCTA_SHAPES_PATH && cached) return cached;
  const fc = JSON.parse(readFileSync(file, 'utf8')) as {
    features: { properties: { ZCTA5: string }; geometry: { type: string; coordinates: unknown } }[];
  };
  const shapes = fc.features.map((f) => ({
    zcta: f.properties.ZCTA5,
    polygons: f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as Polygon[]) : [f.geometry.coordinates as Polygon],
  }));
  if (file === ZCTA_SHAPES_PATH) cached = shapes;
  return shapes;
}

/** Every ZIP that counts as the area for the skip: its ZCTAs plus the expansion ZCTAs (PO-box ZIPs have no polygon). */
export function areaZips(area: AreaDef): string[] {
  return [...area.allZctas.map((z) => z.zcta), ...area.expansionZctas];
}

function inRing(ring: Ring, lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as number[];
    const b = ring[j] as number[];
    const [xi, yi] = [a[0] as number, a[1] as number];
    const [xj, yj] = [b[0] as number, b[1] as number];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(polygon: Polygon, lng: number, lat: number): boolean {
  const [outline, ...holes] = polygon;
  if (!outline || !inRing(outline, lng, lat)) return false;
  return !holes.some((h) => inRing(h, lng, lat));
}

/** Distance in km from the point to the nearest edge of the ring, on a flat plane centred on the point. */
function ringDistanceKm(ring: Ring, lng: number, lat: number): number {
  const kx = EARTH_KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
  const ky = EARTH_KM_PER_DEGREE;
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1] as number[];
    const b = ring[i] as number[];
    const ax = ((a[0] as number) - lng) * kx;
    const ay = ((a[1] as number) - lat) * ky;
    const bx = ((b[0] as number) - lng) * kx;
    const by = ((b[1] as number) - lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Distance in km from the pin to the nearest polygon of the wanted ZIPs: 0 inside one, else the distance to the
 * nearest edge. null when none of the wanted ZIPs has a polygon.
 */
export function distanceToShapesKm(shapes: ZctaShape[], zips: ReadonlySet<string>, lat: number, lng: number): number | null {
  let best: number | null = null;
  for (const shape of shapes) {
    if (!zips.has(shape.zcta)) continue;
    for (const polygon of shape.polygons) {
      if (inPolygon(polygon, lng, lat)) return 0;
      for (const ring of polygon) {
        const d = ringDistanceKm(ring, lng, lat);
        if (best === null || d < best) best = d;
      }
    }
  }
  return best;
}

/** Km to the area for the pin, or null when the area has no polygon to measure against. */
export function distanceToAreaKm(area: AreaDef, lat: number, lng: number, shapes: ZctaShape[] = loadZctaShapes()): number | null {
  return distanceToShapesKm(shapes, new Set(areaZips(area)), lat, lng);
}

/**
 * Returns a function that gives the pin's distance in km when the pin is farther than `thresholdKm` from every
 * polygon of the area (the listing is clearly outside), else null (open the place page).
 */
export function createPinSkipper(
  area: AreaDef,
  shapes: ZctaShape[] = loadZctaShapes(),
  thresholdKm: number = PIN_SKIP_KM,
): (lat: number, lng: number) => number | null {
  const zips = new Set(areaZips(area));
  return (lat, lng) => {
    const km = distanceToShapesKm(shapes, zips, lat, lng);
    return km !== null && km > thresholdKm ? km : null;
  };
}
