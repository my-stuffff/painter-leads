import { registrableDomain, type Db, type PpConfig, type Stage, type SiteFinalizeInput, type SiteFinalizeResult } from '@pp/core';

export const TEMPLATE_REJECT_REASON = 'template name';

export interface OwnerRow {
  id: number;
  valueNorm: string;
  sourceUrl: string;
  franchiseBrand: string | null;
}

function siteKey(url: string): string {
  const r = registrableDomain(url);
  return r.sharedHost ? r.host : (r.domain ?? r.host);
}

/**
 * D-18 / R3: ids of owner rows whose person is claimed as owner on 2 or more different registrable
 * domains (a theme's demo person). A group that is one franchise brand (several locations of
 * CertaPro, say) is left alone.
 */
export function templateNameIds(rows: OwnerRow[], franchiseDomains: readonly string[]): number[] {
  const groups = new Map<string, OwnerRow[]>();
  for (const r of rows) {
    if (!r.valueNorm) continue;
    const g = groups.get(r.valueNorm);
    if (g) g.push(r);
    else groups.set(r.valueNorm, [r]);
  }
  const ids: number[] = [];
  for (const g of groups.values()) {
    const domains = new Set(g.map((r) => siteKey(r.sourceUrl)));
    if (domains.size < 2) continue;
    const brands = g.map((r) => r.franchiseBrand ?? franchiseDomains.find((d) => siteKey(r.sourceUrl) === d) ?? null);
    if (brands.every((b) => b !== null && b === brands[0])) continue;
    ids.push(...g.map((r) => r.id));
  }
  return ids;
}

/** Rejects every template name in the run; returns how many evidence rows were rejected. */
export async function rejectTemplateNames(db: Db, runId: number, config: PpConfig): Promise<number> {
  const res = await db.$client.query<{ id: string; value_norm: string; source_url: string; franchise_brand: string | null }>(
    `SELECT e.id, e.value_norm, e.source_url, c.franchise_brand
       FROM evidence e JOIN companies c ON c.id = e.company_id
      WHERE c.run_id = $1 AND e.field = 'owner_name' AND e.source_type = 'website' AND e.status = 'accepted'
      ORDER BY e.id`,
    [runId],
  );
  const ids = templateNameIds(
    res.rows.map((r) => ({ id: Number(r.id), valueNorm: r.value_norm, sourceUrl: r.source_url, franchiseBrand: r.franchise_brand })),
    config.franchise.domains,
  );
  if (ids.length === 0) return 0;
  await db.$client.query(`UPDATE evidence SET status = 'rejected', reject_reason = $2 WHERE id = ANY($1::bigint[])`, [ids, TEMPLATE_REJECT_REASON]);
  return ids.length;
}

export const siteFinalizeStage: Stage<SiteFinalizeInput, SiteFinalizeResult> = {
  name: 'site-finalize',
  async run(ctx, input) {
    return { templateNamesRejected: await rejectTemplateNames(ctx.db, input.runId, ctx.config) };
  },
};
