import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { parse } from 'csv-parse/sync';
import type { PpConfig } from '../config/schema';
import type { Fetcher } from '../fetch/types';
import { dataDir } from '../paths';
import type { AreaDef, AreaZcta } from './areas';

export const CENSUS_URLS = {
  zctaPlace: 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_place20_natl.txt',
  zctaCousub: 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_cousub20_natl.txt',
  gazetteer: 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip',
  tigerweb:
    'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/7/query',
} as const;

/** Local file names accepted in --input-dir. */
export const INPUT_NAMES = {
  zctaPlace: ['rel.txt', 'tab20_zcta520_place20_natl.txt'],
  zctaCousub: ['cousub.txt', 'tab20_zcta520_cousub20_natl.txt'],
  gazetteer: ['2025_Gaz_zcta_national.txt', 'gaz.zip', '2025_Gaz_zcta_national.zip'],
  polygons: ['pilot-zcta.geojson', 'zcta.geojson'],
} as const;

// Derivation constants fixed by the plan (D-08, D-09 amendment).
export const PILOT_CANDIDATE_MIN_SHARE = 0.5;
export const PILOT_ZIPS_PER_BIG_CITY = 12;
export const EDISON_PILOT = ['08817', '08820', '08837'];
export const WOODBRIDGE_MIN_SHARE = 0.98;
export const METUCHEN_MIN_SHARE = 0.5;

interface AreaSpec {
  id: AreaDef['id'];
  label: string;
  state: AreaDef['state'];
  city: string;
  censusKind: AreaDef['censusKind'];
  geoid: string;
  seedZip: string | null;
  poBoxZips: string[];
}

const AREA_SPECS: AreaSpec[] = [
  {
    id: 'edison_nj',
    label: 'Edison township, NJ',
    state: 'NJ',
    city: 'Edison',
    censusKind: 'cousub',
    geoid: '3402320230',
    seedZip: null,
    poBoxZips: ['08818', '08899'],
  },
  {
    id: 'austin_tx',
    label: 'Austin city, TX',
    state: 'TX',
    city: 'Austin',
    censusKind: 'place',
    geoid: '4805000',
    seedZip: '78701',
    poBoxZips: [],
  },
  {
    id: 'san_diego_ca',
    label: 'San Diego city, CA',
    state: 'CA',
    city: 'San Diego',
    censusKind: 'place',
    geoid: '0666000',
    seedZip: '92101',
    poBoxZips: [],
  },
];

const METUCHEN_GEOID = '3402345690';
const WOODBRIDGE_GEOID = '3402382000';

export interface ProvenanceEntry {
  name: string;
  url: string;
  obtained: string;
  bytes: number;
  sha256: string;
  note: string;
}

export interface GeoBuildDeps {
  config: PpConfig;
  fetcher: Fetcher | null;
  inputDir?: string;
  outDir: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface GeoBuildResult {
  areas: AreaDef[];
  featureCount: number;
  geojsonBytes: number;
  provenance: ProvenanceEntry[];
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** Reads the single entry of a zip archive (Gazetteer). Supports stored and deflated entries. */
export function readSingleZipEntry(zip: Buffer): { name: string; data: Buffer } {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip file (no end-of-central-directory record)');
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (zip.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('corrupt zip central directory');
  const method = zip.readUInt16LE(centralOffset + 10);
  const compressedSize = zip.readUInt32LE(centralOffset + 20);
  const nameLen = zip.readUInt16LE(centralOffset + 28);
  const localOffset = zip.readUInt32LE(centralOffset + 42);
  const name = zip.toString('utf8', centralOffset + 46, centralOffset + 46 + nameLen);
  if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('corrupt zip local header');
  const lNameLen = zip.readUInt16LE(localOffset + 26);
  const lExtraLen = zip.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + lNameLen + lExtraLen;
  const raw = zip.subarray(start, start + compressedSize);
  if (method === 0) return { name, data: Buffer.from(raw) };
  if (method === 8) return { name, data: inflateRawSync(raw) };
  throw new Error(`unsupported zip compression method ${method}`);
}

type Row = Record<string, string>;

function parsePipe(buf: Buffer): Row[] {
  return parse(buf, {
    delimiter: '|',
    bom: true,
    columns: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
  }) as Row[];
}

/** zcta -> share of the ZCTA's land inside each wanted geoid (Pitfall 12: rows with a blank ZCTA are skipped). */
export function sharesByGeoid(rows: Row[], geoidCol: string, wanted: Set<string>): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const zcta = (r.GEOID_ZCTA5_20 ?? '').trim();
    const geoid = (r[geoidCol] ?? '').trim();
    if (!zcta || !geoid || !wanted.has(geoid)) continue;
    const part = Number(r.AREALAND_PART);
    const total = Number(r.AREALAND_ZCTA5_20);
    if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) continue;
    let m = out.get(geoid);
    if (!m) out.set(geoid, (m = new Map()));
    m.set(zcta, (m.get(zcta) ?? 0) + part / total);
  }
  for (const m of out.values()) for (const [z, s] of m) m.set(z, Math.min(1, s));
  return out;
}

