// The one contract between the web app's browser side (src/client), its server (src/server) and the workers
// (packages/jobs). Every JSON body the server sends or accepts is one of these types. Change it here first.

export type StateCode = 'CA' | 'TX' | 'NJ';
export type Role = 'admin' | 'operator' | 'viewer';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
/** waiting = paused by Google (limited view / block) or the daily cap; picked up again at `notBefore`. */
export type JobAreaStatus = 'queued' | 'running' | 'waiting' | 'done' | 'reused' | 'failed' | 'cancelled';
export type ExportStatus = 'none' | 'building' | 'ready' | 'failed';

/** painting = qualified, name says painting; check = qualified but the name says handyman/remodel/etc.;
 *  likely = good rating + review count, only out because it also does commercial work or houses-only is unproven. */
export type LeadList = 'painting' | 'check' | 'likely';

export const LEAD_LIST_LABEL: Record<LeadList, string> = {
  painting: 'Painting companies',
  check: 'Check first',
  likely: 'Likely fits',
};

// ---------------------------------------------------------------------------------------------------------------
// Errors: every non-2xx response has this body.
export interface ApiError {
  error: string;
}

// ---------------------------------------------------------------------------------------------------------------
// Auth
export interface Me {
  id: number;
  email: string;
  name: string;
  role: Role;
}
/** POST /api/auth/login → 200 Me (sets an httpOnly session cookie) | 401 ApiError */
export interface LoginBody {
  email: string;
  password: string;
}
// POST /api/auth/logout → 204
// GET  /api/auth/me     → 200 Me | 401 ApiError

// ---------------------------------------------------------------------------------------------------------------
// Catalog: the states and big cities a search can cover (data/geo/catalog.json + the newest run of each city).

