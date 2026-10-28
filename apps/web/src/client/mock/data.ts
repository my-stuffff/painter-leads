// Mock-mode data only (never in the production bundle). Follows ../../shared/api.ts.
import type { CatalogCity, CatalogState, LeadList, LeadRow, SourceRow, StateCode, UserRow } from '../../shared/api';

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

type CityRaw = [areaId: string, name: string, state: StateCode, population: number, zipCount: number, lat: number, lng: number, lastRunDaysAgo: number | null];

const CITIES_RAW: CityRaw[] = [
  ['los_angeles_ca', 'Los Angeles', 'CA', 3878704, 116, 34.0522, -118.2437, 1.2],
  ['houston_tx', 'Houston', 'TX', 2390125, 92, 29.7604, -95.3698, 1.1],
  ['san_antonio_tx', 'San Antonio', 'TX', 1526656, 51, 29.4241, -98.4936, null],
  ['san_diego_ca_city', 'San Diego', 'CA', 1404452, 45, 32.7157, -117.1611, 1.4],
  ['dallas_tx', 'Dallas', 'TX', 1326087, 49, 32.7767, -96.797, 41],
  ['san_jose_ca', 'San Jose', 'CA', 997368, 29, 37.3382, -121.8863, null],
  ['austin_tx_city', 'Austin', 'TX', 993588, 38, 30.2672, -97.7431, null],
  ['fort_worth_tx', 'Fort Worth', 'TX', 1008106, 35, 32.7555, -97.3308, null],
  ['san_francisco_ca', 'San Francisco', 'CA', 827526, 28, 37.7749, -122.4194, 5.3],
  ['el_paso_tx', 'El Paso', 'TX', 681723, 20, 31.7619, -106.485, null],
  ['fresno_ca', 'Fresno', 'CA', 550105, 17, 36.7378, -119.7871, null],
  ['sacramento_ca', 'Sacramento', 'CA', 535798, 19, 38.5816, -121.4944, null],
  ['long_beach_ca', 'Long Beach', 'CA', 450901, 14, 33.7701, -118.1937, 1.3],
  ['oakland_ca', 'Oakland', 'CA', 443554, 16, 37.8044, -122.2712, 64],
  ['bakersfield_ca', 'Bakersfield', 'CA', 417468, 6, 35.3733, -119.0187, null],
  ['arlington_tx', 'Arlington', 'TX', 403672, 13, 32.7357, -97.1081, null],
  ['anaheim_ca', 'Anaheim', 'CA', 340512, 7, 33.8366, -117.9143, 1.3],
  ['corpus_christi_tx', 'Corpus Christi', 'TX', 316804, 18, 27.8006, -97.3964, null],
  ['newark_nj', 'Newark', 'NJ', 317303, 9, 40.7357, -74.1724, 1.0],
  ['plano_tx', 'Plano', 'TX', 293286, 6, 33.0198, -96.6989, 12],
  ['jersey_city_nj', 'Jersey City', 'NJ', 302824, 7, 40.7178, -74.0431, 1.0],
  ['lubbock_tx', 'Lubbock', 'TX', 272086, 12, 33.5779, -101.8552, null],
  ['paterson_nj', 'Paterson', 'NJ', 157794, 9, 40.9168, -74.1718, 12],
  ['elizabeth_nj', 'Elizabeth', 'NJ', 137298, 4, 40.664, -74.2107, 1.1],
];

let runSeq = 400;
export const CITIES: CatalogCity[] = CITIES_RAW.map(([areaId, name, state, population, zipCount, lat, lng, last]) => ({
  areaId,
  name,
  state,
  population,
  popYear: 2024,
  lat,
  lng,
  zipCount,
  lastRun: last == null ? null : { runId: runSeq++, finishedAt: iso(last * DAY) },
}));

export const CITY = new Map(CITIES.map((c) => [c.areaId, c]));

export const STATES: CatalogState[] = [
  { code: 'CA', name: 'California', ownerSources: ['CSLB licence records', 'Company websites'] },
  { code: 'TX', name: 'Texas', ownerSources: ['Texas Comptroller records', 'Company websites'] },
  { code: 'NJ', name: 'New Jersey', ownerSources: ['NJ home improvement contractor records', 'Company websites'] },
];

export const USERS: UserRow[] = [
  { id: 1, name: 'Maya Collins', email: 'maya@painterpromotions.com', role: 'admin', disabled: false, createdAt: iso(60 * DAY), lastLoginAt: iso(3 * 60_000) },
  { id: 2, name: 'Jordan Reyes', email: 'jordan@painterpromotions.com', role: 'operator', disabled: false, createdAt: iso(41 * DAY), lastLoginAt: iso(2.2 * 3_600_000) },
  { id: 3, name: 'Priya Shah', email: 'priya@painterpromotions.com', role: 'operator', disabled: false, createdAt: iso(30 * DAY), lastLoginAt: iso(1.4 * DAY) },
  { id: 4, name: 'Tom Becker', email: 'tom@painterpromotions.com', role: 'viewer', disabled: false, createdAt: iso(12 * DAY), lastLoginAt: iso(5 * DAY) },
  { id: 5, name: 'Alex Kim', email: 'alex@painterpromotions.com', role: 'viewer', disabled: true, createdAt: iso(90 * DAY), lastLoginAt: null },
];

