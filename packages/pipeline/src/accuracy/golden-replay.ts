import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  normaliseEmail,
  personNameKey,
  type CompanyRef,
  type GoldenPage,
  type GoldenReplayers,
  type ResidentialLabel,
  type StateCode,
} from '@pp/core';
import { normaliseForCompare } from './compare';
import { NOT_FINDABLE } from './truth';

export const MAPS_CARD_KEYS = ['name', 'rating', 'review_count', 'phone', 'category', 'website'] as const;
export type MapsCardKey = (typeof MAPS_CARD_KEYS)[number];

/** The hand-checked answers of one golden company. NOT_FINDABLE = the extractor must stay blank. */
export interface GoldenTruth {
  sample_id: string;
  company: {
    name: string;
    state: StateCode;
    city: string | null;
    zip: string | null;
    street: string | null;
    websiteUrl: string | null;
    phoneE164: string | null;
    categories: string[];
  };
  nj_hic_active: boolean | null;
  fields: {
    emails?: string[] | typeof NOT_FINDABLE;
    /** `ignore`: names the website carries that finalisation rejects (conflicts with a registry, templates). */
    owners?: { expected: string[] | typeof NOT_FINDABLE; ignore: string[] };
    residential?: ResidentialLabel;
    maps_card?: Partial<Record<MapsCardKey, string | null>>;
    /** Matcher regression guard: what the system's matcher decided (not hand-verified). */
    registry_match?: { sourceKey: string; strength: 'strong' | 'candidate' }[];
  };
}

export interface GoldenCase {
  state: string;
  slug: string;
  dir: string;
  pages: GoldenPage[];
  mapsCard: { card_raw: unknown; place_raw: unknown } | null;
  registryCandidates: unknown[];
  truth: GoldenTruth;
}

export interface GoldenDiff {
  state: string;
  slug: string;
  field: string;
  expected: string;
  actual: string;
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const subdirs = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => statSync(path.join(dir, n)).isDirectory())
        .sort()
    : [];

/** One case from its folder (<dir>/<state>/<slug>); a truth can be passed in to replay a different answer sheet. */
export function loadGoldenCase(caseDir: string, truthOverride?: GoldenTruth): GoldenCase {
  const pagesMeta = existsSync(path.join(caseDir, 'pages.json'))
    ? readJson<{ url: string; sha256: string; rendered: boolean }[]>(path.join(caseDir, 'pages.json'))
    : [];
  const pages: GoldenPage[] = pagesMeta.map((p) => ({
    url: p.url,
    rendered: p.rendered,
    html: gunzipSync(readFileSync(path.join(caseDir, 'pages', p.sha256 + '.html.gz'))).toString('utf8'),
  }));
  const mapsCardFile = path.join(caseDir, 'maps-card.json');
  const registryFile = path.join(caseDir, 'registry.json');
  return {
    state: path.basename(path.dirname(caseDir)),
    slug: path.basename(caseDir),
    dir: caseDir,
    pages,
    mapsCard: existsSync(mapsCardFile) ? readJson(mapsCardFile) : null,
    registryCandidates: existsSync(registryFile) ? readJson<{ candidates: unknown[] }>(registryFile).candidates : [],
    truth: truthOverride ?? readJson<GoldenTruth>(path.join(caseDir, 'truth.json')),
  };
}

/** Every case under <dir>/<state>/<slug>/, in sorted directory order (state, then slug). */
export function loadGoldenCases(dir: string): GoldenCase[] {
  const cases: GoldenCase[] = [];
  for (const state of subdirs(dir)) {
    for (const slug of subdirs(path.join(dir, state))) {
      const caseDir = path.join(dir, state, slug);
      if (existsSync(path.join(caseDir, 'truth.json'))) cases.push(loadGoldenCase(caseDir));
    }
  }
  return cases;
}

/** The replayable fields of a case, as they are named in test titles (state/slug/field). */
export function goldenFieldKeys(c: GoldenCase): string[] {
  const f = c.truth.fields;
  const keys: string[] = [];
  if (f.emails !== undefined) keys.push('emails');
  if (f.owners !== undefined) keys.push('owners');
  if (f.residential !== undefined) keys.push('residential');
  if (f.maps_card) for (const k of MAPS_CARD_KEYS) if (k in f.maps_card) keys.push(`maps_card.${k}`);
  if (f.registry_match !== undefined) keys.push('registry_match');
  return keys;
}

