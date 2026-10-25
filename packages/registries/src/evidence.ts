import { normaliseValue, type EvidenceDraft, type EvidenceStore } from '@pp/core';

export const EXTRACTOR_VERSION = '1';

/** A registry value's provenance: where it came from, when, and the line it was read from. */
export interface Provenance {
  companyId: number;
  registryRecordId: number | null;
  sourceType: EvidenceDraft['sourceType'];
  sourceUrl: string;
  capturedAt: Date;
  extractor: string;
  pageSha256?: string | null;
}

export function makeDraft(
  p: Provenance,
  field: EvidenceDraft['field'],
  value: string,
  snippet: string,
  confidence: EvidenceDraft['confidence'] = 'high',
  attrs: Record<string, unknown> = {},
): EvidenceDraft {
  return {
    companyId: p.companyId,
    registryRecordId: p.registryRecordId,
    field,
    value,
    sourceType: p.sourceType,
    sourceUrl: p.sourceUrl,
    pageSha256: p.pageSha256 ?? null,
    capturedAt: p.capturedAt,
    snippet: clipSnippet(snippet),
    extractor: p.extractor,
    extractorVersion: EXTRACTOR_VERSION,
    confidence,
    attrs,
  };
}

/** Evidence snippets are 1..1000 characters (DB check). Never empty. */
export function clipSnippet(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '(empty)';
  return flat.length > 900 ? `${flat.slice(0, 897)}...` : flat;
}

/**
 * Records the drafts that this company does not already have (same field + source + normalised value), so a
 * re-run of the stage never piles up duplicates. Returns the ids of every row (new and pre-existing).
 */
export async function ensureEvidence(store: EvidenceStore, companyId: number, drafts: EvidenceDraft[]): Promise<number[]> {
  if (drafts.length === 0) return [];
  const existing = await store.listForCompany(companyId);
  const seen = new Map<string, number>();
  for (const r of existing) seen.set(`${r.field}|${r.sourceType}|${r.valueNorm}`, r.id);

  const ids: number[] = [];
  const fresh: EvidenceDraft[] = [];
  for (const d of drafts) {
    const key = `${d.field}|${d.sourceType}|${d.valueNorm ?? normaliseValue(d.field, d.value)}`;
    const prior = seen.get(key);
    if (prior !== undefined) {
      ids.push(prior);
    } else {
      seen.set(key, -1);
      fresh.push(d);
    }
  }
  ids.push(...(await store.recordMany(fresh)));
  return ids;
}
