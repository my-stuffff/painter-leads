import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load';
import { getArea, isZipInArea, loadAreas, zctaForPoint } from '../src/geo';
import { haversineKm, pickSpread, readSingleZipEntry, sharesByGeoid } from '../src/geo/build';
import { deflateRawSync } from 'node:zlib';

const config = loadConfig();
const areas = loadAreas(config);
const area = (id: string) => areas.find((a) => a.id === id)!;

describe('pilot areas (D-08, D-09 amendment)', () => {
  it('Edison pilot list is exactly the three Edison ZCTAs, with Metuchen/Woodbridge held as expansion', () => {
    const e = area('edison_nj');
    expect(e.pilotZctas).toEqual(['08817', '08820', '08837']);
    expect(e.expansionZctas).toContain('08840');
    for (const z of ['07001', '07064', '07067', '07077', '07095', '08830', '08832', '08863']) {
      expect(e.expansionZctas).toContain(z);
    }
    expect(e.pilotZctas).not.toContain('08854');
    expect(e.poBoxZips).toEqual(['08818', '08899']);
    expect(e.poBoxZipsVerified).toBe(false);
  });

  it.each(['austin_tx', 'san_diego_ca'])('%s has exactly 12 unique pilot ZCTAs, all with share >= 0.5', (id) => {
    const a = area(id);
    expect(a.pilotZctas).toHaveLength(12);
    expect(new Set(a.pilotZctas).size).toBe(12);
    for (const z of a.pilotZctas) {
      const entry = a.allZctas.find((x) => x.zcta === z);
      expect(entry, `${z} must be in allZctas`).toBeDefined();
      expect(entry!.share).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('seeds Austin with 78701 and San Diego with 92101', () => {
    expect(area('austin_tx').pilotZctas[0]).toBe('78701');
    expect(area('san_diego_ca').pilotZctas[0]).toBe('92101');
  });

  it('keeps the full ZCTA lists for Phase 2 (research counts at share >= 0.20)', () => {
    expect(area('edison_nj').allZctas).toHaveLength(3);
    expect(area('austin_tx').allZctas).toHaveLength(38);
    expect(area('san_diego_ca').allZctas).toHaveLength(45);
    for (const a of areas.filter((x) => x.zctaRule !== 'city-land')) {
      expect(a.allZctas.every((z) => z.share >= config.search.zctaMinShare), a.id).toBe(true);
    }
  });

  it('loadAreas honours the config order, getArea throws on an unknown id, isZipInArea', () => {
    expect(config.areas.pilotOrder.every((id) => areas.some((a) => a.id === id))).toBe(true);
    expect(getArea(config, 'austin_tx').city).toBe('Austin');
    expect(() => getArea(config, 'nowhere')).toThrow(/Unknown area/);
    const edison = area('edison_nj');
    expect(isZipInArea(edison, '08817')).toBe(true);
    expect(isZipInArea(edison, '08840')).toBe(true); // expansion
    expect(isZipInArea(edison, '08818')).toBe(true); // PO box
    expect(isZipInArea(edison, '10001')).toBe(false);
  });
});

describe('zctaForPoint (D-10)', () => {
  it('places Lifetime Custom Painting (San Diego) in a 921xx ZCTA', () => {
    expect(zctaForPoint(32.7443651, -117.1298877)).toMatch(/^921\d\d$/);
  });

  it('places a downtown Austin point in 78701 and each Edison ZCTA internal point in its own ZCTA', () => {
    expect(zctaForPoint(30.2672, -97.7431)).toBe('78701');
    for (const z of area('edison_nj').allZctas) expect(zctaForPoint(z.lat, z.lng)).toBe(z.zcta);
  });

  it('returns null for a point in the ocean', () => {
    expect(zctaForPoint(32.5, -118.0)).toBeNull();
  });
});

describe('geo build helpers', () => {
  it('sharesByGeoid skips blank-ZCTA rows and computes share = part / zcta land', () => {
    const rows = [
      { GEOID_ZCTA5_20: '', GEOID_PLACE_20: '4805000', AREALAND_PART: '5', AREALAND_ZCTA5_20: '' },
      { GEOID_ZCTA5_20: '78701', GEOID_PLACE_20: '4805000', AREALAND_PART: '50', AREALAND_ZCTA5_20: '100' },
      { GEOID_ZCTA5_20: '78701', GEOID_PLACE_20: '9999999', AREALAND_PART: '1', AREALAND_ZCTA5_20: '100' },
    ];
    const out = sharesByGeoid(rows, 'GEOID_PLACE_20', new Set(['4805000']));
    expect([...out.keys()]).toEqual(['4805000']);
    expect(out.get('4805000')!.get('78701')).toBe(0.5);
  });

  it('pickSpread is deterministic: seed first, then the farthest candidate, ties by share then ZIP', () => {
    const c = (zcta: string, lat: number, lng: number, share = 1) => ({ zcta, share, lat, lng });
    const cands = [c('A', 0, 0), c('B', 0, 1), c('C', 0, 5), c('D', 0.1, 0.1), c('E', 0, 10)];
    expect(pickSpread(cands, 'A', null, 3)).toEqual(['A', 'E', 'C']);
    expect(pickSpread(cands, 'A', null, 3)).toEqual(pickSpread([...cands].reverse(), 'A', null, 3));
    // Missing seed: the candidate nearest the seed's own centroid is used.
    expect(pickSpread(cands, 'Z', { lat: 0, lng: 9 }, 2)[0]).toBe('E');
    expect(() => pickSpread(cands, 'A', null, 6)).toThrow();
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeGreaterThan(100);
  });

  it('readSingleZipEntry extracts a deflated single-file zip', () => {
    const data = Buffer.from('GEOID|INTPTLAT\n78701|30.27\n');
    const comp = deflateRawSync(data);
    const name = Buffer.from('a.txt');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    const centralOffset = local.length + name.length + comp.length;
    eocd.writeUInt32LE(centralOffset, 16);
    const zip = Buffer.concat([local, name, comp, central, name, eocd]);
    const entry = readSingleZipEntry(zip);
    expect(entry.name).toBe('a.txt');
    expect(entry.data.equals(data)).toBe(true);
    expect(() => readSingleZipEntry(Buffer.from('not a zip at all, definitely'))).toThrow();
  });
});
