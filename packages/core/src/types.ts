export type StateCode = 'NJ' | 'TX' | 'CA';
export const STATE_CODES: readonly StateCode[] = ['NJ', 'TX', 'CA'];

export const SOURCE_IDS = [
  'maps',
  'websites',
  'cslb',
  'nj_hic_roster',
  'nj_hic_detail',
  'nj_principal_search',
  'tx_open_data',
  'tx_comptroller',
  'bbb',
  'census',
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const SOURCE_TYPES = [
  'google_maps',
  'website',
  'cslb_master',
  'cslb_personnel',
  'cslb_lookup',
  'nj_hic_roster',
  'nj_hic_detail',
  'nj_principal_search',
  'tx_open_data',
  'tx_comptroller',
  'bbb',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const FIELDS = [
  'company_name',
  'owner_name',
  'phone',
  'email',
  'website',
  'rating',
  'review_count',
  'category',
  'address',
  'street',
  'city',
  'zip',
  'state',
  'lat',
  'lng',
  'place_id',
  'cid',
  'permanently_closed',
  'licence_number',
  'licence_status',
  'licence_classifications',
  'licence_expiry',
  'nj_hic_number',
  'tx_taxpayer_number',
  'registry_legal_name',
  'residential_signal',
] as const;
export type Field = (typeof FIELDS)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const EVIDENCE_STATUSES = ['accepted', 'rejected', 'needs_review'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const CAPTURE_STATUSES = [
  'captured',
  'not_on_card',
  'not_shown',
  'limited_view',
  'blocked',
  'parse_failed',
  'pending',
] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

export const RESIDENTIAL_LABELS = [
  'residential_only',
  'residential_and_commercial',
  'commercial_only',
  'unclear',
] as const;
export type ResidentialLabel = (typeof RESIDENTIAL_LABELS)[number];

export type BlockSignal =
  | 'sorry'
  | 'captcha'
  | 'unusual_traffic'
  | 'limited_view_streak'
  | 'daily_cap'
  | 'http_403';

export type ExclusionReason =
  | 'not a painting contractor'
  | 'also commercial'
  | 'commercial only'
  | 'residential status unclear'
  | 'no Google profile'
  | 'permanently closed'
  | 'outside pilot area'
  | 'rating not captured'
  | 'rating below minimum'
  | 'review count not captured'
  | 'review count below minimum'
  | 'review count above maximum';

export const EXCLUSION_REASON_ORDER: readonly ExclusionReason[] = [
  'not a painting contractor',
  'also commercial',
  'commercial only',
  'residential status unclear',
  'no Google profile',
  'permanently closed',
  'outside pilot area',
  'rating not captured',
  'rating below minimum',
  'review count not captured',
  'review count below minimum',
  'review count above maximum',
];

/** Process exit code meaning "stopped on a block". */
export const EXIT_BLOCKED = 3;

export const RUN_STATUSES = ['planned', 'running', 'stopped', 'blocked', 'done', 'failed'] as const;
export const SEARCH_STATUSES = ['pending', 'running', 'done', 'blocked', 'failed'] as const;
export const DETAIL_STATUSES = ['pending', 'done', 'limited_view', 'blocked', 'failed', 'not_found'] as const;
export const REQUEST_OUTCOMES = [
  'ok',
  'http_error',
  'robots_disallowed',
  'timeout',
  'dns_error',
  'ssrf_refused',
  'cache_hit',
  'blocked',
  'captcha',
  'sorry',
  'limited_view',
  'too_large',
  'offline_miss',
] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];
