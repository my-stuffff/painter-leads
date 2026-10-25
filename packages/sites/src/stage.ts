import {
  createDnsResolver,
  loadAreas,
  registrableDomain,
  type ClassifyInput,
  type CompanyRef,
  type Db,
  type DnsResolver,
  type EvidenceRow,
  type ResidentialDecision,
  type SiteEnrichResult,
  type SiteStatus,
  type Stage,
  type StageContext,
  type StateCode,
} from '@pp/core';
import { crawlSite } from './crawl/crawl';
import type { Renderer } from './crawl/render';
import { extractEmails } from './emails/extract';
import { emailKind } from './emails/rank';
import {
  CLASSIFY_EXTRACTOR,
  emailDrafts,
  EMAIL_EXTRACTOR,
  LICENCE_EXTRACTOR,
  licenceDrafts,
  mailDomainChecks,
  OWNER_EXTRACTOR,
  ownerDrafts,
  RESIDENTIAL_EXTRACTOR,
  signalDrafts,
  type CrawlMeta,
} from './evidence';
import { scanNjHicNumbers } from './licence';
import { acceptedOwners, extractOwners } from './owners/extract';
import { siteFinalizeStage } from './owners/template';
import { classifyResidential } from './residential/classify';
import { crawlStats, extractSignals, type SignalHit } from './residential/signals';

export { siteFinalizeStage };

export interface SiteStageOptions {
  /** DNS resolver for the MX check (default: system resolver). */
  resolver?: DnsResolver;
  /** Fetcher cache and recorded MX results only: no network, no browser. */
  offline?: boolean;
  /** Injected Chromium renderer (tests). */
  renderer?: Renderer;
}

const OFFLINE_RESOLVER: DnsResolver = {
  async resolveMx() {
    throw new Error('offline: DNS lookups are disabled');
  },
  async resolve4() {
    throw new Error('offline: DNS lookups are disabled');
  },
  async resolve6() {
    throw new Error('offline: DNS lookups are disabled');
  },
};

function areaCities(ctx: StageContext): string[] {
  try {
    return loadAreas(ctx.config).map((a) => a.city);
  } catch {
    return [];
  }
}

const SITE_EXTRACTORS = [EMAIL_EXTRACTOR, OWNER_EXTRACTOR, LICENCE_EXTRACTOR, RESIDENTIAL_EXTRACTOR];

/**
 * Stage 'site-enrich': crawl the company website, then emails, owners (with filler protection),
 * the 13VH number and residential signals, all as evidence rows. Re-running replaces this stage's
 * earlier rows for the company (the fix loop re-runs it from the cache).
 */
