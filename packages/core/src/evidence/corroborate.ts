import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { evidence } from '../db/schema';
import type { Field } from '../types';
import { REGISTRY_SOURCE_TYPES, SOURCE_FAMILY } from './families';
import { personFirstLastKey } from '../normalise/person-name';
import { toEvidenceRow, type EvidenceRow } from './store';

async function acceptedRows(db: DbOrTx, companyId: number, field: Field): Promise<EvidenceRow[]> {
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.companyId, companyId), eq(evidence.field, field), eq(evidence.status, 'accepted')))
    .orderBy(asc(evidence.id));
  return rows.map(toEvidenceRow);
}

/**
 * ENR-06 / D-22: accepted rows of one field with equal value_norm from at least two distinct
 * source families are raised to 'high' and linked to each other through corroborated_by.
 * Two pages of one website are one family and never corroborate each other.
 * Returns how many rows were raised or linked.
 */
export async function corroborate(db: DbOrTx, companyId: number, field: Field): Promise<number> {
  const rows = await acceptedRows(db, companyId, field);
  const groups = new Map<string, EvidenceRow[]>();
  for (const r of rows) {
    const g = groups.get(r.valueNorm);
    if (g) g.push(r);
    else groups.set(r.valueNorm, [r]);
  }

  let touched = 0;
  for (const group of groups.values()) {
    const families = new Set(group.map((r) => SOURCE_FAMILY[r.sourceType]));
    if (families.size < 2) continue;
    for (const r of group) {
      const own = SOURCE_FAMILY[r.sourceType];
      const links = group.filter((o) => SOURCE_FAMILY[o.sourceType] !== own).map((o) => o.id);
      await db
        .update(evidence)
        .set({ confidence: 'high', corroboratedBy: links })
        .where(eq(evidence.id, r.id));
      touched++;
    }
  }
  return touched;
}

export const REGISTRY_CONFLICT_REASON = 'conflicts with registry';

/**
 * D-18: when an accepted registry owner exists, every website owner_name that matches none of the
 * registry owners is rejected ('conflicts with registry'); a matching one is corroborated instead.
 * Returns how many website rows were rejected.
 */
export async function resolveOwnerConflicts(db: DbOrTx, companyId: number): Promise<number> {
  const owners = await acceptedRows(db, companyId, 'owner_name');
  const registry = owners.filter((r) => REGISTRY_SOURCE_TYPES.includes(r.sourceType));
  if (registry.length === 0) return 0;

  const registryKeys = new Set(registry.map((r) => personFirstLastKey(r.value)));
  const conflicting = owners.filter(
    (r) => r.sourceType === 'website' && !registryKeys.has(personFirstLastKey(r.value)),
  );
  if (conflicting.length > 0) {
    await db
      .update(evidence)
      .set({ status: 'rejected', rejectReason: REGISTRY_CONFLICT_REASON })
      .where(
        inArray(
          evidence.id,
          conflicting.map((r) => r.id),
        ),
      );
  }
  await corroborate(db, companyId, 'owner_name');
  return conflicting.length;
}
