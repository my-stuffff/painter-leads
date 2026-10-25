import type { PpConfig } from '@pp/core';

export type DriftConfig = PpConfig['accuracy']['drift'];

const EPS = 1e-9;

/**
 * D-38: a review count is correct when the live count is at least the captured one and has grown by no more than
 * max(reviewAbs, reviewPct of the captured count). Fewer reviews than captured is wrong.
 */
export function reviewCountOk(captured: number, live: number, drift: DriftConfig): boolean {
  if (live < captured) return false;
  return live - captured <= Math.max(drift.reviewAbs, drift.reviewPct * captured) + EPS;
}

/** D-38: a rating is correct when equal, or within ratingTol when the review count changed too. */
export function ratingOk(captured: number, live: number, reviewCountChanged: boolean, drift: DriftConfig): boolean {
  const diff = Math.abs(captured - live);
  if (diff < EPS) return true;
  return reviewCountChanged && diff <= drift.ratingTol + EPS;
}

export function isDriftOk(
  field: 'rating' | 'review_count',
  captured: number,
  live: number,
  ctx: { reviewCountChanged: boolean },
  drift: DriftConfig,
): boolean {
  return field === 'review_count' ? reviewCountOk(captured, live, drift) : ratingOk(captured, live, ctx.reviewCountChanged, drift);
}
