import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addSsaYear,
  buildFirstNames,
  buildFirstNamesFiles,
  foldName,
  isFirstName,
  loadFirstNames,
  parseCensusFirstNames,
  SITES_DATA_DIR,
} from '../src/owners/names';

const MALE = `JAMES          3.318  3.318      1
JOHN           3.271  6.589      2
ROBERT         3.143  9.732      3
`;
const FEMALE = `MARY           2.629  2.629      1
JOSE           0.001  2.630      2
`;

describe('first-name list', () => {
  it('parses the fixed-width Census files', () => {
    expect(parseCensusFirstNames(MALE)).toEqual(['james', 'john', 'robert']);
    expect(parseCensusFirstNames('garbage line\n\n')).toEqual([]);
  });

  it('adds SSA names with a total count of at least 50 over 1930-2005 only', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pp-ssa-'));
    writeFileSync(path.join(dir, 'yob1950.txt'), 'Zorion,M,30\nAnna,F,100\nRare,F,10\n');
    writeFileSync(path.join(dir, 'yob1960.txt'), 'Zorion,M,25\nRare,F,10\n');
    writeFileSync(path.join(dir, 'yob2020.txt'), 'Newname,F,5000\n');
    writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
    const r = buildFirstNames({
      census: [{ label: 'male', url: 'u1', text: MALE, sha256: 'a'.repeat(64) }],
      ssaDir: dir,
    });
    expect(r.names).toEqual(['anna', 'james', 'john', 'robert', 'zorion']);
    expect(r.fromCensus).toBe(3);
    expect(r.fromSsa).toBe(2);
    expect(r.ssaFiles).toBe(2);
    const totals = new Map<string, number>();
    addSsaYear('A,M,5\nA,F,7\n', totals);
    expect(totals.get('a')).toBe(12);
  });

  it('writes the list and a provenance file (from local Census files)', async () => {
    const census = mkdtempSync(path.join(tmpdir(), 'pp-census-'));
    writeFileSync(path.join(census, 'dist.male.first'), MALE);
    writeFileSync(path.join(census, 'dist.female.first'), FEMALE);
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'pp-names-')), 'data');
    mkdirSync(out, { recursive: true });
    const r = await buildFirstNamesFiles({ fetcher: null, censusDir: census, outDir: out, today: '2026-10-25' });
    expect(r.names).toEqual(['james', 'john', 'jose', 'mary', 'robert']);
    expect(readFileSync(path.join(out, 'first-names.txt'), 'utf8')).toBe('james\njohn\njose\nmary\nrobert\n');
    const prov = readFileSync(path.join(out, 'PROVENANCE.md'), 'utf8');
    expect(prov).toContain('dist.male.first');
    expect(prov).toContain('dist.female.first');
    expect(prov).toMatch(/[0-9a-f]{64}/);
    expect(prov).toContain('SSA is pending (D-37)');
  });

  it('the committed list has at least 4,000 names and PROVENANCE.md names both Census files with sha256', () => {
    const names = loadFirstNames();
    expect(names.size).toBeGreaterThanOrEqual(4000);
    const prov = readFileSync(path.join(SITES_DATA_DIR, 'PROVENANCE.md'), 'utf8');
    expect(prov).toContain('https://www2.census.gov/topics/genealogy/1990surnames/dist.male.first');
    expect(prov).toContain('https://www2.census.gov/topics/genealogy/1990surnames/dist.female.first');
    expect(prov.match(/[0-9a-f]{64}/g)?.length).toBeGreaterThanOrEqual(2);
    expect(prov).toContain('SSA is pending (D-37)');
  });

  it('lookup ignores case and diacritics', () => {
    expect(foldName('JOSÉ')).toBe('jose');
    for (const n of ['josé', 'JOSE', 'María', 'MARIA', 'Jeff', 'Breanna', 'Mike']) expect(isFirstName(n), n).toBe(true);
    expect(isFirstName('Xzqvt')).toBe(false);
    expect(isFirstName('Painting')).toBe(false);
  });
});