export function createSiteEnrichStage(opts: SiteStageOptions = {}): Stage<CompanyRef, SiteEnrichResult> {
  return {
    name: 'site-enrich',
    async run(ctx, company) {
      const crawl = await crawlSite(
        { fetcher: ctx.fetcher, config: ctx.config, log: ctx.log, runId: ctx.runId, offline: opts.offline, db: ctx.db ?? null, renderer: opts.renderer },
        { companyId: company.companyId, websiteUrl: company.websiteUrl },
      );
      const capturedAt = ctx.now();
      const websiteUrl = company.websiteUrl ?? '';

      const owners = extractOwners(crawl.pages, {
        companyName: company.name,
        city: company.city,
        cities: areaCities(ctx),
        confidence: ctx.config.confidence.websiteOwner,
      });
      const ownerNames = acceptedOwners(owners).map((o) => o.name);

      const findings = extractEmails(crawl.pages, { websiteUrl, ownDomains: crawl.ownDomains }, crawl.bundles);
      const resolver = opts.offline ? OFFLINE_RESOLVER : (opts.resolver ?? (findings.some((f) => f.accepted) ? createDnsResolver() : OFFLINE_RESOLVER));
      const checks = await mailDomainChecks(findings, resolver, ctx.db ?? null, { cacheOnly: opts.offline, now: ctx.now });

      const licences = scanNjHicNumbers(crawl.pages);
      const hits = extractSignals(crawl.pages);
      const stats = crawlStats(crawl.pages);
      const meta: CrawlMeta = { pages: stats.pages, chars: stats.chars, serviceContent: stats.serviceContent };
      const pageMap = new Map(crawl.pages.map((p) => [p.url, { sha256: p.sha256, rendered: p.rendered }]));
      // signals carry the URL of the page they came from; a crawled page may have redirected
      for (const p of crawl.pages) pageMap.set(p.finalUrl, { sha256: p.sha256, rendered: p.rendered });

      const drafts = [
        ...emailDrafts(findings, { companyId: company.companyId, capturedAt, checks, kindOf: (a) => emailKind(a, ownerNames) }),
        ...ownerDrafts(owners, { companyId: company.companyId, capturedAt }),
        ...licenceDrafts(licences, { companyId: company.companyId, capturedAt }),
        ...signalDrafts(hits, { companyId: company.companyId, capturedAt, extractor: RESIDENTIAL_EXTRACTOR, pages: pageMap, crawl: meta }),
      ];

      if (ctx.db) {
        await ctx.db.$client.query('DELETE FROM evidence WHERE company_id = $1 AND extractor = ANY($2::text[])', [company.companyId, SITE_EXTRACTORS]);
        await ctx.db.$client.query('UPDATE companies SET site_status = $2, updated_at = now() WHERE id = $1', [company.companyId, crawl.status]);
      }
      await ctx.evidence.recordMany(drafts);

      return {
        companyId: company.companyId,
        status: crawl.status,
        pages: crawl.pages.map((p) => ({ url: p.url, sha256: p.sha256, rendered: p.rendered })),
        emails: new Set(findings.filter((f) => f.accepted && checks.get(f.address.slice(f.address.lastIndexOf('@') + 1))?.accept !== false).map((f) => f.address)).size,
        owners: new Set(acceptedOwners(owners).map((o) => o.name.toLowerCase())).size,
        licenceNumbers: [...new Set(licences.map((l) => l.number))],
        residentialSignals: hits.filter((h) => !h.negated).length,
      };
    },
  };
}

export const siteEnrichStage = createSiteEnrichStage();

function rowToHit(r: EvidenceRow): SignalHit {
  const [polarity] = r.value.split(':');
  const a = r.attrs as { id?: string; strength?: 'strong' | 'weak'; text?: string; pos?: number };
  return {
    polarity: polarity as SignalHit['polarity'],
    id: a.id ?? r.value.slice(r.value.indexOf(':') + 1),
    text: a.text ?? '',
    sourceType: r.sourceType as SignalHit['sourceType'],
    sourceUrl: r.sourceUrl,
    snippet: r.snippet,
    strength: a.strength ?? 'strong',
    negated: r.status === 'rejected' && r.rejectReason === 'negated',
    position: a.pos ?? 0,
  };
}

