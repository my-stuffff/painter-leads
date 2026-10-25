import { foldName } from '../owners/names';

export type EmailKind = 'personal' | 'role' | 'other';

export const ROLE_LOCALS: readonly string[] = ['info', 'office', 'contact', 'hello', 'admin', 'estimates', 'sales', 'service', 'team', 'mail'];

const KIND_RANK: Record<EmailKind, number> = { personal: 0, role: 1, other: 2 };

const letters = (s: string): string => foldName(s).replace(/[^a-z]/g, '');

/** Local parts a person's address is expected to take: first, last, first initial + last, first + last. */
function personalLocals(fullName: string): Set<string> {
  const parts = fullName.trim().split(/\s+/).filter((t) => letters(t).length > 0);
  const out = new Set<string>();
  if (parts.length < 2) return out;
  const first = letters(parts[0] as string);
  const last = letters(parts[parts.length - 1] as string);
  if (first.length >= 2) out.add(first);
  if (last.length >= 2) out.add(last);
  if (first.length >= 1 && last.length >= 2) {
    out.add(`${first.charAt(0)}${last}`);
    out.add(`${first}${last}`);
  }
  return out;
}

/**
 * personal: the local part matches an accepted owner's first name, last name, first initial + last
 * name or first + last name (dots, dashes and digits ignored); role: info / office / contact / ...;
 * other: everything else.
 */
export function emailKind(address: string, ownerNames: readonly string[] = []): EmailKind {
  const local = address.slice(0, address.lastIndexOf('@')).toLowerCase();
  const compact = letters(local);
  for (const n of ownerNames) if (compact.length > 0 && personalLocals(n).has(compact)) return 'personal';
  return ROLE_LOCALS.includes(local) ? 'role' : 'other';
}

/** Stable order: personal > role > other, then the order the address was first seen, then alphabetical. */
export function rankEmails<T extends { address: string; kind: EmailKind; firstSeen: number }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.firstSeen - b.firstSeen || a.address.localeCompare(b.address),
  );
}