export function parseGazetteer(buf: Buffer): Map<string, { lat: number; lng: number }> {
  const text = buf.toString('utf8');
  const rows = parse(text, {
    delimiter: '|',
    bom: true,
    columns: (h: string[]) => h.map((x) => x.trim()),
    relax_column_count: true,
    skip_empty_lines: true,
  }) as Row[];
  const out = new Map<string, { lat: number; lng: number }>();
  for (const r of rows) {
    const zcta = (r.GEOID ?? '').trim();
    const lat = Number((r.INTPTLAT ?? '').trim());
    const lng = Number((r.INTPTLONG ?? '').trim());
    if (zcta && Number.isFinite(lat) && Number.isFinite(lng)) out.set(zcta, { lat, lng });
  }
  return out;
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const byShareThenZip = (a: AreaZcta, b: AreaZcta): number => b.share - a.share || a.zcta.localeCompare(b.zcta);

/**
 * Deterministic spread (D-09 amendment): seed with `seedZip` (or the candidate nearest it), then
 * repeatedly add the candidate whose minimum great-circle distance to the chosen set is largest
 * (ties: higher share, then lower ZIP).
 */
export function pickSpread(
  candidates: AreaZcta[],
  seedZip: string,
  seedPoint: { lat: number; lng: number } | null,
  n: number,
): string[] {
  if (candidates.length < n) throw new Error(`only ${candidates.length} candidate ZCTAs, need ${n}`);
  let seed = candidates.find((c) => c.zcta === seedZip);
  if (!seed) {
    if (!seedPoint) throw new Error(`seed ZIP ${seedZip} is not a candidate and has no centroid`);
    seed = [...candidates].sort(
      (a, b) => haversineKm(seedPoint, a) - haversineKm(seedPoint, b) || byShareThenZip(a, b),
    )[0] as AreaZcta;
  }
  const chosen: AreaZcta[] = [seed];
  const remaining = candidates.filter((c) => c.zcta !== seed.zcta);
  while (chosen.length < n) {
    let best: { z: AreaZcta; d: number } | null = null;
    for (const z of remaining) {
      const d = Math.min(...chosen.map((c) => haversineKm(c, z)));
      if (
        !best ||
        d > best.d + 1e-9 ||
        (Math.abs(d - best.d) <= 1e-9 && byShareThenZip(z, best.z) < 0)
      ) {
        best = { z, d };
      }
    }
    if (!best) break;
    chosen.push(best.z);
    remaining.splice(remaining.indexOf(best.z), 1);
  }
  return chosen.map((c) => c.zcta);
}

interface GeoFeature {
  type: 'Feature';
  properties: { ZCTA5: string };
  geometry: { type: string; coordinates: unknown };
}

function bboxOfGeometry(coords: unknown, box: [number, number, number, number]): void {
  if (Array.isArray(coords) && typeof coords[0] === 'number') {
    const [x, y] = coords as [number, number];
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  } else if (Array.isArray(coords)) {
    for (const c of coords) bboxOfGeometry(c, box);
  }
}

function section(text: string, begin: string, end: string, body: string): string {
  const block = `${begin}\n${body.trim()}\n${end}`;
  if (text.includes(begin) && text.includes(end)) {
    const a = text.indexOf(begin);
    const b = text.indexOf(end) + end.length;
    return text.slice(0, a) + block + text.slice(b);
  }
  return `${text.trimEnd()}${text.trim() ? '\n\n' : ''}${block}\n`;
}

export function renderProvenance(entries: ProvenanceEntry[], areas: AreaDef[], geojson: { bytes: number; features: number; sha256: string }): string {
  const rows = entries
    .map((e) => `| ${e.name} | ${e.url} | ${e.obtained} | ${e.bytes} | \`${e.sha256}\` | ${e.note} |`)
    .join('\n');
  const counts = areas
    .map(
      (a) =>
        `- ${a.id}: ${a.allZctas.length} ZCTAs at share >= zctaMinShare; pilot ${a.pilotZctas.length}; expansion ${a.expansionZctas.length}`,
    )
    .join('\n');
  return `## Geo data (generated by \`pp geo build\`)

Public, free US Census Bureau files. Regenerate with \`corepack pnpm pp geo build\` (add \`--input-dir DIR\` to
use already-downloaded copies of the three text files). Raw downloads stay outside the repo (PP_DATA_DIR).

| File | Source URL | Obtained | Bytes | sha256 | Note |
| --- | --- | --- | --- | --- | --- |
${rows}

Committed outputs: \`data/geo/pilot-areas.json\` (area definitions) and \`data/geo/pilot-zcta.geojson\`
(${geojson.features} ZCTA polygons, ${geojson.bytes} bytes, sha256 \`${geojson.sha256}\`).

### Derivation rules

- share = AREALAND_PART / AREALAND_ZCTA5_20 (fraction of the ZCTA's land inside the area); relationship rows with a
  blank ZCTA are skipped; the files are pipe-delimited with a UTF-8 BOM.
- edison_nj = county subdivision GEOID 3402320230 (Edison is a township, not a Census place); austin_tx = place
  4805000; san_diego_ca = place 0666000.
- allZctas = every ZCTA with share >= search.zctaMinShare (pp.config.json, 0.20), with Gazetteer INTPTLAT/INTPTLONG.
  Kept in full for Phase 2.
- pilotZctas: Edison = 08817, 08820, 08837 (08854 is a ~0.01 sliver). Austin and San Diego = exactly 12 each from
  ZCTAs with share >= 0.50: seed 78701 / 92101 (or the candidate nearest it), then repeatedly the candidate whose
  minimum great-circle distance to the chosen set is largest (ties: higher share, then lower ZIP).
- expansionZctas: Edison = Metuchen borough (3402345690) ZCTAs with share >= 0.50 plus Woodbridge township
  (3402382000) ZCTAs with share >= 0.98; Austin and San Diego = none.
- poBoxZips: Edison 08818 and 08899, NOT verified against USPS (research A3); used only to keep an address that
  shows one of these ZIPs in-area.
- Polygons: TIGERweb layer 7 (2020 Census ZIP Code Tabulation Areas), outSR 4326, maxAllowableOffset 0.0005,
  geometryPrecision 5, for every area ZCTA (all + expansion) plus every ZCTA intersecting each area's bounding
  envelope (neighbour ring).

### Result

${counts}
`;
}

export async function buildGeo(deps: GeoBuildDeps): Promise<GeoBuildResult> {
  const { config, fetcher, inputDir, outDir } = deps;
  const now = deps.now ?? (() => new Date());
  const say = deps.log ?? (() => undefined);
  const provenance: ProvenanceEntry[] = [];
  const obtained = now().toISOString().slice(0, 10);

  async function acquire(
    key: 'zctaPlace' | 'zctaCousub' | 'gazetteer',
    localName: string,
    url: string,
  ): Promise<Buffer> {
    let buf: Buffer;
    let note: string;
    const local = inputDir ? INPUT_NAMES[key].map((n) => path.join(inputDir, n)).find((p) => existsSync(p)) : undefined;
    if (local) {
      buf = readFileSync(local);
      note = `local copy of the official file (${path.basename(local)}) given with --input-dir`;
    } else {
      if (!fetcher) throw new Error(`no fetcher available to download ${url}`);
      const dest = path.join(dataDir(config), 'downloads', 'geo', localName);
      say(`downloading ${url}`);
      await fetcher.download(url, dest, { source: 'census' });
      buf = await readFile(dest);
      note = 'downloaded by pp geo build through the core fetcher (source census)';
    }
    provenance.push({ name: local ? path.basename(local) : localName, url, obtained, bytes: buf.length, sha256: sha256(buf), note });
    return buf;
  }

  const placeBuf = await acquire('zctaPlace', 'tab20_zcta520_place20_natl.txt', CENSUS_URLS.zctaPlace);
  const cousubBuf = await acquire('zctaCousub', 'tab20_zcta520_cousub20_natl.txt', CENSUS_URLS.zctaCousub);
  const gazRaw = await acquire('gazetteer', '2025_Gaz_zcta_national.zip', CENSUS_URLS.gazetteer);
  const gazBuf = gazRaw.subarray(0, 4).toString('latin1') === 'PK\u0003\u0004' ? readSingleZipEntry(gazRaw).data : gazRaw;
  const gaz = parseGazetteer(gazBuf);

  const placeShares = sharesByGeoid(
    parsePipe(placeBuf),
    'GEOID_PLACE_20',
    new Set(AREA_SPECS.filter((a) => a.censusKind === 'place').map((a) => a.geoid)),
  );
  const cousubShares = sharesByGeoid(
    parsePipe(cousubBuf),
    'GEOID_COUSUB_20',
    new Set([...AREA_SPECS.filter((a) => a.censusKind === 'cousub').map((a) => a.geoid), METUCHEN_GEOID, WOODBRIDGE_GEOID]),
  );

  const minShare = config.search.zctaMinShare;
  const areas: AreaDef[] = [];
  for (const spec of AREA_SPECS) {
    const shares = (spec.censusKind === 'place' ? placeShares : cousubShares).get(spec.geoid);
    if (!shares || shares.size === 0) throw new Error(`no ZCTA rows for ${spec.id} (${spec.geoid})`);
    const toZcta = (zcta: string, share: number): AreaZcta => {
      const c = gaz.get(zcta);
      if (!c) throw new Error(`ZCTA ${zcta} is missing from the Gazetteer`);
      return { zcta, share: Math.round(share * 10_000) / 10_000, lat: c.lat, lng: c.lng };
    };
    const allZctas = [...shares.entries()]
      .filter(([, s]) => s >= minShare)
      .map(([z, s]) => toZcta(z, s))
      .sort(byShareThenZip);

    let pilotZctas: string[];
    let expansionZctas: string[] = [];
    if (spec.id === 'edison_nj') {
      for (const z of EDISON_PILOT) if (!allZctas.some((a) => a.zcta === z)) throw new Error(`Edison ZCTA ${z} not found at share >= ${minShare}`);
      pilotZctas = [...EDISON_PILOT];
      const metuchen = [...(cousubShares.get(METUCHEN_GEOID) ?? new Map<string, number>()).entries()]
        .filter(([, s]) => s >= METUCHEN_MIN_SHARE)
        .map(([z]) => z);
      const woodbridge = [...(cousubShares.get(WOODBRIDGE_GEOID) ?? new Map<string, number>()).entries()]
        .filter(([, s]) => s >= WOODBRIDGE_MIN_SHARE)
        .map(([z]) => z);
      expansionZctas = [...new Set([...metuchen, ...woodbridge])]
        .filter((z) => !pilotZctas.includes(z))
        .sort();
    } else {
      const candidates = allZctas.filter((z) => z.share >= PILOT_CANDIDATE_MIN_SHARE);
      pilotZctas = pickSpread(candidates, spec.seedZip as string, gaz.get(spec.seedZip as string) ?? null, PILOT_ZIPS_PER_BIG_CITY);
    }

    areas.push({
      id: spec.id,
      label: spec.label,
      state: spec.state,
      city: spec.city,
      censusKind: spec.censusKind,
      geoid: spec.geoid,
      allZctas,
      pilotZctas,
      expansionZctas,
      poBoxZips: spec.poBoxZips,
      ...(spec.poBoxZips.length > 0 ? { poBoxZipsVerified: false } : {}),
    });
    say(`${spec.id}: ${allZctas.length} ZCTAs, pilot ${pilotZctas.length}, expansion ${expansionZctas.length}`);
  }

  // Polygons: area ZCTAs first, then every ZCTA intersecting each area's bounding envelope.
  const features = new Map<string, GeoFeature>();
  const localPolygons = inputDir ? INPUT_NAMES.polygons.map((n) => path.join(inputDir, n)).find((p) => existsSync(p)) : undefined;
  if (localPolygons) {
    const fc = JSON.parse(readFileSync(localPolygons, 'utf8')) as { features: GeoFeature[] };
    for (const f of fc.features) features.set(f.properties.ZCTA5, f);
    const buf = readFileSync(localPolygons);
    provenance.push({ name: 'TIGERweb ZCTA polygons', url: CENSUS_URLS.tigerweb, obtained, bytes: buf.length, sha256: sha256(buf), note: `local copy given with --input-dir (${path.basename(localPolygons)})` });
  } else {
    if (!fetcher) throw new Error('no fetcher available for TIGERweb polygons');
    const queryTiger = async (extra: Record<string, string>, label: string): Promise<GeoFeature[]> => {
      const collected: GeoFeature[] = [];
      const pageSize = 100;
      for (let offset = 0; ; offset += pageSize) {
        const form: Record<string, string> = {
          outFields: 'ZCTA5',
          outSR: '4326',
          f: 'geojson',
          returnGeometry: 'true',
          maxAllowableOffset: '0.0005',
          geometryPrecision: '5',
          orderByFields: 'ZCTA5',
          resultOffset: String(offset),
          resultRecordCount: String(pageSize),
          ...extra,
        };
        const res = await fetcher.post(CENSUS_URLS.tigerweb, form, { source: 'census', maxBytes: 80_000_000, timeoutMs: 120_000 });
        if (res.status !== 200) throw new Error(`TIGERweb ${label} returned HTTP ${res.status}`);
        const fc = JSON.parse(res.text()) as { features?: GeoFeature[]; error?: unknown };
        if (!fc.features) throw new Error(`TIGERweb ${label} returned no features: ${JSON.stringify(fc.error ?? fc).slice(0, 300)}`);
        provenance.push({ name: `TIGERweb query: ${label} (offset ${offset})`, url: CENSUS_URLS.tigerweb, obtained, bytes: res.body.length, sha256: sha256(res.body), note: 'POST form, layer 7 (2020 ZCTAs), outSR 4326, maxAllowableOffset 0.0005, geometryPrecision 5' });
        collected.push(...fc.features);
        if (fc.features.length < pageSize) break;
      }
      return collected;
    };

    const wanted = [...new Set(areas.flatMap((a) => [...a.allZctas.map((z) => z.zcta), ...a.expansionZctas]))].sort();
    const inList = `ZCTA5 IN (${wanted.map((z) => `'${z}'`).join(',')})`;
    say(`TIGERweb: ${wanted.length} area ZCTAs`);
    for (const f of await queryTiger({ where: inList }, 'area ZCTAs')) features.set(f.properties.ZCTA5, f);

    for (const area of areas) {
      const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const z of [...area.allZctas.map((a) => a.zcta), ...area.expansionZctas]) {
        const f = features.get(z);
        if (f) bboxOfGeometry(f.geometry.coordinates, box);
      }
      if (!Number.isFinite(box[0])) throw new Error(`no polygons found for ${area.id}`);
      say(`TIGERweb: neighbour ring for ${area.id}`);
      const ring = await queryTiger(
        {
          where: '1=1',
          geometry: box.join(','),
          geometryType: 'esriGeometryEnvelope',
          inSR: '4326',
          spatialRel: 'esriSpatialRelIntersects',
        },
        `ZCTAs intersecting the ${area.id} envelope`,
      );
      for (const f of ring) features.set(f.properties.ZCTA5, f);
    }
    for (const z of wanted) if (!features.has(z)) throw new Error(`TIGERweb returned no polygon for ZCTA ${z}`);
  }

  const sorted = [...features.values()]
    .map((f) => ({ type: 'Feature' as const, properties: { ZCTA5: f.properties.ZCTA5 }, geometry: f.geometry }))
    .sort((a, b) => a.properties.ZCTA5.localeCompare(b.properties.ZCTA5));
  const geojson = JSON.stringify({ type: 'FeatureCollection', features: sorted });
  if (Buffer.byteLength(geojson) > 5_000_000) {
    throw new Error(`pilot-zcta.geojson is ${Buffer.byteLength(geojson)} bytes, over the 5 MB limit; raise maxAllowableOffset`);
  }

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'pilot-areas.json'), `${JSON.stringify(areas, null, 2)}\n`);
  await writeFile(path.join(outDir, 'pilot-zcta.geojson'), geojson);

  const provPath = path.join(path.dirname(outDir), 'PROVENANCE.md');
  const existing = existsSync(provPath) ? readFileSync(provPath, 'utf8') : '# Data provenance\n\nEvery committed reference data file: where it came from, when, its size and sha256, and how it was derived.\n';
  const gj = Buffer.from(geojson);
  const body = renderProvenance(provenance, areas, { bytes: gj.length, features: sorted.length, sha256: sha256(gj) });
  await writeFile(provPath, section(existing, '<!-- geo:begin -->', '<!-- geo:end -->', body));

  return { areas, featureCount: sorted.length, geojsonBytes: gj.length, provenance };
}