function byPageThenPosition(a: SignalHit, b: SignalHit): number {
  return (a.sourceUrl < b.sourceUrl ? -1 : a.sourceUrl > b.sourceUrl ? 1 : 0) || a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Stage 'classify': the company's website signal evidence plus the Google category / name signals,
 * decided by classifyResidential; writes companies.residential_status and residential_reason.
 */
export const classifyStage: Stage<ClassifyInput, ResidentialDecision> = {
  name: 'classify',
  async run(ctx, input) {
    const { company } = input;
    const rows = await ctx.evidence.listForCompany(company.companyId, 'residential_signal');
    const siteRows = rows.filter((r) => r.extractor === RESIDENTIAL_EXTRACTOR);
    const siteHits = siteRows.map(rowToHit).sort(byPageThenPosition);
    const crawl = (siteRows.find((r) => r.attrs.crawl)?.attrs.crawl ?? { pages: 0, chars: 0, serviceContent: false }) as CrawlMeta;

    let googleUrl = 'https://www.google.com/maps';
    if (ctx.db) {
      const r = await ctx.db.$client.query<{ profile_url: string }>(
        'SELECT l.profile_url FROM companies c JOIN listings l ON l.id = c.primary_listing_id WHERE c.id = $1',
        [company.companyId],
      );
      if (r.rows[0]) googleUrl = r.rows[0].profile_url;
    }
    const googleHits = extractSignals([], { categories: company.categories, name: company.name, googleUrl });

    const decision = classifyResidential({
      signals: [...googleHits, ...siteHits],
      siteStatus: input.siteStatus,
      pagesCrawled: crawl.pages,
      visibleChars: crawl.chars,
      hasServiceContent: crawl.serviceContent,
      njHicActive: input.njHicActive,
    });

    if (ctx.db) {
      await ctx.db.$client.query('DELETE FROM evidence WHERE company_id = $1 AND extractor = $2', [company.companyId, CLASSIFY_EXTRACTOR]);
      await ctx.db.$client.query('UPDATE companies SET residential_status = $2, residential_reason = $3, updated_at = now() WHERE id = $1', [
        company.companyId,
        decision.label,
        decision.reason,
      ]);
    }
    await ctx.evidence.recordMany(signalDrafts(googleHits, { companyId: company.companyId, capturedAt: ctx.now(), extractor: CLASSIFY_EXTRACTOR }));
    return decision;
  },
};

/** Scheduling key: companies on one registrable domain (or shared-host address) never run together. */
function domainKey(c: CompanyRef): string {
  if (!c.websiteUrl) return `no-site:${c.companyId}`;
  const r = registrableDomain(c.websiteUrl);
  return r.sharedHost ? r.host : (r.domain ?? r.host ?? `company:${c.companyId}`);
}

export interface EnrichOutcome {
  company: CompanyRef;
  result: SiteEnrichResult | null;
  error: string | null;
}

/**
 * Runs the stage over many companies with at most `concurrency` at once (config.crawl.concurrency),
 * never two on the same domain. A company that fails is reported, not fatal.
 */
export async function enrichCompanies(
  ctx: StageContext,
  stage: Stage<CompanyRef, SiteEnrichResult>,
  companies: CompanyRef[],
  concurrency = ctx.config.crawl.concurrency,
): Promise<EnrichOutcome[]> {
  const out: EnrichOutcome[] = new Array<EnrichOutcome>(companies.length);
  const pending = companies.map((company, index) => ({ company, index, key: domainKey(company) }));
  const busy = new Set<string>();
  const running = new Set<Promise<void>>();

  while (pending.length > 0 || running.size > 0) {
    while (running.size < concurrency) {
      const at = pending.findIndex((p) => !busy.has(p.key));
      if (at < 0) break;
      const [job] = pending.splice(at, 1);
      if (!job) break;
      busy.add(job.key);
      const p: Promise<void> = stage
        .run(ctx, job.company)
        .then(
          (result) => {
            out[job.index] = { company: job.company, result, error: null };
          },
          (e: unknown) => {
            ctx.log.warn({ companyId: job.company.companyId, err: (e as Error).message }, 'site-enrich failed');
            out[job.index] = { company: job.company, result: null, error: (e as Error).message };
          },
        )
        .finally(() => {
          busy.delete(job.key);
          running.delete(p);
        });
      running.add(p);
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }
  return out;
}

/** The companies of a run (or one company) as stage inputs, from the primary listing. */
export async function loadCompanyRefs(db: Db, runId: number, companyId?: number): Promise<CompanyRef[]> {
  const res = await db.$client.query<{
    id: number;
    display_name: string;
    state: string | null;
    city: string | null;
    zip: string | null;
    street: string | null;
    website_url: string | null;
    phone_e164: string | null;
    categories: string[] | null;
  }>(
    `SELECT c.id, c.display_name, COALESCE(c.state, l.state) AS state, l.city, l.zip, l.street, l.website_url, l.phone_e164, l.categories
       FROM companies c LEFT JOIN listings l ON l.id = c.primary_listing_id
      WHERE c.run_id = $1 ${companyId === undefined ? '' : 'AND c.id = $2'}
      ORDER BY c.id`,
    companyId === undefined ? [runId] : [runId, companyId],
  );
  return res.rows.map((r) => ({
    companyId: r.id,
    name: r.display_name,
    state: (r.state ?? 'NJ') as StateCode,
    city: r.city,
    zip: r.zip,
    street: r.street,
    websiteUrl: r.website_url,
    phoneE164: r.phone_e164,
    categories: r.categories ?? [],
  }));
}

/** Active / not active from the registry evidence of the company; null when no NJ HIC record was matched. */
export function njHicActiveFrom(rows: EvidenceRow[]): boolean | null {
  const nj = rows.filter((r) => r.field === 'licence_status' && (r.sourceType === 'nj_hic_roster' || r.sourceType === 'nj_hic_detail') && r.status !== 'rejected');
  if (nj.length === 0) return null;
  return nj.some((r) => /^active\b/i.test(r.value.trim()));
}

export type { SiteStatus };
