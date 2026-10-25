import { normaliseBusinessName, zip5 } from '@pp/core';

export type Strength = 'strong' | 'candidate';

/** The company side of a match: what the Google listing (after merge) tells us. */
export interface LadderCompany {
  name: string;
  city: string | null;
  zip: string | null;
  phoneLast10: string | null;
}

/** The registry side: one registry_records row. `aliasNorms` are normalised names (DBA / trade names). */
export interface LadderCandidate {
  key: string;
  recordId: number;
  nameNorm: string | null;
  nameCore: string | null;
  aliasNorms: string[];
  city: string | null;
  zip: string | null;
  phoneLast10: string | null;
  status: string | null;
  expiresOn: string | null;
}

export type Rung = 'phone' | 'name_loc' | 'core_loc' | 'name' | 'core_contains';

export interface LadderHit {
  key: string;
  recordId: number;
  rung: string;
  strength: Strength;
  /** Which key decided the hit, when the rung's name alone does not say (stored in registry_matches.detail). */
  note?: string;
}

export interface LadderOutcome {
  outcome: 'match' | 'candidate_only' | 'none';
  /** The chosen strong match when outcome is 'match'. */
  chosen: LadderHit | null;
  /** Rows to store in registry_matches: the chosen strong hit, or candidate hits (never promoted). */
  records: (LadderHit & { note?: string })[];
}

const RUNG_ORDER: readonly string[] = [
  'phone',
  '13vh',
  'email_domain',
  'name_loc',
  'core_loc',
  'name_zip',
  'address',
  'name',
  'core_contains',
];

export function sameCity(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return norm(a) === norm(b) && norm(a).length > 0;
}

export function sameZip(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = zip5(a);
  const y = zip5(b);
  return x !== null && x === y;
}

/** True when the registration is currently in force (CSLB "CLEAR", NJ "Active"). */
export function isActiveStatus(status: string | null | undefined): boolean {
  return /^(clear|active)$/i.test((status ?? '').trim());
}

function tokens(s: string): string[] {
  return s.split(' ').filter(Boolean);
}

/** `needle` occurs as a run of whole words inside `hay`. */
function containsRun(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, j) => hay[i + j] === t)) return true;
  }
  return false;
}

function nameSets(c: { nameNorm: string | null; nameCore: string | null; aliasNorms: string[] }): {
  norms: string[];
  cores: string[];
} {
  const norms = [c.nameNorm, ...c.aliasNorms].filter((n): n is string => !!n);
  const cores = [c.nameCore, ...c.aliasNorms.map((a) => normaliseBusinessName(a).core)].filter((n): n is string => !!n);
  return { norms: [...new Set(norms)], cores: [...new Set(cores)] };
}

/** Words with no weight in a name: filler, place, entity words. */
const NOISE_WORDS = new Set(['AND', 'THE', 'OF', 'FOR', 'WITH', 'THAT', 'YOUR', 'OUR', 'NEW', 'JERSEY', 'NJ', 'LLC', 'INC', 'CORP', 'CO', 'COMPANY']);

/**
 * Words that say what a business is, where it is or how good it claims to be. Two names sharing only one of these
 * is not a shared name (a shared "Painting" or "Quality" is two businesses of one trade, not one business).
 */
const GENERIC_NAME_WORDS = new Set([
  'NORTH', 'SOUTH', 'EAST', 'WEST', 'CENTRAL', 'AMERICAN', 'AMERICA', 'UNITED', 'NATIONAL', 'QUALITY', 'BEST', 'PREMIER',
  'ELITE', 'FIRST', 'GREAT', 'SUPERIOR', 'EXPERT', 'EXPERTS', 'GENERAL', 'ALL', 'TOP', 'CUSTOM', 'MASTER', 'MASTERS',
  'ROYAL', 'PERFECT', 'PRECISE', 'PRECISION', 'FINE', 'FINEST', 'EXPRESS', 'RELIABLE', 'AFFORDABLE', 'PRIME', 'PURE',
  'ADVANCED', 'CLASSIC', 'COLOR', 'COLORS', 'EXTERIOR', 'INTERIOR', 'RESIDENTIAL', 'COMMERCIAL', 'PROFESSIONAL',
  'PROFESSIONALS', 'PRO', 'PROS', 'PAINT', 'PAINTER', 'PAINTING', 'PAINTERS', 'DECORATING', 'DECORATOR', 'ROOFING',
  'REMODELING', 'REMODELER', 'RENOVATION', 'CONSTRUCTION', 'CONTRACTOR', 'CONTRACTING', 'BUILDER', 'BUILDING',
  'HANDYMAN', 'MAINTENANCE', 'PROPERTY', 'SERVICE', 'ENTERPRISE', 'GROUP', 'SOLUTION', 'HOME', 'HOUSE', 'IMPROVEMENT',
  'WALL', 'POWERWASHING', 'CLEANING', 'CARPENTRY', 'FLOORING', 'SIDING', 'GUTTER', 'LANDSCAPING',
]);

/** A word compared without its plural / possessive S ("BARTS" and "BART", "PAINTERS" and "PAINTER"). */
const stemWord = (t: string): string => (t.length >= 5 && t.endsWith('S') && !t.endsWith('SS') ? t.slice(0, -1) : t);

