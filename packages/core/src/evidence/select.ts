import type { Confidence, Field, SourceType } from '../types';
import type { EvidenceRow } from './store';

export interface SelectionPolicy {
  /** Rows below this confidence are never selected (they stay in the database as "needs review"). */
  minConfidence: Confidence;
  /** Per field, source types in priority order (earlier wins on a tie of status and confidence). */
  sourcePriority: Partial<Record<Field, SourceType[]>>;
}

export const DEFAULT_SELECTION_POLICY: SelectionPolicy = {
  minConfidence: 'medium',
  sourcePriority: {
    // D-23: the phone shown is the Google listing phone; the rest is extra evidence.
    phone: ['google_maps', 'website', 'bbb', 'cslb_master', 'cslb_lookup', 'tx_open_data'],
    // D-18/D-19/D-21: registers first, the company's own website last.
    owner_name: [
      'cslb_master',
      'cslb_personnel',
      'nj_hic_detail',
      'tx_comptroller',
      'bbb',
      'nj_principal_search',
      'website',
    ],
    // D-17: the company's own site, then the registrant's own submitted address.
    email: ['website', 'nj_hic_roster'],
  },
};

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };
const STATUS_RANK: Record<string, number> = { accepted: 2, needs_review: 1 };

/**
 * Deterministic best value for a field. Order: accepted before needs_review (rejected never),
 * high > medium > low, the policy's source priority, earliest captured_at, lowest id.
 */
export function selectBest(
  rows: EvidenceRow[],
  field: Field,
  policy: SelectionPolicy = DEFAULT_SELECTION_POLICY,
): EvidenceRow | null {
  const priority = policy.sourcePriority[field] ?? [];
  const priorityOf = (t: SourceType): number => {
    const i = priority.indexOf(t);
    return i === -1 ? priority.length : i;
  };
  const min = CONFIDENCE_RANK[policy.minConfidence];

  const candidates = rows.filter(
    (r) => r.field === field && r.status !== 'rejected' && CONFIDENCE_RANK[r.confidence] >= min,
  );
  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) =>
      (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0) ||
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      priorityOf(a.sourceType) - priorityOf(b.sourceType) ||
      a.capturedAt.getTime() - b.capturedAt.getTime() ||
      a.id - b.id,
  );
  return candidates[0] ?? null;
}