function need<K extends keyof GoldenReplayers>(r: Partial<GoldenReplayers>, name: K, from: string): GoldenReplayers[K] {
  const fn = r[name];
  if (!fn) throw new Error(`replayer "${String(name)}" is missing (package ${from} not merged yet)`);
  return fn;
}

export function companyRefOf(t: GoldenTruth): CompanyRef {
  return { companyId: 0, ...t.company };
}

const setText = (v: Set<string>): string => [...v].sort().join(', ');
const expectedText = (v: string[] | typeof NOT_FINDABLE): string => (v === NOT_FINDABLE ? NOT_FINDABLE : [...v].sort().join(', '));

/** Replays one field of one case; null when the replayed output matches the truth after normalisation. */
export function replayField(c: GoldenCase, field: string, replayers: Partial<GoldenReplayers>): GoldenDiff | null {
  const t = c.truth;
  const diff = (expected: string, actual: string): GoldenDiff => ({ state: c.state, slug: c.slug, field, expected, actual });
  const site = { websiteUrl: t.company.websiteUrl ?? '' };

  if (field === 'emails') {
    const exp = t.fields.emails as string[] | typeof NOT_FINDABLE;
    const actual = new Set(need(replayers, 'emails', 'sites')(c.pages, site).map(normaliseEmail));
    const expected = new Set(exp === NOT_FINDABLE ? [] : exp.map(normaliseEmail));
    if (setText(actual) === setText(expected)) return null;
    return diff(expectedText(exp), actual.size === 0 ? '(none)' : setText(actual));
  }

  if (field === 'owners') {
    const spec = t.fields.owners as NonNullable<GoldenTruth['fields']['owners']>;
    const ignore = new Set(spec.ignore.map(personNameKey));
    const found = need(replayers, 'owners', 'sites')(c.pages, { ...site, companyName: t.company.name, city: t.company.city });
    const actual = new Set(found.filter((o) => o.confidence !== 'low').map((o) => personNameKey(o.name)).filter((k) => !ignore.has(k)));
    const expected = new Set(spec.expected === NOT_FINDABLE ? [] : spec.expected.map(personNameKey));
    if (setText(actual) === setText(expected)) return null;
    return diff(expectedText(spec.expected), actual.size === 0 ? '(none)' : setText(actual));
  }

  if (field === 'residential') {
    const expected = t.fields.residential as ResidentialLabel;
    const actual = need(replayers, 'residential', 'sites')({
      pages: c.pages,
      categories: t.company.categories,
      name: t.company.name,
      njHicActive: t.nj_hic_active,
    }).label;
    return actual === expected ? null : diff(expected, actual);
  }

  if (field.startsWith('maps_card.')) {
    const key = field.slice('maps_card.'.length) as MapsCardKey;
    const exp = (t.fields.maps_card ?? {})[key] ?? null;
    const snapshot = c.mapsCard?.card_raw ?? null;
    const card = need(replayers, 'mapsCard', 'maps')(snapshot);
    const actualRaw = card[key] ?? null;
    const norm = (v: string | null): string => (v === null || v === '' ? '' : normaliseForCompare(key, v));
    if (norm(exp) === norm(actualRaw)) return null;
    return diff(exp === null ? NOT_FINDABLE : exp, actualRaw === null || actualRaw === '' ? '(none)' : actualRaw);
  }

  if (field === 'registry_match') {
    const exp = t.fields.registry_match as { sourceKey: string; strength: string }[];
    const got = need(replayers, 'registryMatch', 'registries')({ company: companyRefOf(t), candidates: c.registryCandidates });
    const text = (v: { sourceKey: string; strength: string }[]): string => v.map((m) => `${m.sourceKey}:${m.strength}`).sort().join(', ');
    return text(exp) === text(got) ? null : diff(text(exp) || '(none)', text(got) || '(none)');
  }

  throw new Error(`unknown golden field "${field}"`);
}

/** Every difference between a case's truth and what the replayers produce now (expected vs actual per field). */
export function replayCase(c: GoldenCase, replayers: Partial<GoldenReplayers>): GoldenDiff[] {
  const out: GoldenDiff[] = [];
  for (const f of goldenFieldKeys(c)) {
    const d = replayField(c, f, replayers);
    if (d) out.push(d);
  }
  return out;
}

export function formatDiff(d: GoldenDiff): string {
  return `${d.state}/${d.slug}/${d.field}: expected ${d.expected}, actual ${d.actual}`;
}
