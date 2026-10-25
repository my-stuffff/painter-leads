import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fetcher } from '@pp/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SITES_DATA_DIR = path.resolve(HERE, '..', '..', 'data');
export const FIRST_NAMES_FILE = path.join(SITES_DATA_DIR, 'first-names.txt');
export const PROVENANCE_FILE = path.join(SITES_DATA_DIR, 'PROVENANCE.md');

export const CENSUS_URLS = {
  male: 'https://www2.census.gov/topics/genealogy/1990surnames/dist.male.first',
  female: 'https://www2.census.gov/topics/genealogy/1990surnames/dist.female.first',
} as const;
export const SSA_URL = 'https://www.ssa.gov/oact/babynames/names.zip';
/** SSA rule (D-18): names with at least this many births across the years below. */
export const SSA_MIN_TOTAL = 50;
export const SSA_FIRST_YEAR = 1930;
export const SSA_LAST_YEAR = 2005;

/** Lower-case and strip diacritics: "José" and "JOSE" look up the same. */
export function foldName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();
}

/** Census 1990 file: fixed width `NAME  freq  cumfreq  rank`. Returns the folded names. */
export function parseCensusFirstNames(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z'-]+)\s+\d/.exec(line.trim());
    if (m) out.push(foldName(m[1] as string));
  }
  return out;
}

/** SSA `yobYYYY.txt`: `name,sex,count`. Adds each name's count to `totals`. */
export function addSsaYear(text: string, totals: Map<string, number>): void {
  for (const line of text.split(/\r?\n/)) {
    const [name, , count] = line.trim().split(',');
    if (!name || !count) continue;
    const n = Number(count);
    if (!Number.isFinite(n)) continue;
    const key = foldName(name);
    totals.set(key, (totals.get(key) ?? 0) + n);
  }
}

export interface NameBuildInput {
  census: { label: string; url: string; text: string; sha256: string }[];
  /** Folder of extracted SSA yobYYYY.txt files, or null. */
  ssaDir: string | null;
}

export interface NameBuildResult {
  names: string[];
  fromCensus: number;
  fromSsa: number;
  sources: { label: string; url: string; sha256: string; lines: number }[];
  ssaFiles: number;
}

/** Union of the Census 1990 names and (optionally) the SSA names with total count >= 50 over 1930-2005. */
export function buildFirstNames(input: NameBuildInput): NameBuildResult {
  const set = new Set<string>();
  const sources: NameBuildResult['sources'] = [];
  for (const c of input.census) {
    const names = parseCensusFirstNames(c.text);
    for (const n of names) set.add(n);
    sources.push({ label: c.label, url: c.url, sha256: c.sha256, lines: names.length });
  }
  const fromCensus = set.size;
  let ssaFiles = 0;
  if (input.ssaDir) {
    const totals = new Map<string, number>();
    for (const f of readdirSync(input.ssaDir).sort()) {
      const m = /^yob(\d{4})\.txt$/.exec(f);
      if (!m) continue;
      const year = Number(m[1]);
      if (year < SSA_FIRST_YEAR || year > SSA_LAST_YEAR) continue;
      addSsaYear(readFileSync(path.join(input.ssaDir, f), 'utf8'), totals);
      ssaFiles++;
    }
    for (const [n, total] of totals) if (total >= SSA_MIN_TOTAL && /^[a-z'-]+$/.test(n)) set.add(n);
  }
  const names = [...set].filter((n) => n.length >= 2).sort();
  return { names, fromCensus, fromSsa: names.length - fromCensus, sources, ssaFiles };
}

export function provenanceText(r: NameBuildResult, date: string): string {
  const lines = [
    '# Data provenance (packages/sites)',
    '',
    '## first-names.txt',
    '',
    'US first names used to validate owner names found on company websites (D-18). Lower-case, diacritics folded, sorted, one per line.',
    '',
    `- Built: ${date}`,
    `- Count: ${r.names.length}`,
    '- Rule: union of the files below, folded to lower case',
    '',
    '| File | URL | sha256 (response body) | Lines |',
    '| --- | --- | --- | --- |',
    ...r.sources.map((s) => `| Census 1990 ${s.label} first names | ${s.url} | ${s.sha256} | ${s.lines} |`),
    '',
  ];
  if (r.ssaFiles > 0) {
    lines.push(
      `- SSA national baby names (${SSA_URL}): ${r.ssaFiles} yobYYYY.txt files (${SSA_FIRST_YEAR}-${SSA_LAST_YEAR}) read from a local folder; ` +
        `names with a total count >= ${SSA_MIN_TOTAL} were added (${r.fromSsa} names beyond the Census list).`,
    );
  } else {
    lines.push(
      `- SSA is pending (D-37): ssa.gov returns 403 from this laptop. Plan 01-06 adds the SSA union with \`pp sites names build --ssa-dir <folder of extracted yobYYYY.txt>\` (names with a total count >= ${SSA_MIN_TOTAL} over ${SSA_FIRST_YEAR}-${SSA_LAST_YEAR}; source ${SSA_URL}, public domain CC0).`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

let cached: Set<string> | null = null;

/** The committed first-name list (folded). Cached per process. */
export function loadFirstNames(file = FIRST_NAMES_FILE): Set<string> {
  if (cached && file === FIRST_NAMES_FILE) return cached;
  if (!existsSync(file)) throw new Error(`first-name list not found: ${file} (run: pp sites names build)`);
  const set = new Set(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
  if (file === FIRST_NAMES_FILE) cached = set;
  return set;
}

export function isFirstName(token: string, names: Set<string> = loadFirstNames()): boolean {
  return names.has(foldName(token.replace(/[.,]/g, '')));
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** `pp sites names build`: download (or read) the Census files, union SSA when given, write the data files. */
export async function buildFirstNamesFiles(o: {
  fetcher: Fetcher | null;
  censusDir?: string;
  ssaDir?: string;
  outDir?: string;
  today?: string;
}): Promise<NameBuildResult> {
  const census: NameBuildInput['census'] = [];
  for (const [label, url] of Object.entries(CENSUS_URLS)) {
    let body: Buffer;
    if (o.censusDir) {
      body = readFileSync(path.join(o.censusDir, path.basename(url)));
    } else {
      if (!o.fetcher) throw new Error('no fetcher (use --census-dir to read local files)');
      const res = await o.fetcher.get(url, { source: 'census', cache: 'use' });
      if (res.status !== 200) throw new Error(`census download failed: HTTP ${res.status} for ${url}`);
      body = res.body;
    }
    census.push({ label, url, text: body.toString('latin1'), sha256: sha256(body) });
  }
  const result = buildFirstNames({ census, ssaDir: o.ssaDir ?? null });
  const dir = o.outDir ?? SITES_DATA_DIR;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'first-names.txt'), `${result.names.join('\n')}\n`);
  writeFileSync(path.join(dir, 'PROVENANCE.md'), provenanceText(result, o.today ?? new Date().toISOString().slice(0, 10)));
  return result;
}
