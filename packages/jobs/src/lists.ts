import type { LeadList } from './contract';

/** A company name that says painting (the 28 Oct workbook rule). */
export const PAINTING_NAME = /paint|coat|finish|color|colour|brush|stain|wall|drywall/i;

/** Google categories that count as painting for the main list. */
export const PAINTING_CATEGORIES: ReadonlySet<string> = new Set(['Painter', 'Painting']);

/** The only exclusion reasons a "Likely fits" company may have, and how each is said on screen and in the files. */
export const LIKELY_REASON_TEXT: Readonly<Record<string, string>> = {
  'also commercial': 'Also does commercial work',
  'residential status unclear': "Couldn't confirm it does houses only",
};

export interface ListInput {
  qualified: boolean;
  reasons: readonly string[];
  name: string;
  /** The Google category the report shows (Category column). */
  category: string | null;
}

export interface ListPick {
  list: LeadList;
  /** Likely fits only: the plain-words reasons, joined with '; '. */
  whyNot: string | null;
}

/**
 * Which of the three lists a company goes in, or null for none:
 * painting = qualified, the name says painting and Google lists it as Painter / Painting;
 * check = qualified otherwise;
 * likely = not qualified, and every reason is "also commercial" or "residential status unclear".
 */
export function pickList(c: ListInput): ListPick | null {
  if (c.qualified) {
    const painting = PAINTING_NAME.test(c.name) && c.category !== null && PAINTING_CATEGORIES.has(c.category);
    return { list: painting ? 'painting' : 'check', whyNot: null };
  }
  if (c.reasons.length === 0 || !c.reasons.every((r) => r in LIKELY_REASON_TEXT)) return null;
  return { list: 'likely', whyNot: c.reasons.map((r) => LIKELY_REASON_TEXT[r]).join('; ') };
}

/** Key that says two rows are the same company: its Google profile link, else its company id. */
export function dedupeKey(profileUrl: string | null, companyId: number): string {
  const url = profileUrl?.trim();
  return url ? `url:${url}` : `company:${companyId}`;
}

/**
 * Keeps the first row of each key, in the order given (callers pass the cities in position order, so the first
 * city wins and a company already in an earlier list is not repeated).
 */
export function dedupe<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

const lower = (s: string | null | undefined): string => (s ?? '').toLowerCase();
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** State, then search city, then company (case-insensitive); company id breaks ties so two builds match row for row. */
export function compareRows(
  a: { state: string | null; searchCity: string; company: string; companyId: number },
  b: { state: string | null; searchCity: string; company: string; companyId: number },
): number {
  return (
    cmp(lower(a.state), lower(b.state)) ||
    cmp(lower(a.searchCity), lower(b.searchCity)) ||
    cmp(lower(a.company), lower(b.company)) ||
    a.companyId - b.companyId
  );
}
