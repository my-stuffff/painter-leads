const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'esq', 'sr', 'jr', 'ii', 'iii', 'iv']);

/** Surnames where "Mac" is a real prefix; "Mac" is NOT split generically (Machado, Macias, Mack). */
const MAC_PREFIX_SURNAMES = new Set([
  'MACARTHUR',
  'MACDONALD',
  'MACDOUGALL',
  'MACGREGOR',
  'MACKENZIE',
  'MACLEOD',
  'MACMILLAN',
  'MACNEIL',
  'MACPHERSON',
]);

const SUFFIX_CASE: Record<string, string> = { II: 'II', III: 'III', IV: 'IV', JR: 'Jr', SR: 'Sr' };

function foldDiacritics(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '');
}

function capWord(word: string): string {
  const upper = word.toUpperCase();
  if (SUFFIX_CASE[upper] && word.length <= 3) return SUFFIX_CASE[upper] as string;
  // Hyphenated names: each part is cased on its own.
  if (word.includes('-')) return word.split('-').map(capWord).join('-');
  const lower = word.toLowerCase();
  // O'Brien, D'Angelo, L'Heureux
  const apos = /^([a-z])'(.+)$/.exec(lower);
  if (apos) return `${(apos[1] as string).toUpperCase()}'${capWord(apos[2] as string)}`;
  if (/^mc[a-z]{3,}$/.test(lower)) return `Mc${lower.charAt(2).toUpperCase()}${lower.slice(3)}`;
  if (MAC_PREFIX_SURNAMES.has(upper)) return `Mac${lower.charAt(3).toUpperCase()}${lower.slice(4)}`;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Title-cases an ALL-CAPS (or all-lowercase) name, Mc / O' / hyphen aware. A name that already has
 * mixed case is left alone (only whitespace is collapsed): never re-case what a person wrote.
 */
export function titleCaseName(s: string): string {
  const trimmed = s.trim().replace(/\s+/g, ' ');
  const hasUpper = /\p{Lu}/u.test(trimmed);
  const hasLower = /\p{Ll}/u.test(trimmed);
  if (hasUpper && hasLower) return trimmed;
  return trimmed
    .split(' ')
    .map((w) => (w.length === 1 ? w.toUpperCase() : capWord(w)))
    .join(' ');
}

/**
 * Registry names are "LAST FIRST MIDDLE" (CSLB fixed-width: parts separated by 2+ spaces). Also
 * accepts "LAST, FIRST MIDDLE". display = "First Last" (D-19), full = "First Middle Last".
 */
export function splitLastFirstMiddle(raw: string): {
  first: string;
  middle: string | null;
  last: string;
  display: string;
  full: string;
} {
  const text = raw.trim();
  let last = '';
  let first = '';
  let middleParts: string[] = [];

  if (text.includes(',')) {
    const [l = '', rest = ''] = text.split(',', 2);
    last = l.trim();
    const toks = rest.trim().split(/\s+/).filter(Boolean);
    first = toks[0] ?? '';
    middleParts = toks.slice(1);
  } else if (/\s{2,}/.test(text)) {
    const parts = text.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
    last = parts[0] ?? '';
    first = parts[1] ?? '';
    middleParts = parts.slice(2);
  } else {
    const toks = text.split(/\s+/).filter(Boolean);
    last = toks[0] ?? '';
    first = toks[1] ?? '';
    middleParts = toks.slice(2);
  }

  const cased = {
    first: titleCaseName(first),
    last: titleCaseName(last),
    middle: middleParts.length > 0 ? titleCaseName(middleParts.join(' ')) : null,
  };
  const display = [cased.first, cased.last].filter(Boolean).join(' ');
  const full = [cased.first, cased.middle, cased.last].filter(Boolean).join(' ');
  return { first: cased.first, middle: cased.middle, last: cased.last, display, full };
}

function nameTokens(name: string): string[] {
  return foldDiacritics(name)
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9 -]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !HONORIFICS.has(t));
}

/**
 * Comparison key for person names: casefolded, diacritics folded, honorifics and middle initials
 * dropped ("Mr. John A. Catapano" and "JOHN CATAPANO" both give "john catapano").
 */
export function personNameKey(name: string): string {
  const tokens = nameTokens(name);
  const kept = tokens.filter((t, i) => !(t.length === 1 && i > 0 && i < tokens.length - 1));
  return kept.join(' ');
}

/** First + last token only: "John Albert Catapano" and "John Catapano" give the same key. */
export function personFirstLastKey(name: string): string {
  const tokens = nameTokens(name).filter((t) => t.length > 1);
  if (tokens.length < 2) return tokens.join(' ');
  return `${tokens[0]} ${tokens[tokens.length - 1]}`;
}
