import { toE164 } from '@pp/core';
import type { CardSnapshot } from '../driver/types';
import { captured, cleanWebsiteHref, notCaptured, ratingFromAria, reviewCountFromAria, type Captured } from './field';
import { parsePlaceUrl, profileLink, type ParsedPlaceUrl } from './url';

export interface ParsedCard {
  name: string | null;
  nameSnippet: string | null;
  placeId: string | null;
  cid: string | null;
  profileUrl: string;
  url: ParsedPlaceUrl;
  lat: Captured<number>;
  lng: Captured<number>;
  category: Captured<string>;
  street: Captured<string>;
  rating: Captured<number>;
  reviewCount: Captured<number>;
  phone: Captured<string>;
  website: Captured<string>;
  permanentlyClosed: Captured<boolean>;
  /** The card literally said "No reviews". Kept for audit; the count itself stays NULL (see README). */
  noReviewsText: boolean;
}

const RATING_LINE_RE = /^(\d(?:\.\d+)?)\s*\(\s*([\d,]+)\s*\)$/;
const NO_REVIEWS_RE = /^no reviews$/i;
const PHONE_RE = /\(\d{3}\)\s*\d{3}-\d{4}/;
const STATUS_LINE_RE = /^(open|closed|temporarily closed|permanently closed)\b/i;
const DISTANCE_RE = /^\d+(?:\.\d+)?\s*(?:mi|km|ft|m)\b/i;

function nfc(s: string): string {
  return s.normalize('NFC').trim();
}

/** Reads one results-list card. A value the card does not show is NULL with a status, never 0. */
export function parseCard(snapshot: CardSnapshot): ParsedCard {
  const url = parsePlaceUrl(snapshot.href);
  const lines = (snapshot.text ?? '').split('\n').map((l) => l.trim());
  const nameFromAria = snapshot.name ? nfc(snapshot.name) : '';
  const name = nameFromAria || nfc(lines.find((l) => l.length > 0) ?? '') || null;
  // Everything after the (repeated) name lines.
  const body = lines.filter((l) => l.length > 0 && l !== name && l !== snapshot.name?.trim());

  const result: ParsedCard = {
    name,
    nameSnippet: name ? (nameFromAria ? `${nameFromAria}` : name) : null,
    placeId: url.placeId,
    cid: url.cid,
    profileUrl: profileLink(snapshot.href, url),
    url,
    lat: url.lat !== null && url.latText ? captured(url.lat, url.fragments.lat ?? `!3d${url.latText}`) : notCaptured('not_on_card'),
    lng: url.lng !== null && url.lngText ? captured(url.lng, url.fragments.lng ?? `!4d${url.lngText}`) : notCaptured('not_on_card'),
    category: notCaptured('not_on_card'),
    street: notCaptured('not_on_card'),
    rating: notCaptured('not_on_card'),
    reviewCount: notCaptured('not_on_card'),
    phone: notCaptured('not_on_card'),
    website: notCaptured('not_on_card'),
    permanentlyClosed: notCaptured('not_on_card'),
    noReviewsText: false,
  };

  // Rating and review count: the star aria-label is the source of truth.
  const aria = snapshot.ratingAria?.trim() ?? '';
  if (aria) {
    const rating = ratingFromAria(aria);
    const count = reviewCountFromAria(aria);
    result.rating = rating !== null ? captured(rating, aria) : notCaptured('parse_failed');
    if (count !== null) {
      result.reviewCount = captured(count, aria);
    } else if (rating !== null) {
      // Rating shown without a count in the aria-label: try the "4.7(249)" line before giving up.
      const line = body.find((l) => RATING_LINE_RE.test(l));
      const m = line ? RATING_LINE_RE.exec(line) : null;
      result.reviewCount = m && line ? captured(Number((m[2] as string).replace(/,/g, '')), line) : notCaptured('not_on_card');
    } else {
      result.reviewCount = notCaptured('parse_failed');
    }
  }

  const noReviewsIdx = body.findIndex((l) => NO_REVIEWS_RE.test(l));
  result.noReviewsText = noReviewsIdx >= 0;
  const ratingIdx = body.findIndex((l) => RATING_LINE_RE.test(l) || NO_REVIEWS_RE.test(l));

  // "Category · street" is the line right after the rating line.
  const categoryLine = ratingIdx >= 0 ? body[ratingIdx + 1] : undefined;
  if (categoryLine && !STATUS_LINE_RE.test(categoryLine) && !PHONE_RE.test(categoryLine)) {
    const parts = categoryLine
      .split('·')
      .map((p) => nfc(p))
      .filter((p) => p.length > 0);
    const category = parts[0];
    if (category) result.category = captured(category, categoryLine);
    const street = parts.slice(1).find((p) => /^\d/.test(p) && !DISTANCE_RE.test(p));
    if (street) result.street = captured(street, categoryLine);
  }

  // Phone from the hours/phone line, normalised to E.164.
  const phoneLine = body.find((l) => PHONE_RE.test(l));
  if (phoneLine) {
    const m = PHONE_RE.exec(phoneLine);
    const e164 = m ? toE164(m[0]) : null;
    result.phone = e164 ? captured(e164, phoneLine) : notCaptured('parse_failed');
  }

  // Permanently closed: the card says so, or it shows an open/closed status line (so it is not).
  const closedLine = body.find((l) => /permanently closed/i.test(l));
  if (closedLine) {
    result.permanentlyClosed = captured(true, closedLine);
  } else {
    const statusLine = body.find((l) => STATUS_LINE_RE.test(l));
    if (statusLine) result.permanentlyClosed = captured(false, statusLine);
  }

  // Website button: link present = captured; button text without a readable link = parse_failed.
  const website = cleanWebsiteHref(snapshot.websiteHref);
  if (website) {
    result.website = captured(website, `Website: ${website}`);
  } else if (snapshot.websiteHref) {
    result.website = notCaptured('parse_failed');
  } else if (body.some((l) => /^(website|visit site)$/i.test(l)) && snapshot.websiteHref !== undefined) {
    result.website = notCaptured('parse_failed');
  }

  return result;
}
