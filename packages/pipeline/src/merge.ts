import {
  normaliseBusinessName,
  registrableDomain,
  zip5,
  type Db,
  type EvidenceStore,
  type MergeResult,
  type PpConfig,
  type Stage,
  type MergeInput,
} from '@pp/core';
import { runListings, loadRun } from './data';
import { flagFranchise } from './franchise';
import { q, q1 } from './sql';

export interface MergeListing {
  id: number;
  placeId: string | null;
  name: string;
  phoneE164: string | null;
  websiteUrl: string | null;
  zip: string | null;
  companyId: number | null;
}

export type Rung = 'place_id' | 'phone' | 'domain' | 'name_zip';
const RUNG_ORDER: Rung[] = ['place_id', 'phone', 'domain', 'name_zip'];

export interface MergeGroup {
  /** Lowest listing id of the group. */
  survivor: number;
  members: number[];
  rung: Rung;
  franchise: boolean;
  franchiseBrand: string | null;
}

export interface MergePlan {
  groups: MergeGroup[];
  mergesByRung: Record<Rung, number>;
  /** group survivor -> survivor of the group it may duplicate (both stay). */
  possibleDuplicates: Map<number, number>;
}

interface Facts {
  l: MergeListing;
  domain: string | null;
  shared: boolean;
  nameNorm: string;
  zip: string | null;
  franchise: boolean;
  brand: string | null;
}

/**
 * D-26 merge ladder as a pure function of the listings (order independent: survivor = lowest listing id,
 * unions are transitive). Rungs: place id (identity), exact phone (only with the same non-shared domain or the same
 * normalised name; franchise locations need the same name AND ZIP), registrable domain (never a shared host or a
 * franchise listing), normalised name + ZIP. A phone match that is refused is recorded as a possible duplicate.
 */
export function planMerge(listings: MergeListing[], config: PpConfig): MergePlan {
  const facts: Facts[] = [...listings]
    .sort((a, b) => a.id - b.id)
    .map((l) => {
      const dom = l.websiteUrl ? registrableDomain(l.websiteUrl) : null;
      const f = flagFranchise(l.name, l.websiteUrl, config);
      return {
        l,
        domain: dom?.domain ?? null,
        shared: dom?.sharedHost ?? false,
        nameNorm: normaliseBusinessName(l.name).norm,
        zip: zip5(l.zip),
        franchise: f.franchise,
        brand: f.brand,
      };
    });

  const parent = new Map<number, number>();
  for (const f of facts) parent.set(f.l.id, f.l.id);
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c) as number;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const events: { a: number; rung: Rung }[] = [];
  const mergesByRung: Record<Rung, number> = { place_id: facts.length, phone: 0, domain: 0, name_zip: 0 };
  const union = (a: number, b: number, rung: Rung): boolean => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    const [lo, hi] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(hi, lo);
    mergesByRung[rung] += 1;
    events.push({ a: lo, rung });
    return true;
  };

  const groupBy = (key: (f: Facts) => string | null): Facts[][] => {
    const m = new Map<string, Facts[]>();
    for (const f of facts) {
      const k = key(f);
      if (k === null || k === '') continue;
      const list = m.get(k);
      if (list) list.push(f);
      else m.set(k, [f]);
    }
    return [...m.values()].filter((g) => g.length > 1);
  };

  // Rung 2: phone
  const refused: [number, number][] = [];
  const phoneOk = (a: Facts, b: Facts): boolean => {
    if (a.franchise || b.franchise) return a.nameNorm !== '' && a.nameNorm === b.nameNorm && a.zip !== null && a.zip === b.zip;
    const sameDomain = a.domain !== null && a.domain === b.domain && !a.shared && !b.shared;
    return sameDomain || (a.nameNorm !== '' && a.nameNorm === b.nameNorm);
  };
  for (const g of groupBy((f) => f.l.phoneE164)) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i] as Facts;
        const b = g[j] as Facts;
        if (find(a.l.id) === find(b.l.id)) continue;
        if (phoneOk(a, b)) union(a.l.id, b.l.id, 'phone');
        else refused.push([a.l.id, b.l.id]);
      }
    }
  }

  // Rung 3: registrable domain
  for (const g of groupBy((f) => (f.domain && !f.shared && !f.franchise ? f.domain : null))) {
    for (let i = 1; i < g.length; i++) union((g[0] as Facts).l.id, (g[i] as Facts).l.id, 'domain');
  }

  // Rung 4: normalised name + ZIP
  for (const g of groupBy((f) => (f.nameNorm && f.zip ? `${f.nameNorm}|${f.zip}` : null))) {
    for (let i = 1; i < g.length; i++) union((g[0] as Facts).l.id, (g[i] as Facts).l.id, 'name_zip');
  }

  const byRoot = new Map<number, Facts[]>();
  for (const f of facts) {
    const r = find(f.l.id);
    const list = byRoot.get(r);
    if (list) list.push(f);
    else byRoot.set(r, [f]);
  }
  const rungsOf = new Map<number, Set<Rung>>();
  for (const e of events) {
    const r = find(e.a);
    const s = rungsOf.get(r) ?? new Set<Rung>();
    s.add(e.rung);
    rungsOf.set(r, s);
  }

  const groups: MergeGroup[] = [...byRoot.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([survivor, members]) => {
      const rungs = rungsOf.get(survivor);
      const rung = rungs ? (RUNG_ORDER.find((r) => rungs.has(r)) as Rung) : 'place_id';
      const flagged = members.find((m) => m.franchise);
      return {
        survivor,
        members: members.map((m) => m.l.id),
        rung,
        franchise: flagged !== undefined,
        franchiseBrand: flagged?.brand ?? null,
      };
    });

  // Refused phone matches that are still in different groups: the higher survivor points at the lowest one.
  const possibleDuplicates = new Map<number, number>();
  for (const [a, b] of refused) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    const [lo, hi] = ra < rb ? [ra, rb] : [rb, ra];
    const prior = possibleDuplicates.get(hi);
    if (prior === undefined || lo < prior) possibleDuplicates.set(hi, lo);
  }

  return { groups, mergesByRung, possibleDuplicates };
}

