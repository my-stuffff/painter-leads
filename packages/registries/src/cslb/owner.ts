import { titleCaseName } from '@pp/core';
import type { RegistryPerson } from '../records';

export interface SoleOwnerName {
  first: string;
  middle: string | null;
  last: string;
  /** "First Last" (D-19). */
  display: string;
  /** "First Middle Last". */
  full: string;
  /** Source excerpt for the snippet. */
  raw: string;
}

const PERSON_TOKEN = /^[A-Z]+(?:['’-][A-Z]+)*$/;

function nameTokens(s: string | undefined | null): string[] {
  return (s ?? '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * A Sole Owner licence's person name from the master file. The licence name of a sole owner is often a
 * trade name ("FAUSTINO FINISHING PAINTING"), so a name is read ONLY when the file itself shows the
 * person form twice: `FullBusinessName` (FIRST MIDDLE LAST) and another name field in LAST FIRST MIDDLE
 * order, optionally followed by the same trade words ("ESPARZA VICENTE PAINTING" / "VICENTE ESPARZA
 * PAINTING"). Anything else gives null: a blank is better than a guessed name (core value).
 */
export function soleOwnerFromMasterRow(row: {
  BusinessName?: string;
  'BUS-NAME-2'?: string;
  FullBusinessName?: string;
}): SoleOwnerName | null {
  const full = nameTokens(row.FullBusinessName);
  if (full.length < 2) return null;

  for (const otherRaw of [row.BusinessName, row['BUS-NAME-2']]) {
    const other = nameTokens(otherRaw);
    if (other.length !== full.length) continue;
    // Longest common trailing run = the shared trade words.
    let k = 0;
    while (k < full.length - 2 && full[full.length - 1 - k] === other[other.length - 1 - k]) k++;
    const a = full.slice(0, full.length - k);
    const b = other.slice(0, other.length - k);
    if (a.length < 2 || a.length > 4 || a.length !== b.length) continue;
    const rotated = [a[a.length - 1] as string, ...a.slice(0, -1)];
    if (!rotated.every((t, i) => t === b[i])) continue;
    if (!a.every((t) => PERSON_TOKEN.test(t))) continue;
    const first = a[0] as string;
    const last = a[a.length - 1] as string;
    if (first.length < 2 || last.length < 2) continue;
    if (/'S$/.test(last) || /'S$/.test(first)) continue;
    const middleTokens = a.slice(1, -1);
    const firstCased = titleCaseName(first);
    const lastCased = titleCaseName(last);
    const middle = middleTokens.length > 0 ? titleCaseName(middleTokens.join(' ')) : null;
    return {
      first: firstCased,
      middle,
      last: lastCased,
      display: `${firstCased} ${lastCased}`,
      full: [firstCased, middle, lastCased].filter(Boolean).join(' '),
      raw: `FullBusinessName=${row.FullBusinessName}; ${otherRaw === row.BusinessName ? 'BusinessName' : 'BUS-NAME-2'}=${otherRaw}`,
    };
  }
  return null;
}

/**
 * D-19 owner priority: CEO/President > Owner/Sole Owner > RMO > Officer > LLC Member/Manager > General
 * Partner. Returns null for titles that are not owner-like (RME, Qualifying Partner, Deceased ...).
 */
export function roleRank(title: string | null | undefined): number | null {
  const t = (title ?? '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (t.length === 0 || /DECEASED/.test(t)) return null;
  if (/VICE[ -]?PRES|\bV\.?P\.?\b/.test(t)) return 4;
  if (/\bCEO\b|PRESIDENT/.test(t)) return 1;
  if (/SOLE OWNER|^OWNER\b|\bOWNER$/.test(t)) return 2;
  if (/\bRMO\b|RESPONSIBLE MANAGING OFFICER/.test(t)) return 3;
  if (/\bOFFICER\b|SECRETARY|TREASURER|\bCFO\b|\bCOO\b/.test(t)) return 4;
  if (/LLC MEMBER|MANAGING MEMBER|\bMEMBER\b|\bMANAGER\b/.test(t)) return 5;
  if (/GENERAL PARTNER/.test(t)) return 6;
  return null;
}

/** The person to show as owner among a licence's registry_people rows, or null. Dissociated people never count. */
export function pickCslbOwner(people: RegistryPerson[]): RegistryPerson | null {
  const current = people
    .filter((p) => p.dissociatedOn === null && p.fullName && p.fullName.trim().length > 0)
    .map((p) => ({ p, rank: p.roleRank ?? roleRank(p.title) }))
    .filter((x): x is { p: RegistryPerson; rank: number } => x.rank !== null);
  if (current.length === 0) return null;
  current.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.p.associatedOn ?? '9999-12-31').localeCompare(b.p.associatedOn ?? '9999-12-31') ||
      a.p.id - b.p.id,
  );
  return (current[0] as { p: RegistryPerson }).p;
}
