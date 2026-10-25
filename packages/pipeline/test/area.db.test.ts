import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getArea, getTestDb, loadConfig, truncateAll, zctaForPoint } from '@pp/core';
import { assignArea, decideArea } from '../src/area';
import { applyPainterFilter } from '../src/filter';
import { mergeRun } from '../src/merge';
import { planSearches } from '../src/plan';
import { q } from '../src/sql';
import { FIXED_NOW, makeEnv } from './helpers';
import { pointOf, seedListing, seedRun } from './seed';

const handle = getTestDb();
const db = handle.db;
const env = makeEnv(db);
const config = loadConfig();
const edison = getArea(config, 'edison_nj');

afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await truncateAll(db);
});

interface CompanyArea {
  display_name: string;
  in_area: boolean;
  location_precision: string;
}

async function areas(): Promise<Map<string, CompanyArea>> {
  const rows = await q<CompanyArea>(db, `SELECT display_name, in_area, location_precision FROM companies`);
  return new Map(rows.map((r) => [r.display_name, r]));
}

describe('decideArea (D-10), pure', () => {
  it('the address ZIP decides when shown', () => {
    expect(decideArea(edison, { zip: '08817', lat: null, lng: null }, false)).toMatchObject({ inArea: true, precision: 'exact', zip: '08817' });
    expect(decideArea(edison, { zip: '08817-3333', lat: null, lng: null }, false).zip).toBe('08817');
    expect(decideArea(edison, { zip: '10001', lat: null, lng: null }, false)).toMatchObject({ inArea: false, precision: 'exact' });
  });

  it('no address: the pin decides, marked approximate, and the ZIP is never claimed as an address ZIP', () => {
    const d = decideArea(edison, { zip: null, lat: 1, lng: 2 }, false, () => '08820');
    expect(d).toMatchObject({ inArea: true, precision: 'approximate', zip: '08820', derivedFromPin: true });
    expect(decideArea(edison, { zip: null, lat: 1, lng: 2 }, false, () => '10001')).toMatchObject({ inArea: false, precision: 'approximate' });
  });

  it('no address and no usable pin is unknown and outside (nothing is guessed)', () => {
    expect(decideArea(edison, { zip: null, lat: null, lng: null }, false)).toMatchObject({ inArea: false, precision: 'unknown', zip: null });
    expect(decideArea(edison, { zip: null, lat: 1, lng: 2 }, false, () => null)).toMatchObject({ inArea: false, precision: 'unknown' });
  });

  it('expansion ZIPs count only once the expansion phase ran', () => {
    const zip = edison.expansionZctas[0] as string;
    expect(decideArea(edison, { zip, lat: null, lng: null }, false).inArea).toBe(false);
    expect(decideArea(edison, { zip, lat: null, lng: null }, true).inArea).toBe(true);
  });

  it('a listed PO-box ZIP is in the area', () => {
    expect(decideArea(edison, { zip: edison.poBoxZips[0] as string, lat: null, lng: null }, false).inArea).toBe(true);
  });
});

describe('assignArea on stored companies', () => {
  it('address ZIP 08817 -> in_area exact; a ZIP elsewhere -> outside', async () => {
    const run = await seedRun(db);
    await seedListing(db, env.evidence, run, { key: 'a', name: 'Edison Painting', street: '1 Main St', city: 'Edison', zip: '08817' });
    await seedListing(db, env.evidence, run, { key: 'b', name: 'Manhattan Painting', street: '1 Broadway', city: 'New York', zip: '10001', state: 'NY' });
    await mergeRun(db, env.evidence, config, run);
    await assignArea(db, env.evidence, config, run, FIXED_NOW);
    const a = await areas();
    expect(a.get('Edison Painting')).toMatchObject({ in_area: true, location_precision: 'exact' });
    expect(a.get('Manhattan Painting')).toMatchObject({ in_area: false, location_precision: 'exact' });
  });

  it('a service-area business with no address is placed by its pin, marked approximate, with a derived city and no ZIP', async () => {
    const pin = pointOf(config, 'edison_nj', '08820');
    expect(zctaForPoint(pin.lat, pin.lng)).toBe('08820');
    const run = await seedRun(db);
    await seedListing(db, env.evidence, run, { key: 'sab', name: 'Mobile Painting Pros', ...pin });
    await mergeRun(db, env.evidence, config, run);
    await assignArea(db, env.evidence, config, run, FIXED_NOW);

    expect((await areas()).get('Mobile Painting Pros')).toMatchObject({ in_area: true, location_precision: 'approximate' });
    const derived = await q<{ field: string; value: string; attrs: { derived: string; zcta: string } }>(
      db,
      `SELECT field, value, attrs FROM evidence WHERE extractor = 'pipeline/area' ORDER BY field`,
    );
    expect(derived.map((d) => [d.field, d.value])).toEqual([
      ['city', 'Edison'],
      ['state', 'NJ'],
    ]);
    expect(derived[0]?.attrs).toMatchObject({ derived: 'pin-in-zcta', zcta: '08820' });
    const zips = await q(db, `SELECT 1 FROM evidence WHERE field = 'zip'`);
    expect(zips).toHaveLength(0); // no ZIP is invented

    // running it again does not add a second derived row
    await assignArea(db, env.evidence, config, run, FIXED_NOW);
    expect(await q(db, `SELECT 1 FROM evidence WHERE extractor = 'pipeline/area'`)).toHaveLength(2);
  });

  it('a pin outside the area is outside, and a listing with neither address nor pin is unknown', async () => {
    const run = await seedRun(db);
    await seedListing(db, env.evidence, run, { key: 'far', name: 'Far Away Painting', lat: 40.7128, lng: -74.006 });
    await seedListing(db, env.evidence, run, { key: 'none', name: 'Nowhere Painting' });
    await mergeRun(db, env.evidence, config, run);
    await assignArea(db, env.evidence, config, run, FIXED_NOW);
    const a = await areas();
    expect(a.get('Far Away Painting')?.in_area).toBe(false);
    expect(a.get('Nowhere Painting')).toMatchObject({ in_area: false, location_precision: 'unknown' });
  });

  it('a Woodbridge-side ZIP is in the area only after the expansion phase was planned', async () => {
    const zip = edison.expansionZctas[0] as string;
    const run = await seedRun(db);
    await seedListing(db, env.evidence, run, { key: 'w', name: 'Woodbridge Painting', street: '5 Rahway Ave', city: 'Woodbridge', zip });
    await mergeRun(db, env.evidence, config, run);
    await applyPainterFilter(db, run);

    await assignArea(db, env.evidence, config, run, FIXED_NOW);
    expect((await areas()).get('Woodbridge Painting')?.in_area).toBe(false);

    await planSearches(db, config, 'edison_nj', 'expansion', run);
    await assignArea(db, env.evidence, config, run, FIXED_NOW);
    expect((await areas()).get('Woodbridge Painting')?.in_area).toBe(true);
  });
});
