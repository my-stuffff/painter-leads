import type { CaptureStatus } from '@pp/core';

/** One parsed value with how it was captured and the exact page text it came from. */
export interface Captured<T> {
  value: T | null;
  status: CaptureStatus;
  /** The aria-label, card line or URL piece the value was read from (null when nothing was captured). */
  snippet: string | null;
}

export function captured<T>(value: T, snippet: string): Captured<T> {
  return { value, status: 'captured', snippet };
}

export function notCaptured<T>(status: Exclude<CaptureStatus, 'captured'>): Captured<T> {
  return { value: null, status, snippet: null };
}

/** Rating from an aria-label such as "4.8 stars" or "4.8 stars 1,083 Reviews": exactly the decimal shown. */
export function ratingFromAria(aria: string): number | null {
  const m = /(\d(?:\.\d+)?)\s*stars?\b/i.exec(aria);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Review count from an aria-label such as "1,083 Reviews" or "1 review": separators stripped, nothing else changed. */
export function reviewCountFromAria(aria: string): number | null {
  const m = /(\d[\d,]*)\s*reviews?\b/i.exec(aria);
  if (!m) return null;
  const n = Number((m[1] as string).replace(/,/g, ''));
  return Number.isInteger(n) ? n : null;
}

/** Unwraps Google's /url?q=… redirect and keeps only http(s) links. */
export function cleanWebsiteHref(href: string | null | undefined): string | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (/(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname === '/url') {
    const target = url.searchParams.get('q') ?? url.searchParams.get('url');
    if (!target) return null;
    try {
      url = new URL(target);
    } catch {
      return null;
    }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.toString();
}
