const SUFFIX: Record<string, string> = {
  STREET: 'ST',
  AVENUE: 'AVE',
  ROAD: 'RD',
  DRIVE: 'DR',
  BOULEVARD: 'BLVD',
  LANE: 'LN',
  COURT: 'CT',
  PLACE: 'PL',
  HIGHWAY: 'HWY',
  PARKWAY: 'PKWY',
  CIRCLE: 'CIR',
  TERRACE: 'TER',
  TURNPIKE: 'TPKE',
  SQUARE: 'SQ',
  TRAIL: 'TRL',
  ROUTE: 'RT',
  NORTH: 'N',
  SOUTH: 'S',
  EAST: 'E',
  WEST: 'W',
};

/** Street-suffix tokens (after SUFFIX): a digit+letter token right after one of these is a unit ("21 Koster Blvd 5B"). HWY and RT are left out: "Hwy 9B" is a road. */
const UNIT_AFTER = new Set(['ST', 'AVE', 'RD', 'DR', 'BLVD', 'LN', 'CT', 'PL', 'PKWY', 'CIR', 'TER', 'TPKE', 'SQ', 'TRL', 'WAY']);

const UNIT_MARKERS = new Set(['APT', 'APARTMENT', 'STE', 'SUITE', 'UNIT', 'FL', 'FLOOR', 'BLDG', 'BUILDING', 'RM', 'ROOM']);

/**
 * Street number + normalised street name ("65 Reeds Rd" and "65 REEDS ROAD, Suite 2" give the same key),
 * or null for a PO box / an address without a street number (those never join on address).
 * A bare digit+letter unit straight after the street suffix ("21 Koster Blvd 5B") is dropped too.
 */
export function streetKey(address: string | null | undefined): { number: string; name: string; key: string } | null {
  if (!address) return null;
  const upper = address
    .toUpperCase()
    .replace(/[.,']/g, ' ')
    .replace(/#\s*\w+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^P ?O BOX\b|^POST OFFICE BOX\b/.test(upper)) return null;
  const tokens = upper.split(' ').filter(Boolean);
  const num = tokens[0];
  if (!num || !/^\d+[A-Z]?$/.test(num)) return null;
  const rest: string[] = [];
  for (const t of tokens.slice(1)) {
    if (UNIT_MARKERS.has(t)) break;
    const prev = rest[rest.length - 1];
    if (/^\d+[A-Z]$/.test(t) && prev !== undefined && rest.length > 1 && UNIT_AFTER.has(prev)) break;
    rest.push(SUFFIX[t] ?? t);
  }
  if (rest.length === 0) return null;
  const name = rest.join(' ');
  return { number: num, name, key: `${num} ${name}` };
}
