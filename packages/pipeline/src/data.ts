import type { Confidence, Db, EvidenceRow, EvidenceStatus, Field, ResidentialLabel, SourceType, StateCode } from '@pp/core';
import { num, q } from './sql';

export interface RunRow {
  id: number;
  areaId: string;
  state: StateCode;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ListingRow {
  id: number;
  placeId: string | null;
  cid: string | null;
  profileUrl: string;
  name: string;
  categories: string[];
  rating: number | null;
  ratingStatus: string;
  reviewCount: number | null;
  reviewCountStatus: string;
  phoneE164: string | null;
  websiteUrl: string | null;
  addressFull: string | null;
  street: string | null;
  city: string | null;
  zip: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  coordsStatus: string;
  addressStatus: string;
  permanentlyClosed: boolean | null;
  firstSeenAt: Date;
  lastCheckedAt: Date | null;
  companyId: number | null;
}

export interface CompanyRow {
  id: number;
  runId: number | null;
  areaId: string | null;
  state: StateCode | null;
  displayName: string;
  primaryListingId: number | null;
  mergeRung: string | null;
  franchise: boolean;
  franchiseBrand: string | null;
  possibleDuplicateOf: number | null;
  painterStatus: 'painter' | 'not_painter' | 'unknown';
  painterReason: string | null;
  painterCategory: string | null;
  residentialStatus: ResidentialLabel | null;
  residentialReason: string | null;
  inArea: boolean | null;
  locationPrecision: 'exact' | 'approximate' | 'unknown' | null;
  siteStatus: string | null;
  registryStatus: Record<string, unknown>;
  qualified: boolean | null;
  exclusionReasons: string[];
}

export async function loadRun(db: Db, runId: number): Promise<RunRow> {
  const rows = await q<{
    id: number;
    area_id: string;
    state: StateCode;
    status: string;
    created_at: Date;
    started_at: Date | null;
    finished_at: Date | null;
  }>(db, `SELECT id, area_id, state, status, created_at, started_at, finished_at FROM runs WHERE id = $1`, [runId]);
  const r = rows[0];
  if (!r) throw new Error(`Unknown run ${runId}`);
  return {
    id: r.id,
    areaId: r.area_id,
    state: r.state,
    status: r.status,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** Listings this run reached (through its search hits) or first/last saw. */
export const RUN_LISTING_IDS_SQL = `
  SELECT h.listing_id AS id FROM search_hits h JOIN searches s ON s.id = h.search_id WHERE s.run_id = $1
  UNION SELECT id FROM listings WHERE first_seen_run_id = $1 OR last_seen_run_id = $1`;

export async function runListings(db: Db, runId: number): Promise<ListingRow[]> {
  const rows = await q(db, `SELECT * FROM listings WHERE id IN (${RUN_LISTING_IDS_SQL}) ORDER BY id`, [runId]);
  return rows.map(toListing);
}

/** Companies that own at least one listing of this run. */
export async function runCompanyIds(db: Db, runId: number): Promise<number[]> {
  const rows = await q<{ company_id: number }>(
    db,
    `SELECT DISTINCT company_id FROM listings WHERE company_id IS NOT NULL AND id IN (${RUN_LISTING_IDS_SQL}) ORDER BY company_id`,
    [runId],
  );
  return rows.map((r) => r.company_id);
}

export async function loadCompanies(db: Db, ids: number[]): Promise<CompanyRow[]> {
  if (ids.length === 0) return [];
  const rows = await q(db, `SELECT * FROM companies WHERE id = ANY($1::int[]) ORDER BY id`, [ids]);
  return rows.map(toCompany);
}

export async function listingsByCompany(db: Db, ids: number[]): Promise<Map<number, ListingRow[]>> {
  const out = new Map<number, ListingRow[]>();
  if (ids.length === 0) return out;
  const rows = await q(db, `SELECT * FROM listings WHERE company_id = ANY($1::int[]) ORDER BY id`, [ids]);
  for (const r of rows) {
    const l = toListing(r);
    const key = l.companyId as number;
    const list = out.get(key);
    if (list) list.push(l);
    else out.set(key, [l]);
  }
  return out;
}

export async function evidenceByCompany(db: Db, ids: number[]): Promise<Map<number, EvidenceRow[]>> {
  const out = new Map<number, EvidenceRow[]>();
  if (ids.length === 0) return out;
  const rows = await q(db, `SELECT * FROM evidence WHERE company_id = ANY($1::int[]) ORDER BY id`, [ids]);
  for (const r of rows) {
    const e = toEvidence(r);
    const key = e.companyId as number;
    const list = out.get(key);
    if (list) list.push(e);
    else out.set(key, [e]);
  }
  return out;
}

type Raw = Record<string, unknown>;

export function toListing(r: Raw): ListingRow {
  return {
    id: r.id as number,
    placeId: (r.place_id as string | null) ?? null,
    cid: (r.cid as string | null) ?? null,
    profileUrl: r.profile_url as string,
    name: r.name as string,
    categories: (r.categories as string[] | null) ?? [],
    rating: num(r.rating),
    ratingStatus: r.rating_status as string,
    reviewCount: num(r.review_count),
    reviewCountStatus: r.review_count_status as string,
    phoneE164: (r.phone_e164 as string | null) ?? null,
    websiteUrl: (r.website_url as string | null) ?? null,
    addressFull: (r.address_full as string | null) ?? null,
    street: (r.street as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    zip: (r.zip as string | null) ?? null,
    state: (r.state as string | null) ?? null,
    lat: num(r.lat),
    lng: num(r.lng),
    coordsStatus: r.coords_status as string,
    addressStatus: r.address_status as string,
    permanentlyClosed: (r.permanently_closed as boolean | null) ?? null,
    firstSeenAt: r.first_seen_at as Date,
    lastCheckedAt: (r.last_checked_at as Date | null) ?? null,
    companyId: (r.company_id as number | null) ?? null,
  };
}

export function toCompany(r: Raw): CompanyRow {
  return {
    id: r.id as number,
    runId: (r.run_id as number | null) ?? null,
    areaId: (r.area_id as string | null) ?? null,
    state: (r.state as StateCode | null) ?? null,
    displayName: r.display_name as string,
    primaryListingId: (r.primary_listing_id as number | null) ?? null,
    mergeRung: (r.merge_rung as string | null) ?? null,
    franchise: r.franchise as boolean,
    franchiseBrand: (r.franchise_brand as string | null) ?? null,
    possibleDuplicateOf: (r.possible_duplicate_of as number | null) ?? null,
    painterStatus: r.painter_status as CompanyRow['painterStatus'],
    painterReason: (r.painter_reason as string | null) ?? null,
    painterCategory: (r.painter_category as string | null) ?? null,
    residentialStatus: (r.residential_status as ResidentialLabel | null) ?? null,
    residentialReason: (r.residential_reason as string | null) ?? null,
    inArea: (r.in_area as boolean | null) ?? null,
    locationPrecision: (r.location_precision as CompanyRow['locationPrecision']) ?? null,
    siteStatus: (r.site_status as string | null) ?? null,
    registryStatus: (r.registry_status as Record<string, unknown> | null) ?? {},
    qualified: (r.qualified as boolean | null) ?? null,
    exclusionReasons: (r.exclusion_reasons as string[] | null) ?? [],
  };
}

export function toEvidence(r: Raw): EvidenceRow {
  return {
    id: Number(r.id),
    companyId: (r.company_id as number | null) ?? null,
    listingId: (r.listing_id as number | null) ?? null,
    registryRecordId: (r.registry_record_id as number | null) ?? null,
    field: r.field as Field,
    value: r.value as string,
    valueNorm: r.value_norm as string,
    sourceType: r.source_type as SourceType,
    sourceUrl: r.source_url as string,
    pageSha256: (r.page_sha256 as string | null) ?? null,
    capturedAt: r.captured_at as Date,
    snippet: r.snippet as string,
    extractor: r.extractor as string,
    extractorVersion: r.extractor_version as string,
    confidence: r.confidence as Confidence,
    status: r.status as EvidenceStatus,
    rejectReason: (r.reject_reason as string | null) ?? null,
    corroboratedBy: ((r.corroborated_by as (string | number)[] | null) ?? []).map(Number),
    attrs: (r.attrs as Record<string, unknown> | null) ?? {},
  };
}
