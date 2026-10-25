import type { CommandSpec } from '../commands/types';
import type { PpConfig } from '../config/schema';
import type { Db } from '../db/client';
import type { EvidenceStore } from '../evidence/store';
import type { Fetcher } from '../fetch/types';
import type { Logger } from '../log';
import type {
  BlockSignal,
  Confidence,
  ExclusionReason,
  ResidentialLabel,
  SourceId,
  StateCode,
} from '../types';

export type StageName =
  | 'discover'
  | 'detail'
  | 'merge'
  | 'site-enrich'
  | 'site-finalize'
  | 'registries-match'
  | 'classify'
  | 'qualify'
  | 'report';

export interface StageContext {
  runId: number;
  config: PpConfig;
  db: Db;
  evidence: EvidenceStore;
  fetcher: Fetcher;
  log: Logger;
  now(): Date;
  sleep(ms: number): Promise<void>;
}

export interface Stage<I, O> {
  name: StageName;
  run(ctx: StageContext, input: I): Promise<O>;
}

export interface CompanyRef {
  companyId: number;
  name: string;
  state: StateCode;
  city: string | null;
  zip: string | null;
  street: string | null;
  websiteUrl: string | null;
  phoneE164: string | null;
  categories: string[];
}

export interface StopInfo {
  signal: BlockSignal;
  searchId: number | null;
  listingId: number | null;
  at: Date;
  detail: string;
}

export interface DiscoverInput {
  runId: number;
}
export interface DiscoverResult {
  searchesDone: number;
  searchesRemaining: number;
  cardsSeen: number;
  newListings: number;
  stopped: StopInfo | null;
}

export interface DetailInput {
  runId: number;
  retryLimited?: boolean;
  limit?: number;
}
export interface DetailResult {
  done: number;
  limitedView: number;
  failed: number;
  stopped: StopInfo | null;
}

export interface MergeInput {
  runId: number;
}
export interface MergeResult {
  companies: number;
  mergesByRung: Record<'place_id' | 'phone' | 'domain' | 'name_zip', number>;
  possibleDuplicates: number;
}

export type SiteStatus =
  | 'ok'
  | 'no_website'
  | 'shared_host'
  | 'robots_disallowed'
  | 'fetch_failed'
  | 'render_failed';

export interface SiteEnrichResult {
  companyId: number;
  status: SiteStatus;
  pages: { url: string; sha256: string; rendered: boolean }[];
  emails: number;
  owners: number;
  licenceNumbers: string[];
  residentialSignals: number;
}

export interface SiteFinalizeInput {
  runId: number;
}
export interface SiteFinalizeResult {
  templateNamesRejected: number;
}

export type RegistrySourceStatus =
  | 'matched'
  | 'candidate_only'
  | 'no_match'
  | 'blocked'
  | 'disabled'
  | 'error'
  | 'not_applicable';

export interface RegistryMatchInput {
  company: CompanyRef;
  emails: string[];
  licenceNumbers: string[];
  websiteDomain: string | null;
}
export interface RegistryMatchResult {
  companyId: number;
  status: Partial<Record<SourceId, RegistrySourceStatus>>;
  owners: number;
  evidenceIds: number[];
}

export interface ResidentialSignal {
  polarity: 'residential' | 'commercial' | 'negation';
  id: string;
  text: string;
  sourceType: 'google_maps' | 'website' | 'nj_hic_roster';
  sourceUrl: string;
  snippet: string;
  strength: 'strong' | 'weak';
}
export interface ResidentialDecision {
  label: ResidentialLabel;
  signals: ResidentialSignal[];
  reason: string;
}
export interface ClassifyInput {
  company: CompanyRef;
  njHicActive: boolean | null;
  siteStatus: SiteStatus | null;
}

export interface QualifyInput {
  companyId: number;
}
export interface QualifyResult {
  qualified: boolean;
  reasons: ExclusionReason[];
}

export interface ReportInput {
  runId: number;
  outDir: string;
}
export interface ReportResult {
  xlsxPath: string;
  masterCsvPath: string;
  qualifiedCsvPath: string;
  counts: Record<string, number>;
}

export interface StageRegistry {
  discover: Stage<DiscoverInput, DiscoverResult>;
  detail: Stage<DetailInput, DetailResult>;
  merge: Stage<MergeInput, MergeResult>;
  'site-enrich': Stage<CompanyRef, SiteEnrichResult>;
  'site-finalize': Stage<SiteFinalizeInput, SiteFinalizeResult>;
  'registries-match': Stage<RegistryMatchInput, RegistryMatchResult>;
  classify: Stage<ClassifyInput, ResidentialDecision>;
  qualify: Stage<QualifyInput, QualifyResult>;
  report: Stage<ReportInput, ReportResult>;
}

export interface GoldenPage {
  url: string;
  html: string;
  rendered: boolean;
}

export interface GoldenReplayers {
  mapsCard(
    snapshot: unknown,
  ): Partial<Record<'name' | 'rating' | 'review_count' | 'phone' | 'category' | 'website', string | null>>;
  emails(pages: GoldenPage[], site: { websiteUrl: string }): string[];
  owners(
    pages: GoldenPage[],
    site: { websiteUrl: string; companyName: string; city: string | null },
  ): { name: string; title: string | null; confidence: Confidence }[];
  residential(input: {
    pages: GoldenPage[];
    categories: string[];
    name: string;
    njHicActive: boolean | null;
  }): ResidentialDecision;
  registryMatch(input: {
    company: CompanyRef;
    candidates: unknown[];
  }): { sourceKey: string; strength: 'strong' | 'candidate' }[];
}

export interface PackageModule {
  name: 'core' | 'maps' | 'registries' | 'sites' | 'pipeline';
  commands: CommandSpec[];
  stages: Partial<StageRegistry>;
  replayers: Partial<GoldenReplayers>;
}
