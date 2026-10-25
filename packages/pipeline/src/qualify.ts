import {
  EXCLUSION_REASON_ORDER,
  type Db,
  type EvidenceRow,
  type ExclusionReason,
  type PpConfig,
  type QualifyInput,
  type QualifyResult,
  type ResidentialLabel,
  type Stage,
} from '@pp/core';
import {
  evidenceByCompany,
  listingsByCompany,
  loadCompanies,
  runCompanyIds,
  type CompanyRow,
  type ListingRow,
} from './data';
import { policyFor, selectLatest } from './select/policy';
import { q } from './sql';

/** Everything qualification looks at, already reduced to plain values (NULL = not captured). */
export interface QualifyFacts {
  painterStatus: 'painter' | 'not_painter' | 'unknown';
  residentialStatus: ResidentialLabel | null;
  hasGoogleProfile: boolean;
  permanentlyClosed: boolean;
  inArea: boolean;
  rating: number | null;
  reviewCount: number | null;
}

/**
 * D-05 / QUAL-03 / QUAL-04. Pure: thresholds come only from config. Bounds are inclusive. A value that was not
 * captured is never "below minimum": it says 'not captured'. Reasons always come back in EXCLUSION_REASON_ORDER.
 * A company whose painter status is not 'painter' (a not-painter or an unrecognised category) never qualifies;
 * the residential rules are only judged for companies that are painters.
 */
export function qualify(facts: QualifyFacts, config: PpConfig): QualifyResult {
  const c = config.qualification;
  const found = new Set<ExclusionReason>();

  if (facts.painterStatus !== 'painter') found.add('not a painting contractor');

  if (facts.painterStatus === 'painter' && c.requireResidentialOnly) {
    if (facts.residentialStatus === 'residential_and_commercial') found.add('also commercial');
    else if (facts.residentialStatus === 'commercial_only') found.add('commercial only');
    else if (facts.residentialStatus !== 'residential_only') found.add('residential status unclear');
  }

  if (c.requireGoogleProfile && !facts.hasGoogleProfile) found.add('no Google profile');
  if (facts.permanentlyClosed) found.add('permanently closed');
  if (!facts.inArea) found.add('outside pilot area');

  if (facts.rating === null) found.add('rating not captured');
  else if (facts.rating < c.minRating) found.add('rating below minimum');

  if (facts.reviewCount === null) found.add('review count not captured');
  else if (facts.reviewCount < c.minReviews) found.add('review count below minimum');
  else if (facts.reviewCount > c.maxReviews) found.add('review count above maximum');

  const reasons = EXCLUSION_REASON_ORDER.filter((r) => found.has(r));
  return { qualified: reasons.length === 0, reasons };
}

function numberOrNull(row: EvidenceRow | null): number | null {
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

/** The facts for one company from its stored rows. Rating and review count are what the report shows (latest accepted capture). */
export function computeFacts(
  company: CompanyRow,
  listings: ListingRow[],
  evidence: EvidenceRow[],
  config: PpConfig,
): QualifyFacts {
  const policy = policyFor(config);
  const closedRow = selectLatest(evidence, 'permanently_closed', policy);
  return {
    painterStatus: company.painterStatus,
    residentialStatus: company.residentialStatus,
    hasGoogleProfile: listings.some((l) => l.profileUrl.trim().length > 0),
    permanentlyClosed: closedRow ? closedRow.value === 'true' : listings.some((l) => l.permanentlyClosed === true),
    // Only an explicit "no" excludes: a company the area step has not judged yet is not outside.
    inArea: company.inArea !== false,
    rating: numberOrNull(selectLatest(evidence, 'rating', policy)),
    reviewCount: numberOrNull(selectLatest(evidence, 'review_count', policy)),
  };
}

async function persist(db: Db, companyId: number, r: QualifyResult): Promise<void> {
  await q(db, `UPDATE companies SET qualified = $2, exclusion_reasons = $3::text[], updated_at = now() WHERE id = $1`, [
    companyId,
    r.qualified,
    r.reasons,
  ]);
}

/** Qualifies the given companies against the current config and stores the result on each company. */
export async function qualifyCompanies(db: Db, config: PpConfig, companyIds: number[]): Promise<Map<number, QualifyResult>> {
  const companies = await loadCompanies(db, companyIds);
  const listings = await listingsByCompany(db, companyIds);
  const evidence = await evidenceByCompany(db, companyIds);
  const out = new Map<number, QualifyResult>();
  for (const c of companies) {
    const result = qualify(computeFacts(c, listings.get(c.id) ?? [], evidence.get(c.id) ?? [], config), config);
    await persist(db, c.id, result);
    out.set(c.id, result);
  }
  return out;
}

export async function qualifyRun(db: Db, config: PpConfig, runId: number): Promise<Map<number, QualifyResult>> {
  return qualifyCompanies(db, config, await runCompanyIds(db, runId));
}

export const qualifyStage: Stage<QualifyInput, QualifyResult> = {
  name: 'qualify',
  async run(ctx, input) {
    const results = await qualifyCompanies(ctx.db, ctx.config, [input.companyId]);
    const r = results.get(input.companyId);
    if (!r) throw new Error(`Unknown company ${input.companyId}`);
    return r;
  },
};