/** GET /api/catalog → Catalog */
export interface Catalog {
  states: CatalogState[];
  cities: CatalogCity[];
}
export interface CatalogState {
  code: StateCode;
  name: string;
  /** Where owner names come from besides company websites. */
  ownerSources: string[];
}
export interface CatalogCity {
  /** Area id the pipeline uses, e.g. los_angeles_ca. */
  areaId: string;
  state: StateCode;
  name: string;
  /** Census population estimate (popYear). Sort order of "biggest first". */
  population: number;
  popYear: number;
  lat: number;
  lng: number;
  /** ZIP codes searched for this city (each searched with every search term). */
  zipCount: number;
  /** Newest finished run of this city, if any: reused instead of scraping again when younger than reuseDays. */
  lastRun: { runId: number; finishedAt: string } | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs

export interface JobSettings {
  minRating: number; // default 4.7
  minReviews: number; // default 10
  maxReviews: number; // default 99
  /** Reuse a city's finished run younger than this many days instead of scraping it again (0 = always scrape). */
  reuseDays: number; // default 30
  /** Google Maps search terms, each searched in every ZIP. */
  terms: string[];
}

export const DEFAULT_JOB_SETTINGS: JobSettings = {
  minRating: 4.7,
  minReviews: 10,
  maxReviews: 99,
  reuseDays: 30,
  terms: ['house painter', 'painting contractor', 'interior painter', 'exterior house painting', 'cabinet painting'],
};

/** POST /api/jobs (operator, admin) → 201 JobDetail */
export interface CreateJobBody {
  /** Empty = "<states> — <n> cities". */
  name?: string;
  /** Cities to cover, in the order given (the client sends them biggest first). At least one. */
  areaIds: string[];
  settings: JobSettings;
}

export interface JobSummary {
  id: number;
  name: string;
  status: JobStatus;
  states: StateCode[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string | null;
  cityCount: number;
  citiesDone: number;
  /** 0..1 over all cities (finished cities count 1, a running city its own fraction). */
  progress: number;
  exportStatus: ExportStatus;
  /** Present once the export is built. */
  counts: LeadCounts | null;
}

export interface LeadCounts {
  painting: number;
  check: number;
  likely: number;
}

export interface AreaProgress {
  searchesDone: number;
  searchesTotal: number;
  placesDone: number;
  placesTotal: number;
  /** Companies after merging duplicate listings. */
  companies: number;
  /** Painting companies inside the city. */
  painters: number;
  /** Qualified under the job's thresholds is only known after the export; this is the run's own count. */
  qualified: number;
  /** Which step the city is in. */
  stage: 'queued' | 'searching' | 'reading listings' | 'checking websites' | 'finishing' | 'done';
}

export interface JobArea {
  id: number;
  areaId: string;
  label: string;
  state: StateCode;
  status: JobAreaStatus;
  runId: number | null;
  attempts: number;
  message: string | null;
  notBefore: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  progress: AreaProgress | null;
}

/** GET /api/jobs → JobSummary[] (newest first) · GET /api/jobs/:id → JobDetail */
export interface JobDetail extends JobSummary {
  settings: JobSettings;
  error: string | null;
  exportError: string | null;
  exportBuiltAt: string | null;
  areas: JobArea[];
  /** Rough minutes left (null when unknown). */
  etaMinutes: number | null;
}
// POST /api/jobs/:id/cancel          (operator, admin) → 200 JobDetail  — queued cities stop; a running city finishes first
// POST /api/jobs/:id/retry           (operator, admin) → 200 JobDetail  — failed/cancelled cities queued again
// POST /api/jobs/:id/rebuild-export  (operator, admin) → 202 JobDetail
// GET  /api/jobs/:id/export.xlsx                       → the workbook (Summary, Painting companies, Check first, Likely fits)
// GET  /api/jobs/:id/export.csv?list=painting|check|likely|all  (default all) → CSV (UTF-8 with BOM)

// ---------------------------------------------------------------------------------------------------------------
// Leads (rows of a built export)

/** GET /api/jobs/:id/leads → LeadRow[] (404 until the export is ready) */
export interface LeadRow {
  companyId: number;
  runId: number;
  list: LeadList;
  /** Likely fits only: plain words, e.g. "Also does commercial work". */
  whyNot: string | null;
  areaId: string;
  /** The city searched, e.g. "Los Angeles, CA". */
  searchCity: string;
  company: string;
  owner: string | null;
  ownerTitle: string | null;
  ownerSource: string | null;
  ownerConfidence: string | null;
  phone: string | null;
  email: string | null;
  emailSource: string | null;
  website: string | null;
  rating: number | null;
  reviews: number | null;
  googleUrl: string | null;
  category: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  state: StateCode;
  licence: string | null;
  residentialStatus: string | null;
  firstSeen: string | null;
  lastChecked: string | null;
}

/** Stored with the export (job_exports.summary). */
export interface ExportSummary {
  builtAt: string;
  counts: LeadCounts;
  byState: Record<string, LeadCounts>;
  /** Filled-in counts for the painting list: field label → number filled. */
  fill: { owner: number; phone: number; email: number; website: number };
  citiesIncluded: number;
}

/** GET /api/companies/:id/sources → SourceRow[] — every accepted value behind a lead, with where and when it was read. */
export interface SourceRow {
  field: string;
  value: string;
  sourceUrl: string | null;
  sourceLabel: string;
  capturedAt: string;
  confidence: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// System

/** GET /api/overview → Overview */
export interface Overview {
  jobsRunning: number;
  jobsQueued: number;
  /** Totals over every ready export (a company counted once, by its newest export). */
  leads: LeadCounts;
  workers: WorkerInfo[];
}
export interface WorkerInfo {
  id: string;
  lastSeenAt: string;
  online: boolean;
  /** "Houston, TX (job 4)" or null when idle. */
  doing: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Users (admin only)

export interface UserRow {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}
/** POST /api/users → 201 UserRow */
export interface CreateUserBody {
  email: string;
  name: string;
  role: Role;
  password: string;
}
/** PATCH /api/users/:id → 200 UserRow (any subset; password resets it) */
export interface UpdateUserBody {
  name?: string;
  role?: Role;
  disabled?: boolean;
  password?: string;
}
// GET /api/users → UserRow[]

// ---------------------------------------------------------------------------------------------------------------
// Rough time (shared by the New search summary and the job page)

/** Measured on Railway 28 Oct: a city costs a fixed part (websites, registries, finishing) plus a part per ZIP. */
export const MINUTES_PER_CITY = 5;
export const MINUTES_PER_ZIP = 1.5;
/** Workers on Railway; one state runs one city at a time. */
export const WORKERS = 2;

/** Rough minutes to scrape these cities: each city's work (times what is left of it), spread over the workers,
 *  but never less than the busiest state, whose cities run one after another. */
export function estimateMinutes(cities: { state: string; zipCount: number; left?: number }[], workers = WORKERS): number {
  const byState = new Map<string, number>();
  for (const c of cities) {
    const m = (MINUTES_PER_CITY + c.zipCount * MINUTES_PER_ZIP) * (c.left ?? 1);
    byState.set(c.state, (byState.get(c.state) ?? 0) + m);
  }
  const total = [...byState.values()].reduce((s, m) => s + m, 0);
  return Math.max(total / Math.max(1, workers), ...byState.values(), 0);
}