/**
 * Recomputes the companies of a run from scratch and reconciles the ones that exist (idempotent). Evidence is
 * re-pointed to the surviving company; a company that no longer has a listing is absorbed.
 */
export async function mergeRun(
  db: Db,
  evidence: EvidenceStore,
  config: PpConfig,
  runId: number,
): Promise<MergeResult> {
  const run = await loadRun(db, runId);
  const listings = await runListings(db, runId);
  const plan = planMerge(
    listings.map((l) => ({
      id: l.id,
      placeId: l.placeId,
      name: l.name,
      phoneE164: l.phoneE164,
      websiteUrl: l.websiteUrl,
      zip: l.zip,
      companyId: l.companyId,
    })),
    config,
  );
  const byId = new Map(listings.map((l) => [l.id, l] as const));
  const companyOfSurvivor = new Map<number, number>();

  for (const g of plan.groups) {
    const survivorListing = byId.get(g.survivor);
    if (!survivorListing) continue;
    const existing = [...new Set(g.members.map((m) => byId.get(m)?.companyId).filter((c): c is number => c != null))].sort(
      (a, b) => a - b,
    );
    let target = survivorListing.companyId ?? existing[0] ?? null;
    if (target === null) {
      const created = await q1<{ id: number }>(
        db,
        `INSERT INTO companies (run_id, area_id, state, display_name, primary_listing_id, merge_rung, franchise, franchise_brand)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [runId, run.areaId, run.state, survivorListing.name, g.survivor, g.rung, g.franchise, g.franchiseBrand],
      );
      if (!created) throw new Error('could not create a company');
      target = created.id;
    } else {
      await q(
        db,
        `UPDATE companies SET display_name = $2, primary_listing_id = $3, merge_rung = $4, franchise = $5,
           franchise_brand = $6, area_id = COALESCE(area_id, $7), state = COALESCE(state, $8), updated_at = now()
         WHERE id = $1`,
        [target, survivorListing.name, g.survivor, g.rung, g.franchise, g.franchiseBrand, run.areaId, run.state],
      );
    }
    companyOfSurvivor.set(g.survivor, target);

    await q(db, `UPDATE listings SET company_id = $1 WHERE id = ANY($2::int[])`, [target, g.members]);
    for (const m of g.members) await evidence.setCompany(m, target);

    for (const old of existing) {
      if (old === target) continue;
      await q(db, `UPDATE evidence SET company_id = $1 WHERE company_id = $2`, [target, old]);
      await q(
        db,
        `DELETE FROM registry_matches rm WHERE rm.company_id = $2 AND EXISTS
           (SELECT 1 FROM registry_matches t WHERE t.company_id = $1 AND t.registry_record_id = rm.registry_record_id)`,
        [target, old],
      );
      await q(db, `UPDATE registry_matches SET company_id = $1 WHERE company_id = $2`, [target, old]);
      await q(db, `UPDATE companies SET possible_duplicate_of = $1 WHERE possible_duplicate_of = $2`, [target, old]);
      await q(
        db,
        `DELETE FROM companies WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM listings WHERE company_id = $1)
           AND NOT EXISTS (SELECT 1 FROM accuracy_samples WHERE company_id = $1)`,
        [old],
      );
    }
  }

  const companyIds = [...companyOfSurvivor.values()];
  if (companyIds.length > 0) {
    await q(db, `UPDATE companies SET possible_duplicate_of = NULL WHERE id = ANY($1::int[])`, [companyIds]);
  }
  for (const [from, to] of plan.possibleDuplicates) {
    const a = companyOfSurvivor.get(from);
    const b = companyOfSurvivor.get(to);
    if (a !== undefined && b !== undefined) {
      await q(db, `UPDATE companies SET possible_duplicate_of = $2 WHERE id = $1`, [a, b]);
    }
  }

  return {
    companies: plan.groups.length,
    mergesByRung: plan.mergesByRung,
    possibleDuplicates: plan.possibleDuplicates.size,
  };
}

export const mergeStage: Stage<MergeInput, MergeResult> = {
  name: 'merge',
  async run(ctx, input) {
    return mergeRun(ctx.db, ctx.evidence, ctx.config, input.runId);
  },
};
