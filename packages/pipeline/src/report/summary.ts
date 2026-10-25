import { EXCLUSION_REASON_ORDER, SOURCE_IDS, type Db, type PpConfig, type SourceId, type SourceType } from '@pp/core';
import { q } from '../sql';
import { RESIDENTIAL_LABEL_TEXT, type ReportCompany } from './rows';

export type Cell = string | number | null;

export const UNKNOWN_CITY = '(city unknown)';

const has = (c: ReportCompany, col: string): boolean => {
  const v = c.cells[col];
  return v !== null && v !== undefined && String(v).trim() !== '';
};

/** One row per city; a company is counted once, under its own city (never once per ZIP or search term). */
export function byCityRows(companies: ReportCompany[]): Cell[][] {
  const cities = new Map<string, ReportCompany[]>();
  for (const c of companies) {
    const city = c.city.trim() === '' ? UNKNOWN_CITY : c.city;
    const list = cities.get(city);
    if (list) list.push(c);
    else cities.set(city, [c]);
  }
  return [...cities.entries()]
    .sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : a[0].toLowerCase() > b[0].toLowerCase() ? 1 : 0))
    .map(([city, list]) => [
      city,
      list.length,
      list.filter((c) => c.qualified).length,
      list.filter((c) => has(c, 'Owner / decision-maker')).length,
      list.filter((c) => has(c, 'Email')).length,
    ]);
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

export const COMPLETENESS_FIELDS: [string, string][] = [
  ['Owner', 'Owner / decision-maker'],
  ['Email', 'Email'],
  ['Phone', 'Phone'],
  ['Website', 'Website'],
];

/** Counts and percentages of owner / email / phone / website, over every Master row and over the qualified ones. */
export function completenessRows(companies: ReportCompany[]): Cell[][] {
  const qualified = companies.filter((c) => c.qualified);
  return COMPLETENESS_FIELDS.map(([label, col]) => {
    const all = companies.filter((c) => has(c, col)).length;
    const qual = qualified.filter((c) => has(c, col)).length;
    return [label, all, pct(all, companies.length), qual, pct(qual, qualified.length)];
  });
}

const SOURCE_ID_OF: Record<SourceType, SourceId> = {
  google_maps: 'maps',
  website: 'websites',
  cslb_master: 'cslb',
  cslb_personnel: 'cslb',
  cslb_lookup: 'cslb',
  nj_hic_roster: 'nj_hic_roster',
  nj_hic_detail: 'nj_hic_detail',
  nj_principal_search: 'nj_principal_search',
  tx_open_data: 'tx_open_data',
  tx_comptroller: 'tx_comptroller',
  bbb: 'bbb',
};

export const SOURCE_NAMES: Record<SourceId, string> = {
  maps: 'Google Maps',
  websites: 'Company websites',
  cslb: 'CSLB licence data',
  nj_hic_roster: 'NJ HIC roster',
  nj_hic_detail: 'NJ HIC detail pages',
  nj_principal_search: 'NJ business register',
  tx_open_data: 'TX franchise taxpayers (data.texas.gov)',
  tx_comptroller: 'TX Comptroller',
  bbb: 'BBB',
  census: 'US Census',
};

export interface SummaryInput {
  runId: number;
  areaId: string;
  runDate: string;
  companies: ReportCompany[];
}

/** The Summary tab: Item / Value rows, all deterministic for a run (no "now"). */
export async function summaryRows(db: Db, config: PpConfig, input: SummaryInput): Promise<Cell[][]> {
  const { companies } = input;
  const searches = await q<{ status: string; n: string }>(
    db,
    `SELECT status, COUNT(*) AS n FROM searches WHERE run_id = $1 GROUP BY status`,
    [input.runId],
  );
  const planned = searches.reduce((s, r) => s + Number(r.n), 0);
  const done = Number(searches.find((r) => r.status === 'done')?.n ?? 0);

  const painters = companies.filter((c) => c.painterStatus !== 'not_painter');
  const residentialOnly = painters.filter((c) => c.residentialStatus === 'residential_only').length;
  const rows: Cell[][] = [
    ['Run date', input.runDate],
    ['Area', input.areaId],
    ['Searches (done / planned)', `${done} / ${planned}`],
    ['Listings found (companies in Master list)', companies.length],
    ['Not painting contractors', companies.filter((c) => c.painterStatus === 'not_painter').length],
    ['Category not recognised (kept, never qualified)', companies.filter((c) => c.painterStatus === 'unknown').length],
    [`Residential-only (${RESIDENTIAL_LABEL_TEXT.residential_only})`, residentialOnly],
    ['Qualified', companies.filter((c) => c.qualified).length],
  ];

  for (const reason of EXCLUSION_REASON_ORDER) {
    rows.push([`Excluded: ${reason}`, companies.filter((c) => c.reasons.includes(reason)).length]);
  }

  const unrecognised = new Map<string, number>();
  for (const c of companies.filter((x) => x.painterStatus === 'unknown')) {
    for (const cat of c.categories.length > 0 ? c.categories : ['(no category captured)']) {
      unrecognised.set(cat, (unrecognised.get(cat) ?? 0) + 1);
    }
  }
  for (const [cat, n] of [...unrecognised.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    rows.push([`Unrecognised category: ${cat}`, n]);
  }

  const evidence = await q<{ source_type: SourceType; first: Date; last: Date; n: string }>(
    db,
    `SELECT e.source_type, MIN(e.captured_at) AS first, MAX(e.captured_at) AS last, COUNT(*) AS n
       FROM evidence e
      WHERE e.company_id IN (SELECT DISTINCT company_id FROM listings WHERE company_id IS NOT NULL AND id IN (
              SELECT h.listing_id FROM search_hits h JOIN searches s ON s.id = h.search_id WHERE s.run_id = $1
              UNION SELECT id FROM listings WHERE first_seen_run_id = $1 OR last_seen_run_id = $1))
        AND e.status = 'accepted'
      GROUP BY e.source_type`,
    [input.runId],
  );
  const bySource = new Map<SourceId, { first: Date; last: Date; n: number }>();
  for (const e of evidence) {
    const id = SOURCE_ID_OF[e.source_type];
    const prior = bySource.get(id);
    const n = Number(e.n);
    bySource.set(
      id,
      prior
        ? {
            first: prior.first < e.first ? prior.first : e.first,
            last: prior.last > e.last ? prior.last : e.last,
            n: prior.n + n,
          }
        : { first: e.first, last: e.last, n },
    );
  }
  for (const id of SOURCE_IDS) {
    const s = bySource.get(id);
    const state = config.sources[id].enabled ? 'on' : 'off';
    const when = s ? `${s.n} values, first captured ${s.first.toISOString().slice(0, 10)}, last ${s.last.toISOString().slice(0, 10)}` : 'no values captured';
    rows.push([`Source: ${SOURCE_NAMES[id]}`, `${when}; switch ${state}`]);
  }

  rows.push([
    'Note: Contact completeness',
    'Counts are over every company in the Master list, and over the qualified ones separately.',
  ]);
  rows.push([
    'Note: ZIP codes',
    'Open the .xlsx file. A CSV opened by double-click in Excel drops the leading zero of ZIP codes such as 08817.',
  ]);
  return rows;
}
