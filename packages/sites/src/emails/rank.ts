export type EmailKind = 'personal' | 'role' | 'other';

export const ROLE_LOCALS: readonly string[] = ['info', 'office', 'contact', 'hello', 'admin', 'estimates', 'sales', 'service', 'team', 'mail'];

const KIND_RANK: Record<EmailKind, number> = { personal: 0, role: 1, other: 2 };

export function emailKind(address: string): EmailKind {
  const local = address.slice(0, address.lastIndexOf('@')).toLowerCase();
  return ROLE_LOCALS.includes(local) ? 'role' : 'other';
}

/** Stable order: personal > role > other, then the order the address was first seen, then alphabetical. */
export function rankEmails<T extends { address: string; kind: EmailKind; firstSeen: number }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.firstSeen - b.firstSeen || a.address.localeCompare(b.address),
  );
}