/** The weighty words of a business name (and its trade names): at least 3 letters, no filler, plural/possessive S dropped. */
export function nameWords(nameNorms: (string | null)[]): Set<string> {
  const out = new Set<string>();
  for (const n of nameNorms) {
    for (const t of tokens(n ?? '')) {
      const w = stemWord(t);
      if (w.length >= 3 && !/^\d+$/.test(w) && !NOISE_WORDS.has(w)) out.add(w);
    }
  }
  return out;
}

/**
 * The words two names share when that is enough to tie two records at the same street address to one business: at
 * least one distinctive word (not a trade / quality / place word), or at least two words of any kind. Else null.
 */
export function sharedNameWords(mine: Set<string>, theirs: Set<string>): string[] | null {
  const shared = [...mine].filter((w) => theirs.has(w));
  if (shared.some((w) => !GENERIC_NAME_WORDS.has(w)) || shared.length >= 2) return shared;
  return null;
}

/** The best rung a single candidate reaches, or null. */
export function rungFor(company: LadderCompany, cand: LadderCandidate): { rung: Rung; strength: Strength } | null {
  if (company.phoneLast10 && cand.phoneLast10 && company.phoneLast10 === cand.phoneLast10) {
    return { rung: 'phone', strength: 'strong' };
  }
  const mine = normaliseBusinessName(company.name);
  const my = nameSets({ nameNorm: mine.norm, nameCore: mine.core, aliasNorms: mine.aliases });
  const theirs = nameSets(cand);
  const loc = sameZip(company.zip, cand.zip) || sameCity(company.city, cand.city);

  const normEqual = my.norms.some((n) => theirs.norms.includes(n));
  if (normEqual && loc) return { rung: 'name_loc', strength: 'strong' };
  const coreEqual = my.cores.some((n) => theirs.cores.includes(n));
  if (coreEqual && loc) return { rung: 'core_loc', strength: 'strong' };
  if (normEqual || coreEqual) return { rung: 'name', strength: 'candidate' };
  for (const a of my.cores) {
    for (const b of theirs.cores) {
      const [short, long] = a.length <= b.length ? [a, b] : [b, a];
      if (short.length >= 5 && containsRun(tokens(long), tokens(short))) {
        return { rung: 'core_contains', strength: 'candidate' };
      }
    }
  }
  return null;
}

/**
 * Resolves per-record hits to one outcome (D-19, D-21): among strong hits Active registrations win; exactly
 * one left = a match; more than one Active = ambiguous, so candidates only; when none is Active the latest
 * expiry wins only if it is unique. Candidate (name-only) hits are stored but never promoted.
 */
export function resolveHits(hits: LadderHit[], byKey: Map<string, LadderCandidate>): LadderOutcome {
  const best = new Map<string, LadderHit>();
  for (const h of hits) {
    const prior = best.get(h.key);
    const rank = RUNG_ORDER.indexOf(h.rung);
    const priorRank = prior ? RUNG_ORDER.indexOf(prior.rung) : Infinity;
    if (
      !prior ||
      (h.strength === 'strong' && prior.strength !== 'strong') ||
      (h.strength === prior.strength && rank < priorRank)
    ) {
      best.set(h.key, h);
    }
  }
  const all = [...best.values()];
  const strong = all.filter((h) => h.strength === 'strong');
  const candidates = all.filter((h) => h.strength === 'candidate');

  if (strong.length === 0) {
    return { outcome: candidates.length > 0 ? 'candidate_only' : 'none', chosen: null, records: candidates.slice(0, 5) };
  }

  const status = (h: LadderHit) => byKey.get(h.key)?.status ?? null;
  const active = strong.filter((h) => isActiveStatus(status(h)));
  let pool = active.length > 0 ? active : strong;

  if (active.length === 0 && pool.length > 1) {
    const exp = (h: LadderHit) => byKey.get(h.key)?.expiresOn ?? '';
    const sorted = [...pool].sort((a, b) => exp(b).localeCompare(exp(a)));
    const top = sorted[0] as LadderHit;
    const second = sorted[1] as LadderHit;
    if (exp(top) !== '' && exp(top) > exp(second)) pool = [top];
  }

  if (pool.length === 1) {
    const chosen = pool[0] as LadderHit;
    return { outcome: 'match', chosen, records: [chosen] };
  }
  return {
    outcome: 'candidate_only',
    chosen: null,
    records: pool.slice(0, 5).map((h) => ({
      ...h,
      strength: 'candidate' as const,
      note: 'ambiguous: several strong registrations',
    })),
  };
}

/** The generic name/phone ladder (CSLB, TX, BBB). NJ builds its own rung order on top of `resolveHits`. */
export function matchLadder(company: LadderCompany, candidates: LadderCandidate[]): LadderOutcome {
  const hits: LadderHit[] = [];
  const byKey = new Map<string, LadderCandidate>();
  for (const c of candidates) {
    byKey.set(c.key, c);
    const r = rungFor(company, c);
    if (r) hits.push({ key: c.key, recordId: c.recordId, rung: r.rung, strength: r.strength });
  }
  return resolveHits(hits, byKey);
}
