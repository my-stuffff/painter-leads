import { type DnsResolver, type Fetcher, type FetchSession, type ReportResult, type SourceType, type StageRegistry } from '@pp/core';
import { createSiteEnrichStage } from '@pp/sites';
import { loadCompanies, runCompanyIds } from './data';
import { stageContext, type PilotEnv } from './env';
import { enrichCompanies, registryNeedsRetry, type EnrichOptions } from './enrich';
import { applyPainterFilter } from './filter';
import { qualifyRun } from './qualify';
import { resolveOutDir, runOutputDir, generateReport } from './report/stage';
import { resolveStages } from './stages';
import { q } from './sql';
import { computeYields, writeYieldCsv } from './yields';

export type ReprocessStep = 'site-enrich' | 'registries-match' | 'classify';
export const REPROCESS_STEPS: ReprocessStep[] = ['site-enrich', 'registries-match', 'classify'];

/** Evidence written by each step, so a re-run can retire exactly what it is about to replace. */
const SOURCES_OF_STEP: Record<Exclude<ReprocessStep, 'classify'>, SourceType[]> = {
  'site-enrich': ['website'],
  'registries-match': ['cslb_master', 'cslb_personnel', 'cslb_lookup', 'nj_hic_roster', 'nj_hic_detail', 'nj_principal_search', 'tx_open_data', 'tx_comptroller', 'bbb'],
};

/**
 * The same fetcher, but every request is answered from the disk cache only (offline) and nothing goes out:
 * robots / SSRF checks are skipped because only pages that were already fetched under them can be read.
 */
export function offlineFetcher(f: Fetcher): Fetcher {
  const wrapSession = (s: FetchSession): FetchSession => ({
    get: (url, o) => s.get(url, { ...o, offline: true }),
    post: (url, form, o) => s.post(url, form, { ...o, offline: true }),
    cookies: () => s.cookies(),
  });
  return {
    get: (url, o) => f.get(url, { ...o, offline: true }),
    post: (url, form, o) => f.post(url, form, { ...o, offline: true }),
    session: (label, source) => wrapSession(f.session(label, source)),
    download: (url, dest, o) => f.download(url, dest, { ...o, offline: true }),
    robotsAllowed: async () => true,
    readCached: (sha) => f.readCached(sha),
    storeRendered: (url, html, o) => f.storeRendered(url, html, o),
    assertPublicUrl: async () => {},
  };
}

export interface ReprocessOptions {
  steps?: ReadonlySet<ReprocessStep>;
  fake?: boolean;
  stages?: StageRegistry;
  outDir?: string;
  /** Public resolver for the listed-website second lookup (default: 1.1.1.1 / 8.8.8.8). */
  resolver?: DnsResolver;
  /**
   * Gives ONLY registries-match the live fetcher (pages and sites stay cache-only) and makes it retry the companies
   * whose lookup never ran, errored, or skipped NJ towns; matched companies are not asked again. Needs PP_LIVE=1.
   */
  liveRegistries?: boolean;
}

export const LIVE_REGISTRIES_NEEDS_PP_LIVE =
  '--live-registries sends live requests to the registry sites: set PP_LIVE=1 to allow it';

export interface ReprocessResult {
  superseded: number;
  report: ReportResult;
}

/**
 * The fix loop (01-06): re-apply the painter filter, then re-run site-enrich -> site-finalize -> registries-match ->
 * classify -> qualify -> report from the page cache only (no new searches are planned; the area is left as it was).
 * Earlier evidence of the chosen steps is marked rejected 'superseded' first (history stays, nothing is deleted), so a
 * changed extractor replaces its old answers instead of adding to them. With `liveRegistries` the registries step
 * alone may go out to the registry sites, and only for companies whose lookup failed.
 */
export async function reprocessRun(env: PilotEnv, runId: number, o: ReprocessOptions = {}): Promise<ReprocessResult> {
  const steps = o.steps ?? new Set(REPROCESS_STEPS);
  const live = o.liveRegistries === true;
  if (live && process.env.PP_LIVE !== '1') throw new Error(LIVE_REGISTRIES_NEEDS_PP_LIVE);
  // The real site-enrich renders a short page in a browser unless told it is offline; with PP_LIVE=1 that would be
  // a live request, so the real stage is rebuilt cache-only here (a stage handed in by a test is used as it is).
  const given = o.stages ?? resolveStages({ fake: o.fake });
  const stages: StageRegistry = o.stages || o.fake ? given : { ...given, 'site-enrich': createSiteEnrichStage({ offline: true }) };
  const offline: PilotEnv = { ...env, fetcher: env.fetcher ? offlineFetcher(env.fetcher) : env.fetcher };
  const ctx = stageContext(offline, runId);
  const registriesCtx = live ? stageContext(env, runId) : undefined;

  // A classification rule fixed since the run (D-24) reaches the finished run here; no search is planned or run.
  await applyPainterFilter(env.db, runId);

  const ids = await runCompanyIds(env.db, runId);
  let superseded = 0;
  for (const step of REPROCESS_STEPS) {
    if (!steps.has(step) || step === 'classify') continue;
    let companyIds = ids;
    if (step === 'registries-match' && live) {
      // only the companies about to be asked again lose their old registry answers; matched ones keep theirs
      const painters = (await loadCompanies(env.db, ids)).filter((c) => c.painterStatus === 'painter' && c.inArea !== false);
      companyIds = painters.filter((c) => registryNeedsRetry(c.registryStatus)).map((c) => c.id);
    }
    const res = await q<{ id: number }>(
      env.db,
      `UPDATE evidence SET status = 'rejected', reject_reason = 'superseded'
         WHERE company_id = ANY($1::int[]) AND status = 'accepted' AND source_type = ANY($2::text[])
           AND extractor <> 'pipeline/classify'
       RETURNING id`,
      [companyIds, SOURCES_OF_STEP[step]],
    );
    superseded += res.length;
  }

  const enrichOpts: EnrichOptions = {
    refresh: true,
    steps,
    resolver: o.resolver,
    cacheOnly: true,
    registriesCtx,
    registriesRetryOnly: live,
  };
  await enrichCompanies(ctx, stages, runId, enrichOpts);
  await qualifyRun(env.db, env.config, runId);

  const base = resolveOutDir(env.config, o.outDir);
  const report = await generateReport(env.db, env.config, runId, base);
  await writeYieldCsv(runOutputDir(base, runId), await computeYields(env.db, runId));
  env.out(`run ${runId} reprocessed (${[...steps].join(', ')}${live ? '; registries live' : ''}); ${superseded} earlier values superseded`);
  env.out(`xlsx: ${report.xlsxPath}`);
  return { superseded, report };
}
