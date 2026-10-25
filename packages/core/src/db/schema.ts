import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import {
  CAPTURE_STATUSES,
  CONFIDENCES,
  DETAIL_STATUSES,
  EVIDENCE_STATUSES,
  FIELDS,
  REQUEST_OUTCOMES,
  RESIDENTIAL_LABELS,
  RUN_STATUSES,
  SEARCH_STATUSES,
  SOURCE_TYPES,
} from '../types';

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** `"col" IN ('a','b')` as raw SQL, so migrations carry the allowed values. */
const inList = (col: string, values: readonly string[]) =>
  sql.raw(`"${col}" IN (${values.map((v) => `'${v}'`).join(', ')})`);

/** value NULL exactly when the capture did not succeed (D-13: 0 only for a captured 0). */
const nullIffNotCaptured = (value: string, status: string) =>
  sql.raw(`("${value}" IS NULL) = ("${status}" <> 'captured')`);

const captureStatusCol = (name: string) => text(name).notNull().default('pending');

export const runs = pgTable(
  'runs',
  {
    id: serial('id').primaryKey(),
    areaId: text('area_id').notNull(),
    state: text('state').notNull(),
    status: text('status').notNull().default('planned'),
    stoppedReason: text('stopped_reason'),
    configSnapshot: jsonb('config_snapshot').notNull(),
    notes: text('notes'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  () => [
    check('runs_status_check', inList('status', RUN_STATUSES)),
    check('runs_state_check', inList('state', ['NJ', 'TX', 'CA'])),
  ],
);

export const searches = pgTable(
  'searches',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id),
    areaId: text('area_id').notNull(),
    zip: text('zip').notNull(),
    term: text('term').notNull(),
    phase: text('phase').notNull().default('pilot'),
    position: integer('position').notNull(),
    query: text('query').notNull(),
    url: text('url'),
    landedUrl: text('landed_url'),
    centerLat: doublePrecision('center_lat'),
    centerLng: doublePrecision('center_lng'),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    cardsFound: integer('cards_found'),
    newPlaceIds: integer('new_place_ids'),
    endReached: boolean('end_reached'),
    blockSignal: text('block_signal'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    unique('searches_run_zip_term_key').on(t.runId, t.zip, t.term),
    check('searches_status_check', inList('status', SEARCH_STATUSES)),
    check('searches_phase_check', inList('phase', ['pilot', 'expansion'])),
    index('searches_run_status_idx').on(t.runId, t.status),
  ],
);

export const listings = pgTable(
  'listings',
  {
    id: serial('id').primaryKey(),
    placeId: text('place_id').unique(),
    cid: text('cid').unique(),
    profileUrl: text('profile_url').notNull(),
    name: text('name').notNull(),
    categories: text('categories')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    categoryStatus: captureStatusCol('category_status'),
    rating: numeric('rating', { precision: 2, scale: 1, mode: 'number' }),
    ratingStatus: captureStatusCol('rating_status'),
    reviewCount: integer('review_count'),
    reviewCountStatus: captureStatusCol('review_count_status'),
    phoneE164: text('phone_e164'),
    phoneStatus: captureStatusCol('phone_status'),
    websiteUrl: text('website_url'),
    websiteStatus: captureStatusCol('website_status'),
    addressFull: text('address_full'),
    street: text('street'),
    city: text('city'),
    zip: text('zip'),
    state: text('state'),
    addressStatus: captureStatusCol('address_status'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    coordsStatus: captureStatusCol('coords_status'),
    permanentlyClosed: boolean('permanently_closed'),
    closedStatus: captureStatusCol('closed_status'),
    cardRaw: jsonb('card_raw'),
    placeRaw: jsonb('place_raw'),
    detailStatus: text('detail_status').notNull().default('pending'),
    detailAttempts: integer('detail_attempts').notNull().default(0),
    companyId: integer('company_id').references(() => companies.id),
    firstSeenRunId: integer('first_seen_run_id'),
    lastSeenRunId: integer('last_seen_run_id'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastCheckedAt: ts('last_checked_at'),
  },
  (t) => [
    check('listings_id_present_check', sql.raw('"place_id" IS NOT NULL OR "cid" IS NOT NULL')),
    check('listings_detail_status_check', inList('detail_status', DETAIL_STATUSES)),
    check('listings_category_status_check', inList('category_status', CAPTURE_STATUSES)),
    check('listings_rating_status_check', inList('rating_status', CAPTURE_STATUSES)),
    check('listings_review_count_status_check', inList('review_count_status', CAPTURE_STATUSES)),
    check('listings_phone_status_check', inList('phone_status', CAPTURE_STATUSES)),
    check('listings_website_status_check', inList('website_status', CAPTURE_STATUSES)),
    check('listings_address_status_check', inList('address_status', CAPTURE_STATUSES)),
    check('listings_coords_status_check', inList('coords_status', CAPTURE_STATUSES)),
    check('listings_closed_status_check', inList('closed_status', CAPTURE_STATUSES)),
    check('listings_rating_null_iff_check', nullIffNotCaptured('rating', 'rating_status')),
    check('listings_review_count_null_iff_check', nullIffNotCaptured('review_count', 'review_count_status')),
    check('listings_phone_null_iff_check', nullIffNotCaptured('phone_e164', 'phone_status')),
    check('listings_website_null_iff_check', nullIffNotCaptured('website_url', 'website_status')),
    check('listings_address_null_iff_check', nullIffNotCaptured('address_full', 'address_status')),
    check('listings_lat_null_iff_check', nullIffNotCaptured('lat', 'coords_status')),
    check('listings_lng_null_iff_check', nullIffNotCaptured('lng', 'coords_status')),
    check('listings_closed_null_iff_check', nullIffNotCaptured('permanently_closed', 'closed_status')),
    check('listings_rating_range_check', sql.raw('"rating" IS NULL OR ("rating" >= 1.0 AND "rating" <= 5.0)')),
    check('listings_review_count_range_check', sql.raw('"review_count" IS NULL OR "review_count" >= 0')),
    index('listings_company_idx').on(t.companyId),
    index('listings_zip_idx').on(t.zip),
  ],
);

export const searchHits = pgTable(
  'search_hits',
  {
    id: serial('id').primaryKey(),
    searchId: integer('search_id')
      .notNull()
      .references(() => searches.id),
    listingId: integer('listing_id')
      .notNull()
      .references(() => listings.id),
    position: integer('position').notNull(),
    isNew: boolean('is_new').notNull().default(false),
  },
  (t) => [unique('search_hits_search_listing_key').on(t.searchId, t.listingId)],
);

export const companies = pgTable(
  'companies',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id'),
    areaId: text('area_id'),
    state: text('state'),
    displayName: text('display_name').notNull(),
    primaryListingId: integer('primary_listing_id'),
    mergeRung: text('merge_rung'),
    franchise: boolean('franchise').notNull().default(false),
    franchiseBrand: text('franchise_brand'),
    possibleDuplicateOf: integer('possible_duplicate_of'),
    painterStatus: text('painter_status').notNull().default('unknown'),
    painterReason: text('painter_reason'),
    painterCategory: text('painter_category'),
    residentialStatus: text('residential_status'),
    residentialReason: text('residential_reason'),
    inArea: boolean('in_area'),
    locationPrecision: text('location_precision'),
    siteStatus: text('site_status'),
    registryStatus: jsonb('registry_status')
      .notNull()
      .default(sql`'{}'::jsonb`),
    qualified: boolean('qualified'),
    exclusionReasons: text('exclusion_reasons')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastCheckedAt: ts('last_checked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('companies_painter_status_check', inList('painter_status', ['painter', 'not_painter', 'unknown'])),
    check(
      'companies_residential_status_check',
      sql.raw(`"residential_status" IS NULL OR "residential_status" IN (${RESIDENTIAL_LABELS.map((v) => `'${v}'`).join(', ')})`),
    ),
    check(
      'companies_location_precision_check',
      sql.raw(`"location_precision" IS NULL OR "location_precision" IN ('exact', 'approximate', 'unknown')`),
    ),
    index('companies_run_idx').on(t.runId),
  ],
);

export const registryRecords = pgTable(
  'registry_records',
  {
    id: serial('id').primaryKey(),
    sourceType: text('source_type').notNull(),
    sourceKey: text('source_key').notNull(),
    state: text('state'),
    legalName: text('legal_name'),
    dbaName: text('dba_name'),
    nameNorm: text('name_norm'),
    nameCore: text('name_core'),
    aliases: text('aliases')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    address: text('address'),
    city: text('city'),
    zip: text('zip'),
    phoneE164: text('phone_e164'),
    phoneLast10: text('phone_last10'),
    email: text('email'),
    status: text('status'),
    classifications: text('classifications'),
    businessType: text('business_type'),
    issuedOn: date('issued_on'),
    expiresOn: date('expires_on'),
    raw: jsonb('raw'),
    sourceUrl: text('source_url'),
    capturedAt: ts('captured_at'),
  },
  (t) => [
    unique('registry_records_source_key').on(t.sourceType, t.sourceKey),
    check('registry_records_source_type_check', inList('source_type', SOURCE_TYPES)),
    index('registry_records_state_zip_idx').on(t.state, t.zip),
    index('registry_records_name_core_idx').on(t.nameCore),
    index('registry_records_phone_last10_idx').on(t.phoneLast10),
  ],
);

export const registryPeople = pgTable('registry_people', {
  id: serial('id').primaryKey(),
  registryRecordId: integer('registry_record_id')
    .notNull()
    .references(() => registryRecords.id),
  sourceType: text('source_type').notNull(),
  nameRaw: text('name_raw'),
  fullName: text('full_name'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  title: text('title'),
  roleRank: integer('role_rank'),
  associatedOn: date('associated_on'),
  dissociatedOn: date('dissociated_on'),
  sourceUrl: text('source_url'),
  capturedAt: ts('captured_at'),
});

export const registryMatches = pgTable(
  'registry_matches',
  {
    id: serial('id').primaryKey(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    registryRecordId: integer('registry_record_id')
      .notNull()
      .references(() => registryRecords.id),
    rung: text('rung').notNull(),
    strength: text('strength').notNull(),
    detail: jsonb('detail'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('registry_matches_company_record_key').on(t.companyId, t.registryRecordId),
    check('registry_matches_strength_check', inList('strength', ['strong', 'candidate'])),
  ],
);

export const evidence = pgTable(
  'evidence',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    companyId: integer('company_id').references(() => companies.id),
    listingId: integer('listing_id').references(() => listings.id),
    registryRecordId: integer('registry_record_id').references(() => registryRecords.id),
    field: text('field').notNull(),
    value: text('value').notNull(),
    valueNorm: text('value_norm').notNull(),
    sourceType: text('source_type').notNull(),
    sourceUrl: text('source_url').notNull(),
    pageSha256: text('page_sha256'),
    capturedAt: ts('captured_at').notNull(),
    snippet: text('snippet').notNull(),
    extractor: text('extractor').notNull(),
    extractorVersion: text('extractor_version').notNull(),
    confidence: text('confidence').notNull(),
    status: text('status').notNull().default('accepted'),
    rejectReason: text('reject_reason'),
    corroboratedBy: bigint('corroborated_by', { mode: 'number' })
      .array()
      .notNull()
      .default(sql`'{}'::bigint[]`),
    attrs: jsonb('attrs')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('evidence_field_check', inList('field', FIELDS)),
    check('evidence_source_type_check', inList('source_type', SOURCE_TYPES)),
    check('evidence_snippet_length_check', sql.raw('char_length("snippet") BETWEEN 1 AND 1000')),
    check('evidence_confidence_check', inList('confidence', CONFIDENCES)),
    check('evidence_status_check', inList('status', EVIDENCE_STATUSES)),
    check(
      'evidence_owner_present_check',
      sql.raw('"company_id" IS NOT NULL OR "listing_id" IS NOT NULL OR "registry_record_id" IS NOT NULL'),
    ),
    index('evidence_company_field_idx').on(t.companyId, t.field),
    index('evidence_listing_field_idx').on(t.listingId, t.field),
    index('evidence_field_value_norm_idx').on(t.field, t.valueNorm),
  ],
);

export const pages = pgTable('pages', {
  id: serial('id').primaryKey(),
  url: text('url').notNull(),
  finalUrl: text('final_url'),
  host: text('host').notNull(),
  method: text('method').notNull().default('GET'),
  sha256: text('sha256').notNull().unique(),
  statusCode: integer('status_code'),
  contentType: text('content_type'),
  bytes: integer('bytes'),
  rendered: boolean('rendered').notNull().default(false),
  source: text('source'),
  cachePath: text('cache_path'),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
});

export const requestLog = pgTable(
  'request_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    source: text('source').notNull(),
    host: text('host').notNull(),
    method: text('method').notNull(),
    url: text('url').notNull(),
    status: integer('status'),
    bytes: integer('bytes'),
    ms: integer('ms'),
    outcome: text('outcome').notNull(),
    runId: integer('run_id'),
    note: text('note'),
  },
  (t) => [
    check('request_log_outcome_check', inList('outcome', REQUEST_OUTCOMES)),
    index('request_log_source_at_idx').on(t.source, t.at),
  ],
);

export const dnsChecks = pgTable(
  'dns_checks',
  {
    domain: text('domain').primaryKey(),
    result: text('result').notNull(),
    detail: jsonb('detail'),
    checkedAt: ts('checked_at').notNull().defaultNow(),
  },
  () => [check('dns_checks_result_check', inList('result', ['mx', 'a_fallback', 'null_mx', 'no_records', 'error']))],
);

export const accuracySamples = pgTable(
  'accuracy_samples',
  {
    id: serial('id').primaryKey(),
    runId: integer('run_id')
      .notNull()
      .references(() => runs.id),
    state: text('state').notNull(),
    sampleId: text('sample_id').notNull(),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id),
    stratum: text('stratum').notNull(),
    seed: integer('seed').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('accuracy_samples_run_sample_key').on(t.runId, t.sampleId),
    check('accuracy_samples_stratum_check', inList('stratum', ['qualified', 'non_qualified', 'non_painter'])),
  ],
);

export const PILOT_TABLES = [
  'runs',
  'searches',
  'search_hits',
  'listings',
  'companies',
  'evidence',
  'registry_records',
  'registry_people',
  'registry_matches',
  'pages',
  'request_log',
  'dns_checks',
  'accuracy_samples',
] as const;
