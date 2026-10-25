import { type DnsResolver, type Fetcher, type FetchSession, type ReportResult, type SourceType, type StageRegistry } from '@pp/core';
import { runCompanyIds } from './data';
import { stageContext, type PilotEnv } from './env';
import { enrichCompanies, type EnrichOptions } from './enrich';
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
}

export interface ReprocessResult {
  superseded: number;
  report: ReportResult;
}

/**
 * The fix loop (01-06): re-run site-enrich -> site-finalize -> registries-match -> classify -> qualify -> report from
 * the page cache only. Earlier evidence of the chosen steps is marked rejected 'superseded' first (history stays,
 * nothing is deleted), so a changed extractor replaces its old answers instead of adding to them.
 */
export async function reprocessRun(env: PilotEnv, runId: number, o: ReprocessOptions = {}): Promise<ReprocessResult> {
  const steps = o.steps ?? new Set(REPROCESS_STEPS);
  const stages = o.stages ?? resolveStages({ fake: o.fake });
  const offline: PilotEnv = { ...env, fetcher: env.fetcher ? offlineFetcher(env.fetcher) : env.fetcher };
  const ctx = stageContext(offline, runId);

  const ids = await runCompanyIds(env.db, runId);
  let superseded = 0;
  for (const step of REPROCESS_STEPS) {
    if (!steps.has(step) || step === 'classify') continue;
    const res = await q<{ id: number }>(
      env.db,
      `UPDATE evidence SET status = 'rejected', reject_reason = 'superseded'
         WHERE company_id = ANY($1::int[]) AND status = 'accepted' AND source_type = ANY($2::text[])
           AND extractor <> 'pipeline/classify'
       RETURNING id`,
      [ids, SOURCES_OF_STEP[step]],
    );
    superseded += res.length;
  }

  const enrichOpts: EnrichOptions = { refresh: true, steps, resolver: o.resolver };
  await enrichCompanies(ctx, stages, runId, enrichOpts);
  await qualifyRun(env.db, env.config, runId);

  const base = resolveOutDir(env.config, o.outDir);
  const report = await generateReport(env.db, env.config, runId, base);
  await writeYieldCsv(runOutputDir(base, runId), await computeYields(env.db, runId));
  env.out(`run ${runId} reprocessed (${[...steps].join(', ')}); ${superseded} earlier values superseded`);
  env.out(`xlsx: ${report.xlsxPath}`);
  return { superseded, report };
}