// --- Leads -----------------------------------------------------------------------------------------------------

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAINT_PREFIX = [
  'Brushstroke', 'True Coat', 'Evergreen', 'Lone Star', 'Golden Gate', 'Pacific Crest', 'Summit', 'Bluebonnet', 'Garden State',
  'Hudson', 'Liberty', 'Precision', 'Fresh Coat', 'Five Star', 'Heritage', 'Sunset', 'Alamo', 'Coastal', 'Northside', 'Mission',
  'Oak & Ivy', 'Silver Brush', 'Fine Line', 'Clearview', 'Cardinal', 'Redwood', 'Prairie', 'Harbor', 'Magnolia', 'Ironwood',
  'Bright Side', 'Cornerstone', 'Palmetto', 'Riverbend', 'Westside', 'Canyon', 'Cypress', 'Gold Coast', 'Keystone', 'Meridian',
];
const PAINT_SUFFIX = ['Painting', 'Painting Co.', 'Painters', 'House Painting', 'Painting & Finishes', 'Coatings', 'Painting Services', 'Pro Painting'];
const CHECK_NAMES = ['Home Services', 'Handyman Pros', 'Remodeling & Paint', 'Home Improvement', 'Renovations', 'Property Care', 'Fix-It Crew', 'Home Repair'];
const FIRST = ['Michael', 'Carlos', 'David', 'Jose', 'Sarah', 'James', 'Luis', 'Robert', 'Maria', 'Daniel', 'Kevin', 'Anthony', 'Brian', 'Jennifer', 'Steven', 'Miguel', 'Eric', 'Chris', 'Angela', 'Tony'];
const LAST = ['Garcia', 'Johnson', 'Martinez', 'Nguyen', 'Smith', 'Rodriguez', 'Lopez', 'Kim', 'Brown', 'Hernandez', 'Patel', 'Davis', 'Wilson', 'Ramirez', 'Miller', 'Anderson', 'Torres', 'Flores', 'Sullivan', 'Russo'];
const AREA_CODES: Record<StateCode, string[]> = {
  CA: ['213', '310', '323', '619', '858', '408', '415', '559', '916', '562', '510', '661', '714'],
  TX: ['713', '281', '832', '210', '214', '972', '512', '817', '915', '361', '806'],
  NJ: ['973', '201', '908', '862'],
};
const STREETS = ['Main St', 'Oak Ave', 'Elm St', 'Maple Dr', 'Cedar Ln', 'Park Blvd', 'Lakeview Dr', 'Sunset Blvd', 'Broadway', 'Washington Ave', 'Pine St', 'Hillcrest Rd'];
const WHY_NOT = ['Also does commercial work', 'Houses-only not proven'];
const OWNER_SOURCE: Record<StateCode, string> = { CA: 'CSLB licence record', TX: 'Texas Comptroller record', NJ: 'NJ home improvement contractor record' };

let companySeq = 10_000;
export const LEAD_BY_COMPANY = new Map<number, LeadRow>();

function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)] as T;
}

