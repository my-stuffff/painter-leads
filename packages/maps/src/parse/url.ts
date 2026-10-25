export interface ParsedPlaceUrl {
  placeId: string | null;
  cidHex: string | null;
  /** Decimal CID: the second hex number in !1s0x…:0x… as a BigInt string. */
  cid: string | null;
  lat: number | null;
  lng: number | null;
  /** The coordinates exactly as written in the URL (every digit). */
  latText: string | null;
  lngText: string | null;
  /** The URL fragment each id came from, for the evidence snippet. */
  fragments: { placeId?: string; cid?: string; lat?: string; lng?: string };
}

const PLACE_ID_RE = /!19s([^!?&#/]+)/;
const CID_RE = /!1s(0x[0-9a-f]+):(0x[0-9a-f]+)/i;
const CID_QUERY_RE = /[?&]cid=(\d+)/;
const LAT_RE = /!3d(-?\d+(?:\.\d+)?)/;
const LNG_RE = /!4d(-?\d+(?:\.\d+)?)/;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Reads the ids and coordinates Google writes into a place link. Missing pieces are null, never guessed. */
export function parsePlaceUrl(href: string): ParsedPlaceUrl {
  const placeM = PLACE_ID_RE.exec(href);
  const cidM = CID_RE.exec(href);
  const cidQ = cidM ? null : CID_QUERY_RE.exec(href);
  const latM = LAT_RE.exec(href);
  const lngM = LNG_RE.exec(href);
  const fragments: ParsedPlaceUrl['fragments'] = {};
  if (placeM) fragments.placeId = placeM[0];
  if (cidM) fragments.cid = cidM[0];
  else if (cidQ) fragments.cid = cidQ[0].slice(1);
  if (latM) fragments.lat = latM[0];
  if (lngM) fragments.lng = lngM[0];
  return {
    placeId: placeM ? safeDecode(placeM[1] as string) : null,
    cidHex: cidM ? `${(cidM[1] as string).toLowerCase()}:${(cidM[2] as string).toLowerCase()}` : null,
    cid: cidM ? BigInt(cidM[2] as string).toString() : cidQ ? (cidQ[1] as string) : null,
    lat: latM ? Number(latM[1]) : null,
    lng: lngM ? Number(lngM[1]) : null,
    latText: latM ? (latM[1] as string) : null,
    lngText: lngM ? (lngM[1] as string) : null,
    fragments,
  };
}

/** Stable link to the business profile: https://www.google.com/maps?cid=CID, else the href without query/hash. */
export function profileLink(href: string, parsed: ParsedPlaceUrl = parsePlaceUrl(href)): string {
  if (parsed.cid) return `https://www.google.com/maps?cid=${parsed.cid}`;
  return href.split('#')[0]?.split('?')[0] ?? href;
}

/** Adds hl=en&gl=us so a place page is read in English and as a US visitor. */
export function withLocale(url: string): string {
  const u = new URL(url);
  u.searchParams.set('hl', 'en');
  u.searchParams.set('gl', 'us');
  return u.toString();
}
