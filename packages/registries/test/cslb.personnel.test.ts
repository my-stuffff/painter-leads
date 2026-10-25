import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'csv-parse/sync';
import { checkMasterComplete, checkPersonnelComplete, PERSONNEL_MIN_RATIO, robustMax } from '../src/cslb/completeness';
import { lookupCslbPersonnel } from '../src/cslb/lookup';
import { mapPersonnelRow } from '../src/cslb/personnel';
import { FIXTURES, fixture, makeFetcher, tempDir } from './helpers';

const COMPLETE = path.join(FIXTURES, 'cslb', 'cslb-people-complete.csv');
const TRUNCATED = path.join(FIXTURES, 'cslb', 'cslb-people-truncated.csv');
const MASTER_MAX = 1163439;

const peopleRows = () =>
  parse(readFileSync(COMPLETE, 'utf8'), { columns: true, relax_quotes: true }) as Record<string, string>[];

describe('checkPersonnelComplete (D-20)', () => {
  it('accepts a file within 1% of the master\'s highest licence number whose rows all parse', async () => {
    const v = await checkPersonnelComplete(COMPLETE, MASTER_MAX);
    expect(v).toMatchObject({ ok: true, reason: null, rows: 9, lastRowParses: true, maxLicence: 1163000 });
    expect(v.ratio).toBeGreaterThan(PERSONNEL_MIN_RATIO);
  });

  it('refuses a file cut mid-row: the last row does not parse', async () => {
    const v = await checkPersonnelComplete(TRUNCATED, MASTER_MAX);
    expect(v.ok).toBe(false);
    expect(v.lastRowParses).toBe(false);
    expect(v.reason).toMatch(/last row does not parse/);
  });

  it('refuses a complete-looking file whose highest licence is 2% below the master, accepts one 0.7% below', async () => {
    const header = readFileSync(COMPLETE, 'utf8').split('\r\n')[0] as string;
    const row = (lic: number) => `${lic},01/03/2026,Class/Title,1, Principal, DOE  JANE, Sole Owner, , Y, 01/01/2020, ,,,,,,,,`;
    const make = (max: number) => {
      const file = path.join(tempDir(), `people-${max}.csv`);
      writeFileSync(file, [header, row(1000000), row(max)].join('\r\n') + '\r\n');
      return file;
    };
    const low = await checkPersonnelComplete(make(Math.round(MASTER_MAX * 0.98)), MASTER_MAX);
    expect(low.ok).toBe(false);
    expect(low.reason).toMatch(/below the master/);
    expect(low.ratio).toBeCloseTo(0.98, 2);
    const near = await checkPersonnelComplete(make(Math.round(MASTER_MAX * 0.993)), MASTER_MAX);
    expect(near.ok).toBe(true);
    const edge = await checkPersonnelComplete(make(Math.round(MASTER_MAX * 0.99)), MASTER_MAX);
    expect(edge.ok).toBe(true);
  });

  it('an empty file and a master max of 0 are refused', async () => {
    const empty = path.join(tempDir(), 'empty.csv');
    writeFileSync(empty, readFileSync(COMPLETE, 'utf8').split('\r\n')[0] + '\r\n');
    expect((await checkPersonnelComplete(empty, MASTER_MAX)).ok).toBe(false);
    expect((await checkPersonnelComplete(COMPLETE, 0)).ok).toBe(false);
  });

  it('a master file is complete only when every row parses (the real download arrived cut off)', async () => {
    expect((await checkMasterComplete(path.join(FIXTURES, 'cslb', 'master-sample.csv'))).ok).toBe(true);
    const cut = path.join(tempDir(), 'cut.csv');
    const text = readFileSync(path.join(FIXTURES, 'cslb', 'master-sample.csv'), 'utf8');
    writeFileSync(cut, text.slice(0, text.length - 200));
    const v = await checkMasterComplete(cut);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/cut off/);
  });

  it('the highest licence ignores the 88888888 test licence', () => {
    const numbers = Array.from({ length: 2000 }, (_, i) => 1000000 + i * 80);
    expect(robustMax([...numbers, 88888888])).toBe(Math.max(...numbers));
    expect(robustMax([])).toBeNull();
  });
});

describe('personnel rows to roles', () => {
  const byLic = (lic: string, seq?: string) => peopleRows().find((r) => r['LIC-NO'] === lic && (seq === undefined || r['SEQ-NO'] === seq)) as Record<string, string>;

  it('fixed-width LAST FIRST MIDDLE becomes "First Last"; current roles have no dis-association date', () => {
    const p = mapPersonnelRow(byLic('1002304', '900001'));
    expect(p).toMatchObject({ display: 'Carol Example', first: 'Carol', last: 'Example', deceased: false });
    expect(p?.roles).toEqual([{ title: 'Responsible Managing Officer/Chief Executive Officer/President', rank: 1, associatedOn: '2015-01-05', dissociatedOn: null }]);
  });

  it('parallel title / date lists are paired by position; roles that cannot be an owner are dropped', () => {
    const p = mapPersonnelRow(byLic('1000441'));
    expect(p?.roles).toEqual([{ title: 'LLC Member', rank: 5, associatedOn: '2016-02-02', dissociatedOn: null }]);
  });

  it('a dis-associated role keeps its end date', () => {
    const p = mapPersonnelRow(byLic('1002304', '900003'));
    expect(p?.roles[0]).toMatchObject({ rank: 1, associatedOn: '2001-03-03', dissociatedOn: '2010-06-06' });
  });

  it('a deceased person is flagged; an AKA second name and a business row are not people', () => {
    expect(mapPersonnelRow(byLic('1000070'))?.deceased).toBe(true);
    expect(mapPersonnelRow(byLic('1000440'))?.display).toBe('Richard Roe');
    expect(mapPersonnelRow(byLic('1000588'))).toBeNull();
  });

  it('licence numbers stay strings', () => {
    expect(mapPersonnelRow(byLic('1163000'))?.licenceNo).toBe('1163000');
  });
});

describe('per-licence lookup fallback', () => {
  const HOST = 'https://www2.cslb.ca.gov';
  const PATH = '/OnlineServices/CheckLicenseII/CheckLicense.aspx';
  const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } };

  it("reports 'lookup_unavailable' when the search just returns the search form again (what the live probe saw)", async () => {
    const { fetcher, agent } = makeFetcher();
    const page = fixture('cslb', 'checklicense-form-after-post.html');
    const pool = agent.get(HOST);
    pool.intercept({ path: PATH, method: 'GET' }).reply(200, page, HTML);
    pool.intercept({ path: PATH, method: 'POST' }).reply(200, page, HTML);
    const r = await lookupCslbPersonnel(fetcher, '1002304');
    expect(r).toMatchObject({ status: 'lookup_unavailable', licenceNo: '1002304', pages: 2 });
    expect(r.reason).toMatch(/search form again/);
  });

  it("is 'lookup_unavailable' when the search form does not load, and rejects a non-number", async () => {
    const { fetcher, agent } = makeFetcher();
    agent.get(HOST).intercept({ path: PATH, method: 'GET' }).reply(503, 'down', HTML);
    expect(await lookupCslbPersonnel(fetcher, '1002304')).toMatchObject({ status: 'lookup_unavailable', pages: 1 });
    await expect(lookupCslbPersonnel(fetcher, '10X')).rejects.toThrow(/not a CSLB licence number/);
  });
});