/** About `total` leads spread over the given cities: ~65 % painting, ~20 % check first, ~15 % likely fits. */
export function makeLeads(seed: number, areaIds: string[], total: number, runIds: Map<string, number>): LeadRow[] {
  const r = rng(seed);
  const rows: LeadRow[] = [];
  const used = new Set<string>();
  for (let i = 0; i < total; i++) {
    const areaId = areaIds[i % areaIds.length] as string;
    const city = CITY.get(areaId);
    if (!city) continue;
    const roll = r();
    const list: LeadList = roll < 0.65 ? 'painting' : roll < 0.85 ? 'check' : 'likely';
    let company = '';
    for (let tries = 0; tries < 20; tries++) {
      company =
        list === 'check' ? `${pick(r, PAINT_PREFIX)} ${pick(r, CHECK_NAMES)}` : `${pick(r, PAINT_PREFIX)} ${pick(r, PAINT_SUFFIX)}`;
      if (!used.has(company)) break;
    }
    used.add(company);
    const slug = company.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    const first = pick(r, FIRST);
    const last = pick(r, LAST);
    const hasOwner = r() > 0.22;
    const hasEmail = r() > 0.3;
    const hasSite = r() > 0.12;
    const hasPhone = r() > 0.04;
    const ownerFromRegistry = r() > 0.45;
    const site = hasSite ? `https://www.${slug}.com` : null;
    const emailUser = r() > 0.5 ? 'info' : first.toLowerCase();
    const zip = String(Math.floor(r() * 900) + (city.state === 'NJ' ? 7000 : city.state === 'TX' ? 75000 : 90000)).padStart(5, '0');
    const phone = hasPhone
      ? `(${pick(r, AREA_CODES[city.state])}) ${200 + Math.floor(r() * 799)}-${String(Math.floor(r() * 10000)).padStart(4, '0')}`
      : null;
    const rating = Math.round((4.7 + r() * 0.3) * 10) / 10;
    const reviews = 10 + Math.floor(r() * 90);
    const row: LeadRow = {
      companyId: companySeq++,
      runId: runIds.get(areaId) ?? 500,
      list,
      whyNot: list === 'likely' ? pick(r, WHY_NOT) : null,
      areaId,
      searchCity: `${city.name}, ${city.state}`,
      company,
      owner: hasOwner ? `${first} ${last}` : null,
      ownerTitle: hasOwner ? pick(r, ['Owner', 'Owner', 'President', 'Founder', 'Managing member']) : null,
      ownerSource: hasOwner ? (ownerFromRegistry ? OWNER_SOURCE[city.state] : 'Company website') : null,
      ownerConfidence: hasOwner ? (ownerFromRegistry ? 'high' : 'medium') : null,
      phone,
      email: hasEmail && site ? `${emailUser}@${slug}.com` : null,
      emailSource: hasEmail && site ? 'Company website, contact page' : null,
      website: site,
      rating,
      reviews,
      googleUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${company} ${city.name}`)}`,
      category: list === 'check' ? pick(r, ['Handyman', 'General contractor', 'Painter']) : 'Painter',
      address: `${100 + Math.floor(r() * 9800)} ${pick(r, STREETS)}`,
      city: city.name,
      zip,
      state: city.state,
      licence: city.state === 'CA' && r() > 0.3 ? String(900000 + Math.floor(r() * 99999)) : null,
      residentialStatus: list === 'likely' ? 'Unclear' : 'Residential',
      firstSeen: iso((2 + r() * 20) * DAY),
      lastChecked: iso(r() * 2 * DAY),
    };
    rows.push(row);
    LEAD_BY_COMPANY.set(row.companyId, row);
  }
  return rows;
}

export function sourcesFor(companyId: number): SourceRow[] {
  const l = LEAD_BY_COMPANY.get(companyId);
  if (!l) return [];
  const g = l.googleUrl;
  const captured = l.lastChecked ?? new Date().toISOString();
  const out: SourceRow[] = [
    { field: 'Company name', value: l.company, sourceUrl: g, sourceLabel: 'Google Maps listing', capturedAt: captured, confidence: 'high' },
  ];
  if (l.phone) out.push({ field: 'Phone', value: l.phone, sourceUrl: g, sourceLabel: 'Google Maps listing', capturedAt: captured, confidence: 'high' });
  if (l.rating != null)
    out.push({ field: 'Google rating', value: l.rating.toFixed(1), sourceUrl: g, sourceLabel: 'Google Maps listing', capturedAt: captured, confidence: 'high' });
  if (l.reviews != null)
    out.push({ field: 'Reviews', value: String(l.reviews), sourceUrl: g, sourceLabel: 'Google Maps listing', capturedAt: captured, confidence: 'high' });
  if (l.website) out.push({ field: 'Website', value: l.website, sourceUrl: g, sourceLabel: 'Google Maps listing', capturedAt: captured, confidence: 'high' });
  if (l.address)
    out.push({ field: 'Address', value: `${l.address}, ${l.city}, ${l.state} ${l.zip}`, sourceUrl: g, sourceLabel: 'Google Maps listing', capturedAt: captured, confidence: 'high' });
  if (l.owner)
    out.push({
      field: 'Owner',
      value: l.owner,
      sourceUrl: l.ownerSource === 'Company website' ? `${l.website}/about` : 'https://www.cslb.ca.gov/',
      sourceLabel: l.ownerSource ?? 'Company website',
      capturedAt: captured,
      confidence: l.ownerConfidence,
    });
  if (l.email)
    out.push({ field: 'Email', value: l.email, sourceUrl: `${l.website}/contact`, sourceLabel: 'Company website, contact page', capturedAt: captured, confidence: 'high' });
  if (l.licence)
    out.push({ field: 'Licence', value: l.licence, sourceUrl: 'https://www.cslb.ca.gov/', sourceLabel: 'CSLB licence record', capturedAt: captured, confidence: 'high' });
  out.push({
    field: 'Works on houses',
    value: l.residentialStatus ?? 'Unclear',
    sourceUrl: l.website,
    sourceLabel: l.website ? 'Company website, services page' : 'Google Maps listing',
    capturedAt: captured,
    confidence: l.residentialStatus === 'Residential' ? 'medium' : 'low',
  });
  return out;
}
