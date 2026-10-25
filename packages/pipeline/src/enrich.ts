import {
  corroborate,
  registrableDomain,
  resolveOwnerConflicts,
  zip5,
  type CompanyRef,
  type DnsResolver,
  type EvidenceRow,
  type StageContext,
  type StageRegistry,
} from '@pp/core';
import {
  evidenceByCompany,
  listingsByCompany,
  loadCompanies,
  runCompanyIds,
  type CompanyRow,
  type ListingRow,
} from './data';
import { CLASSIFY_EXTRACTOR } from './report/rows';
import { q } from './sql';
import { checkListedWebsites } from './website-check';

export interface EnrichOptions {
  /** Re-run site-enrich and registries-match even for companies that already have a status. */
  refresh?: boolean;
  /** Run only these steps (reprocess). Default: all. */
  steps?: ReadonlySet<'site-enrich' | 'registries-match' | 'classify'>;
  /** Public resolver for the second lookup of a listed website that the crawl could not resolve (tests inject a fake). */
  resolver?: DnsResolver;
  /**
   * Cache-only run (reprocess): a company that had no site_status and whose pages are not in the cache is left
   * with site_status NULL and no residential decision, so it can never qualify on a site nobody read.
   */
  cacheOnly?: boolean;
  /** The context registries-match runs with (reprocess --live-registries gives it the live fetcher). Default: the same context. */
  registriesCtx?: StageContext;
  /** registries-match only touches companies that never ran or whose last run failed; matched ones are left alone. */
  registriesRetryOnly?: boolean;
}

/**
 * True when a company's registry lookup never ran or did not finish: an error on any source, or NJ towns whose
 * roster pull was skipped. `nj_hic_active` is the answer of a finished lookup, not a status.
 */
export function registryNeedsRetry(status: Record<string, unknown>): boolean {
  const keys = Object.keys(status).filter((k) => k !== 'nj_hic_active');
  return keys.length === 0 || keys.includes('nj_roster_skipped') || keys.some((k) => status[k] === 'error');
}

/** What the report says about a painter whose website pages are not in the cache (reprocess cannot fetch them). */
export const SITE_NOT_CACHED_REASON = 'website not read: its pages are not in the page cache (the offline fix loop does not fetch)';

export interface EnrichSummary {
  companies: number;
  siteEnriched: number;
  registryMatched: number;
  classified: number;
}

/** What a stage gets to know about a company: values from its listings, the first listing (the primary) wins. */
export function buildCompanyRef(c: CompanyRow, ls: ListingRow[], evidence: EvidenceRow[]): CompanyRef {
  const ordered = [...ls].sort((a, b) => Number(b.id === c.primaryListingId) - Number(a.id === c.primaryListingId) || a.id - b.id);
  const first = <K extends keyof ListingRow>(k: K): NonNullable<ListingRow[K]> | null => {
    const hit = ordered.map((l) => l[k]).find((v) => v !== null && v !== undefined && v !== '');
    return (hit ?? null) as NonNullable<ListingRow[K]> | null;
  };
  const categories = [
    ...new Set([
      ...ordered.flatMap((l) => l.categories),
      ...evidence.filter((e) => e.field === 'category' && e.status === 'accepted').map((e) => e.value),
    ]),
  ];
  return {
    companyId: c.id,
    name: c.displayName,
    state: c.state ?? 'NJ',
    city: first('city'),
    zip: zip5(first('zip')),
    street: first('street'),
    websiteUrl: first('websiteUrl'),
    phoneE164: first('phoneE164'),
    categories,
  };
}

function acceptedValues(rows: EvidenceRow[], field: EvidenceRow['field']): string[] {
  return [...new Set(rows.filter((r) => r.field === field && r.status === 'accepted').map((r) => r.valueNorm || r.value))];
}

const snippetOf = (s: string): string => (s.trim().length === 0 ? '(no text)' : s.trim().slice(0, 1000));

/**
 * D-16..D-25 wiring: for painting companies in the area run site-enrich (skip those with a site_status unless
 * refresh), site-finalize once, registries-match (skip those with a registry_status unless refresh), settle
 * owner / email agreement (registry beats website, two families agree -> high), then classify and store the
 * decision with its signals as evidence.
 */
