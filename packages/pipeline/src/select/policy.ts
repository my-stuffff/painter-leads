import {
  selectBest,
  type Confidence,
  type EvidenceRow,
  type Field,
  type PpConfig,
  type SelectionPolicy,
  type SourceType,
} from '@pp/core';

const REGISTRY_FIRST: SourceType[] = [
  'cslb_master',
  'cslb_personnel',
  'cslb_lookup',
  'nj_hic_detail',
  'tx_comptroller',
  'tx_open_data',
  'nj_principal_search',
];

/**
 * What the report shows. Phone: only the Google listing phone (D-23). Owner: registry families, then BBB,
 * then the company's own website (D-18/D-19/D-21). Email: ranked by attrs.kind in selectEmail.
 * minConfidence here is the default; policyFor() reads the real value from config.report.
 */
export const PIPELINE_POLICY: SelectionPolicy = {
  minConfidence: 'medium',
  sourcePriority: {
    phone: ['google_maps'],
    website: ['google_maps', 'website', 'bbb'],
    owner_name: [...REGISTRY_FIRST, 'bbb', 'website'],
    email: ['website', 'nj_hic_roster'],
  },
};

export function policyFor(config: PpConfig): SelectionPolicy {
  return { ...PIPELINE_POLICY, minConfidence: config.report.minConfidence };
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** Only accepted rows can be shown (needs_review and rejected never are). */
export function acceptedRows(rows: EvidenceRow[]): EvidenceRow[] {
  return rows.filter((r) => r.status === 'accepted');
}

function eligible(rows: EvidenceRow[], field: Field, policy: SelectionPolicy): EvidenceRow[] {
  const min = CONFIDENCE_RANK[policy.minConfidence];
  return acceptedRows(rows).filter((r) => r.field === field && CONFIDENCE_RANK[r.confidence] >= min);
}

/** Core selectBest over accepted rows: confidence, then the policy's source priority, then earliest capture. */
export function selectField(rows: EvidenceRow[], field: Field, policy: SelectionPolicy): EvidenceRow | null {
  return selectBest(acceptedRows(rows), field, policy);
}

/**
 * The most recent eligible row (the place-page capture replaces the earlier card capture of the same value).
 * Optionally limited to some source types.
 */
export function selectLatest(
  rows: EvidenceRow[],
  field: Field,
  policy: SelectionPolicy,
  sourceTypes?: SourceType[],
): EvidenceRow | null {
  const candidates = eligible(rows, field, policy).filter((r) => !sourceTypes || sourceTypes.includes(r.sourceType));
  candidates.sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime() || b.id - a.id);
  return candidates[0] ?? null;
}

/** D-23: the shown phone is the Google listing phone; other phones stay evidence only. */
export function selectPhone(rows: EvidenceRow[], policy: SelectionPolicy): EvidenceRow | null {
  return selectLatest(rows, 'phone', policy, ['google_maps']);
}

const EMAIL_KIND_RANK: Record<string, number> = { personal: 0, role: 1, other: 2 };

/** Email: personal before role before other, then confidence, source priority, first captured. */
export function selectEmail(rows: EvidenceRow[], policy: SelectionPolicy): EvidenceRow | null {
  const priority = policy.sourcePriority.email ?? [];
  const priorityOf = (t: SourceType): number => {
    const i = priority.indexOf(t);
    return i === -1 ? priority.length : i;
  };
  const kindRank = (r: EvidenceRow): number => EMAIL_KIND_RANK[String(r.attrs.kind ?? '')] ?? 2;
  const candidates = eligible(rows, 'email', policy);
  candidates.sort(
    (a, b) =>
      kindRank(a) - kindRank(b) ||
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      priorityOf(a.sourceType) - priorityOf(b.sourceType) ||
      a.capturedAt.getTime() - b.capturedAt.getTime() ||
      a.id - b.id,
  );
  return candidates[0] ?? null;
}

/**
 * Every accepted row that backs the chosen value (same field, same normalised value), the chosen row
 * first. Rows of one source and URL count once (a card capture and a place capture of one profile).
 */
export function rowsBehind(rows: EvidenceRow[], chosen: EvidenceRow): EvidenceRow[] {
  const same = acceptedRows(rows)
    .filter((r) => r.field === chosen.field && r.valueNorm === chosen.valueNorm && r.id !== chosen.id)
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime() || a.id - b.id);
  const out: EvidenceRow[] = [];
  const seen = new Set<string>();
  for (const r of [chosen, ...same]) {
    const key = `${r.sourceType}|${r.sourceUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
