import { normaliseBusinessName, titleCaseName } from '@pp/core';
import { foldName, isFirstName, loadFirstNames } from './names';

export interface OwnerNameContext {
  /** The company's display name (its tokens can never be a person's name here). */
  companyName: string;
  city: string | null;
  /** Other city names (the pilot areas). */
  cities?: readonly string[];
  /** Folded first-name list; defaults to the committed file. */
  firstNames?: Set<string>;
}

export type NameVerdict =
  | { ok: true; name: string; first: string; last: string | null }
  | { ok: false; reason: string };

export const REJECT_NAME = {
  role: 'role word in name',
  allCaps: 'all-caps string',
  words: 'wrong number of words',
  firstName: 'first name not in list',
  surname: 'surname is not a capitalised word',
  junk: 'company, city or painting word',
} as const;

export const ROLE_WORDS = new Set(['owner', 'founder', 'cofounder', 'co-founder', 'president', 'ceo', 'proprietor', 'coowner', 'co-owner']);
const LEADING_STOP = new Set([
  'meet', 'hi', 'hello', 'hey', 'welcome', 'about', 'our', 'the', 'thanks', 'thank', 'you', 'from', 'with', 'by', 'call',
  'ask', 'contact', 'introducing', 'mr', 'mrs', 'ms', 'mx', 'miss', 'dr', 'prof', 'and', 'is', 'was', 'a', 'an', 'to', 'of',
  'founded', 'owned', 'operated', 'started', 'established', 'family', 'locally', 'proudly',
]);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
export const PARTICLES = new Set(['de', 'del', 'la', 'van', 'von', 'da', 'di', 'der', 'den', 'le', 'du', 'dos', 'das', 'bin', 'al', 'el']);

const PAINTING_WORDS = new Set([
  'painting', 'painter', 'painters', 'paint', 'paints', 'coatings', 'coating', 'pro', 'pros', 'services', 'service', 'llc', 'inc',
  'home', 'homes', 'house', 'company', 'co', 'contractor', 'contractors', 'contracting', 'construction', 'remodeling',
  'restoration', 'exteriors', 'interiors', 'group', 'team', 'staff', 'residential', 'commercial', 'handyman', 'drywall',
  'estimate', 'estimates', 'free', 'quality', 'professional', 'professionals',
]);
const US_STATES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia',
  'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts',
  'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
  'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia',
  'wisconsin', 'wyoming',
];

const NAME_TOKEN = /^\p{Lu}[\p{L}'’]*(?:-\p{Lu}[\p{L}'’]*)*$/u;
const INITIAL = /^\p{Lu}\.?$/u;

function cleanToken(t: string): string {
  return t.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}.]+$/u, '');
}

function hasPhrase(tokens: string[], phrase: string): boolean {
  const p = phrase.split(' ').filter((w) => w.length > 0);
  if (p.length === 0) return false;
  for (let i = 0; i + p.length <= tokens.length; i++) {
    if (p.every((w, j) => tokens[i + j] === w)) return true;
  }
  return false;
}

/** Company-name tokens (3+ letters) that can never be part of a person's name on that company's site. */
export function companyTokens(companyName: string): string[] {
  return normaliseBusinessName(companyName)
    .norm.split(' ')
    .map((t) => foldName(t))
    .filter((t) => t.length >= 3 && t !== 'and' && t !== 'the');
}

function junkReason(tokens: string[], ctx: OwnerNameContext): boolean {
  const folded = tokens.flatMap((t) => foldName(t.replace(/\.$/, '')).split(/[-']/)).filter((t) => t.length > 0);
  const company = new Set(companyTokens(ctx.companyName));
  if (folded.some((t) => PAINTING_WORDS.has(t) || company.has(t))) return true;
  const phrases = [ctx.city, ...(ctx.cities ?? [])]
    .filter((c): c is string => !!c)
    .map((c) => foldName(c))
    .concat(US_STATES);
  const plain = tokens.map((t) => foldName(t.replace(/\.$/, '')));
  return phrases.some((p) => hasPhrase(plain, p));
}

/** Splits a raw candidate into display tokens, dropping leading filler words, honorifics and suffixes. */
function nameTokens(raw: string): string[] {
  const toks = raw
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map(cleanToken)
    .filter((t) => t.length > 0);
  while (toks.length > 0 && LEADING_STOP.has(foldName(toks[0] as string).replace(/\.$/, ''))) toks.shift();
  while (toks.length > 0 && SUFFIXES.has(foldName(toks[toks.length - 1] as string).replace(/\.$/, ''))) toks.pop();
  return toks;
}

/**
 * ENR-02 / D-18: a full name is acceptable when it has a first and last name (2-4 words, a middle
 * initial and particles allowed), the first name is in the first-name list (case and diacritics
 * ignored), the surname is a capitalised word, and no word is a role word, company-name word, city
 * or painting word.
 */
export function validateOwnerName(raw: string, ctx: OwnerNameContext): NameVerdict {
  let tokens = nameTokens(raw);
  if (tokens.length === 0) return { ok: false, reason: REJECT_NAME.words };
  if (tokens.some((t) => ROLE_WORDS.has(foldName(t)))) return { ok: false, reason: REJECT_NAME.role };

  const text = tokens.join(' ');
  if (!/\p{Ll}/u.test(text)) {
    if (tokens.length > 3) return { ok: false, reason: REJECT_NAME.allCaps };
    tokens = titleCaseName(text).split(' ');
  }

  const significant = tokens.filter((t) => !PARTICLES.has(t.toLowerCase()) || t === (tokens[0] as string));
  const words = significant.filter((t, i) => !(INITIAL.test(t) && i > 0 && i < significant.length - 1));
  if (words.length < 2 || words.length > 4) return { ok: false, reason: REJECT_NAME.words };
  if (!words.every((t) => NAME_TOKEN.test(t))) return { ok: false, reason: REJECT_NAME.surname };

  const first = words[0] as string;
  const last = words[words.length - 1] as string;
  if (last.replace(/[^\p{L}]/gu, '').length < 2 || INITIAL.test(last)) return { ok: false, reason: REJECT_NAME.surname };
  if (junkReason(tokens, ctx)) return { ok: false, reason: REJECT_NAME.junk };
  if (!isFirstName(first, ctx.firstNames ?? loadFirstNames())) return { ok: false, reason: REJECT_NAME.firstName };
  return { ok: true, name: tokens.join(' '), first, last };
}

/** A lone first name ("Hi, I'm Mike - owner"): valid only as a low-confidence needs_review value. */
export function validateFirstNameOnly(raw: string, ctx: OwnerNameContext): NameVerdict {
  const tokens = nameTokens(raw);
  if (tokens.length !== 1) return { ok: false, reason: REJECT_NAME.words };
  const t = tokens[0] as string;
  if (ROLE_WORDS.has(foldName(t))) return { ok: false, reason: REJECT_NAME.role };
  if (!NAME_TOKEN.test(t) || t.length < 2) return { ok: false, reason: REJECT_NAME.surname };
  if (junkReason([t], ctx)) return { ok: false, reason: REJECT_NAME.junk };
  if (!isFirstName(t, ctx.firstNames ?? loadFirstNames())) return { ok: false, reason: REJECT_NAME.firstName };
  return { ok: true, name: t, first: t, last: null };
}