export async function enrichCompanies(
  ctx: StageContext,
  stages: StageRegistry,
  runId: number,
  o: EnrichOptions = {},
): Promise<EnrichSummary> {
  const want = (s: 'site-enrich' | 'registries-match' | 'classify'): boolean => !o.steps || o.steps.has(s);
  const summary: EnrichSummary = { companies: 0, siteEnriched: 0, registryMatched: 0, classified: 0 };

  const ids = await runCompanyIds(ctx.db, runId);
  let companies = (await loadCompanies(ctx.db, ids)).filter((c) => c.painterStatus === 'painter' && c.inArea !== false);
  summary.companies = companies.length;
  const listings = await listingsByCompany(ctx.db, ids);

  const refOf = async (c: CompanyRow): Promise<CompanyRef> => {
    const ev = await ctx.evidence.listForCompany(c.id, 'category');
    return buildCompanyRef(c, listings.get(c.id) ?? [], ev);
  };

  const unread = new Set<number>();

  if (want('site-enrich')) {
    for (const c of companies) {
      if (c.siteStatus !== null && !o.refresh) continue;
      const result = await stages['site-enrich'].run(ctx, await refOf(c));
      const notCached =
        o.cacheOnly === true &&
        c.siteStatus === null &&
        result.pages.length === 0 &&
        (result.status === 'fetch_failed' || result.status === 'render_failed');
      if (notCached) unread.add(c.id);
      await q(ctx.db, `UPDATE companies SET site_status = $2, last_checked_at = now(), updated_at = now() WHERE id = $1`, [
        c.id,
        notCached ? null : result.status,
      ]);
      summary.siteEnriched += 1;
    }
    await checkListedWebsites(
      ctx,
      companies.map((c) => c.id),
      { resolver: o.resolver },
    );
    await stages['site-finalize'].run(ctx, { runId });
  }

  if (want('registries-match')) {
    const registriesCtx = o.registriesCtx ?? ctx;
    const evidence = await evidenceByCompany(ctx.db, companies.map((c) => c.id));
    for (const c of companies) {
      if (o.registriesRetryOnly) {
        if (!registryNeedsRetry(c.registryStatus)) continue;
      } else if (Object.keys(c.registryStatus).filter((k) => k !== 'nj_hic_active').length > 0 && !o.refresh) continue;
      const rows = evidence.get(c.id) ?? [];
      const ref = await refOf(c);
      const dom = ref.websiteUrl ? registrableDomain(ref.websiteUrl) : null;
      const result = await stages['registries-match'].run(registriesCtx, {
        company: ref,
        emails: acceptedValues(rows, 'email'),
        licenceNumbers: [...new Set([...acceptedValues(rows, 'nj_hic_number'), ...acceptedValues(rows, 'licence_number')])],
        websiteDomain: dom && !dom.sharedHost ? dom.domain : null,
      });
      await q(ctx.db, `UPDATE companies SET registry_status = registry_status || $2::jsonb, updated_at = now() WHERE id = $1`, [
        c.id,
        JSON.stringify(result.status),
      ]);
      if (Object.keys(result.status).length > 0) summary.registryMatched += 1;
    }
  }

  for (const c of companies) {
    await resolveOwnerConflicts(ctx.db, c.id);
    await corroborate(ctx.db, c.id, 'owner_name');
    await corroborate(ctx.db, c.id, 'email');
  }

  if (want('classify')) {
    companies = await loadCompanies(ctx.db, companies.map((c) => c.id));
    for (const c of companies) {
      if (unread.has(c.id)) {
        // no pages were read, so there is nothing to classify on: 'unclear' keeps it out of Qualified
        await q(
          ctx.db,
          `UPDATE companies SET residential_status = NULL, residential_reason = $2, updated_at = now() WHERE id = $1`,
          [c.id, SITE_NOT_CACHED_REASON],
        );
        for (const old of await ctx.evidence.listForCompany(c.id, 'residential_signal')) {
          if (old.extractor === CLASSIFY_EXTRACTOR && old.status === 'accepted') await ctx.evidence.reject(old.id, 'superseded');
        }
        continue;
      }
      const njHic = c.registryStatus.nj_hic_active;
      const decision = await stages.classify.run(ctx, {
        company: await refOf(c),
        njHicActive: typeof njHic === 'boolean' ? njHic : null,
        siteStatus: (c.siteStatus as never) ?? null,
      });
      await q(
        ctx.db,
        `UPDATE companies SET residential_status = $2, residential_reason = $3, updated_at = now() WHERE id = $1`,
        [c.id, decision.label, decision.reason],
      );
      for (const old of await ctx.evidence.listForCompany(c.id, 'residential_signal')) {
        if (old.extractor === CLASSIFY_EXTRACTOR && old.status === 'accepted') await ctx.evidence.reject(old.id, 'superseded');
      }
      if (decision.signals.length > 0) {
        await ctx.evidence.recordMany(
          decision.signals.map((s) => ({
            companyId: c.id,
            field: 'residential_signal' as const,
            value: `${s.polarity}: ${s.text}`,
            sourceType: s.sourceType,
            sourceUrl: s.sourceUrl,
            capturedAt: ctx.now(),
            snippet: snippetOf(s.snippet || s.text),
            extractor: CLASSIFY_EXTRACTOR,
            extractorVersion: '1',
            confidence: s.strength === 'strong' ? ('high' as const) : ('medium' as const),
            attrs: { polarity: s.polarity, id: s.id, strength: s.strength, label: decision.label },
          })),
        );
      }
      summary.classified += 1;
    }
  }

  return summary;
}
