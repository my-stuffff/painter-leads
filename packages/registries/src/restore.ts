import type { Db } from '@pp/core';
import { SUPERSEDED } from './evidence';

/** Every source whose evidence the registries stage writes (and `pilot reprocess` retires before it re-runs). */
export const REGISTRY_EVIDENCE_SOURCES = [
  'cslb_master',
  'cslb_personnel',
  'cslb_lookup',
  'nj_hic_roster',
  'nj_hic_detail',
  'nj_principal_search',
  'tx_open_data',
  'tx_comptroller',
  'bbb',
] as const;

export interface RestoreScope {
  /** Every company of this run … */
  runId?: number;
  /** … or just these companies (the reprocess calls it per company, right after the stage ran). */
  companyIds?: number[];
}

export interface RestoreResult {
  restored: number;
  companies: number;
  /** "source_type/field" -> rows put back */
  byKind: Record<string, number>;
}

/**
 * Puts back registry evidence that a reprocess retired ('superseded') and did not write again, so a lookup that could
 * not be made (offline cache miss, blocked, error) never turns an earlier accepted value into nothing. A row is
 * restored only when ALL of these hold:
 *  - it is from the newest capture of its registry record for that company (older generations stay history);
 *  - the company is still strongly matched to that very registry record (a match that no longer holds loses its values);
 *  - the company has no accepted row of that field from that source (a changed value was written again and wins;
 *    a value that was written again is not duplicated);
 *  - the source did not answer "no_match" this time (a page that shows no owner any more is an answer, not a failure);
 *  - a principal-search confirmation is only put back while it confirms the owner the HIC detail page shows now.
 * Idempotent: a second call restores nothing. Never deletes anything.
 */
export async function restoreSupersededRegistryEvidence(db: Db, scope: RestoreScope): Promise<RestoreResult> {
  if (scope.runId === undefined && !scope.companyIds) throw new Error('restore needs a run or a list of companies');
  const rows: { company_id: number; source_type: string; field: string }[] = [];
  // twice: a principal-search row is only put back once the detail owner it confirms is accepted again
  for (let pass = 0; pass < 2; pass++) {
    const res = await db.$client.query(
      `WITH latest AS (
       SELECT company_id, source_type, registry_record_id, max(captured_at) AS newest
         FROM evidence
        WHERE source_type = ANY($1::text[]) AND registry_record_id IS NOT NULL AND company_id IS NOT NULL
        GROUP BY company_id, source_type, registry_record_id
     )
     UPDATE evidence ev SET status = 'accepted', reject_reason = NULL
       FROM companies c, latest l
      WHERE c.id = ev.company_id
        AND l.company_id = ev.company_id AND l.source_type = ev.source_type AND l.registry_record_id = ev.registry_record_id
        AND ev.status = 'rejected' AND ev.reject_reason = $2
        AND ev.source_type = ANY($1::text[]) AND ev.captured_at = l.newest
        AND ($3::int IS NULL OR c.run_id = $3)
        AND ($4::int[] IS NULL OR ev.company_id = ANY($4))
        AND EXISTS (
          SELECT 1 FROM registry_matches m
           WHERE m.company_id = ev.company_id AND m.registry_record_id = ev.registry_record_id AND m.strength = 'strong')
        AND NOT EXISTS (
          SELECT 1 FROM evidence a
           WHERE a.company_id = ev.company_id AND a.field = ev.field AND a.source_type = ev.source_type AND a.status = 'accepted')
        AND COALESCE(c.registry_status ->> (CASE ev.source_type
              WHEN 'nj_hic_roster' THEN 'nj_hic'
              WHEN 'cslb_master' THEN 'cslb' WHEN 'cslb_personnel' THEN 'cslb' WHEN 'cslb_lookup' THEN 'cslb'
              ELSE ev.source_type END), '') <> 'no_match'
        AND (ev.source_type <> 'nj_principal_search' OR ev.field <> 'owner_name' OR EXISTS (
          SELECT 1 FROM evidence d
           WHERE d.company_id = ev.company_id AND d.field = 'owner_name' AND d.source_type = 'nj_hic_detail'
             AND d.status = 'accepted' AND d.value_norm = ev.value_norm))
      RETURNING ev.id, ev.company_id, ev.source_type, ev.field`,
      [[...REGISTRY_EVIDENCE_SOURCES], SUPERSEDED, scope.runId ?? null, scope.companyIds ?? null],
    );
    rows.push(...res.rows);
    if (res.rows.length === 0) break;
  }
  const byKind: Record<string, number> = {};
  for (const r of rows) byKind[`${r.source_type}/${r.field}`] = (byKind[`${r.source_type}/${r.field}`] ?? 0) + 1;
  return { restored: rows.length, companies: new Set(rows.map((r) => r.company_id)).size, byKind };
}
