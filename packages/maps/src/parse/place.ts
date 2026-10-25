import { toE164 } from '@pp/core';
import { isLimitedView } from '../blocks';
import type { PlaceSnapshot } from '../driver/types';
import { captured, cleanWebsiteHref, notCaptured, ratingFromAria, reviewCountFromAria, type Captured } from './field';
import { parsePlaceUrl, profileLink, type ParsedPlaceUrl } from './url';

export interface ParsedAddress {
  /** The address exactly as shown (after the "Address: " prefix), ZIP+4 included. */
  full: Captured<string>;
  street: string | null;
  city: string | null;
  state: string | null;
  /** Five digits; a ZIP+4 is reduced. */
  zip: string | null;
}

export interface ParsedPlace {
  /** The page has a name heading, i.e. it is a place page that loaded. */
  loaded: boolean;
  limitedView: boolean;
  name: string | null;
  placeId: string | null;
  cid: string | null;
  profileUrl: string;
  url: ParsedPlaceUrl;
  lat: Captured<number>;
  lng: Captured<number>;
  phone: Captured<string>;
  website: Captured<string>;
  address: ParsedAddress;
  rating: Captured<number>;
  reviewCount: Captured<number>;
  categories: Captured<string[]>;
  permanentlyClosed: Captured<boolean>;
}

const ADDRESS_RE = /^(.*),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/;
const CITY_ONLY_RE = /^([^,]+),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/;
const STATUS_RE = /^(open|closed|temporarily closed)\b/i;

function nfc(s: string): string {
  return s.normalize('NFC').trim();
}

export function parseAddress(aria: string | null): ParsedAddress {
  if (!aria || aria.trim().length === 0) {
    return { full: notCaptured('not_shown'), street: null, city: null, state: null, zip: null };
  }
  const full = nfc(aria.replace(/^\s*address:\s*/i, ''));
  if (full.length === 0) return { full: notCaptured('not_shown'), street: null, city: null, state: null, zip: null };
  const m = ADDRESS_RE.exec(full);
  if (m) {
    return {
      full: captured(full, aria.trim()),
      street: nfc(m[1] as string),
      city: nfc(m[2] as string),
      state: m[3] as string,
      zip: m[4] as string,
    };
  }
  const c = CITY_ONLY_RE.exec(full);
  if (c) {
    return {
      full: captured(full, aria.trim()),
      street: null,
      city: nfc(c[1] as string),
      state: c[2] as string,
      zip: c[3] as string,
    };
  }
  // Shown but not in the expected shape: keep the text, leave the parts empty.
  return { full: captured(full, aria.trim()), street: null, city: null, state: null, zip: null };
}

/** Reads one place page snapshot. Values the page did not show are NULL with a status, never 0. */
export function parsePlace(snapshot: PlaceSnapshot): ParsedPlace {
  const url = parsePlaceUrl(snapshot.url);
  const h1 = snapshot.h1 ? nfc(snapshot.h1) : '';
  const loaded = h1.length > 0;
  const limitedView = isLimitedView(snapshot);
  const missing = loaded ? 'not_shown' : 'parse_failed';

  const out: ParsedPlace = {
    loaded,
    limitedView,
    name: loaded ? h1 : null,
    placeId: url.placeId,
    cid: url.cid,
    profileUrl: profileLink(snapshot.url, url),
    url,
    // A place opened by its CID link keeps that link as its URL (no !3d/!4d): not read from this page, the card has them.
    lat: url.lat !== null && url.latText ? captured(url.lat, url.fragments.lat ?? `!3d${url.latText}`) : notCaptured('pending'),
    lng: url.lng !== null && url.lngText ? captured(url.lng, url.fragments.lng ?? `!4d${url.lngText}`) : notCaptured('pending'),
    phone: notCaptured(missing),
    website: notCaptured(missing),
    address: parseAddress(snapshot.addressAria),
    rating: notCaptured(missing),
    reviewCount: notCaptured(missing),
    categories: notCaptured(missing),
    permanentlyClosed: notCaptured(missing),
  };
  if (!loaded) out.address = { ...out.address, full: notCaptured('parse_failed') };

  // Phone: the data-item-id carries the E.164 number; the display text is never the identity.
  const itemId = snapshot.phoneItemId?.trim() ?? '';
  const phoneM = /^phone:tel:(.+)$/.exec(itemId);
  if (phoneM) {
    const e164 = toE164(phoneM[1] as string);
    out.phone = e164 ? captured(e164, snapshot.phoneAria?.trim() || itemId) : notCaptured('parse_failed');
  }

  const website = cleanWebsiteHref(snapshot.authorityHref);
  if (website) out.website = captured(website, `Website: ${website}`);
  else if (snapshot.authorityHref) out.website = notCaptured('parse_failed');

  if (limitedView) {
    out.rating = notCaptured('limited_view');
    out.reviewCount = notCaptured('limited_view');
  } else if (loaded) {
    const ratingAria = snapshot.ratingAria?.trim() ?? '';
    const rating = ratingAria ? ratingFromAria(ratingAria) : null;
    if (rating !== null) out.rating = captured(rating, ratingAria);
    else if (ratingAria) out.rating = notCaptured('parse_failed');
    const countAria = snapshot.reviewCountAria?.trim() ?? '';
    const count = countAria ? reviewCountFromAria(countAria) : null;
    if (count !== null) out.reviewCount = captured(count, countAria);
    else if (countAria) out.reviewCount = notCaptured('parse_failed');
  }

  const cats: string[] = [];
  for (const t of snapshot.categoryTexts ?? []) {
    const c = nfc(t);
    if (c.length > 0 && !cats.includes(c)) cats.push(c);
  }
  if (cats.length > 0) out.categories = captured(cats, cats.join(' · '));

  const closedText = snapshot.closedText?.trim() ?? '';
  if (/permanently closed/i.test(closedText)) out.permanentlyClosed = captured(true, closedText);
  else if (STATUS_RE.test(closedText)) out.permanentlyClosed = captured(false, closedText);

  return out;
}
