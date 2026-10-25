import type { BlockSignal } from '@pp/core';
import type { PageSignals, PlaceSnapshot } from './driver/types';

/**
 * Page-level block check, in this order (research Pattern 3):
 * a /sorry/ redirect, then a reCAPTCHA, then the "unusual traffic" page. The phrase only counts when the page
 * has no results feed and no place panel — a normal page that mentions it is never a block. A 403/429
 * navigation status is also a block.
 */
export function detectBlock(signals: PageSignals, httpStatus?: number | null): BlockSignal | null {
  if (signals.landedUrl.includes('/sorry/')) return 'sorry';
  if (signals.hasRecaptcha) return 'captcha';
  if (!signals.hasFeed && !signals.hasPlacePanel && signals.bodyHasUnusualTraffic) return 'unusual_traffic';
  if (httpStatus === 403 || httpStatus === 429) return 'http_403';
  return null;
}

/**
 * Limited view = a loaded place page (it has a name heading) with NO review-count label and NO reviews tab.
 * Decided by structure only: the words "limited view" appear on complete pages too (PROBES §1).
 */
export function isLimitedView(place: Pick<PlaceSnapshot, 'h1' | 'reviewCountAria' | 'reviewsTabPresent'>): boolean {
  const hasHeading = typeof place.h1 === 'string' && place.h1.trim().length > 0;
  return hasHeading && !place.reviewCountAria && !place.reviewsTabPresent;
}

/** Signals that count as a stop-the-run block (daily_cap is a clean stop, not a block). */
export function isBlockSignal(signal: BlockSignal): boolean {
  return signal !== 'daily_cap';
}
