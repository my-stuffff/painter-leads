import { createLogger, createDnsResolver, DbEvidenceStore, type CommandContext, type CommandSpec, type StageContext } from '@pp/core';
import { crawlSite } from './crawl/crawl';
import { extractEmails } from './emails/extract';
import { emailDrafts, mailDomainChecks } from './evidence';
import { buildFirstNamesFiles } from './owners/names';
import { siteFinalizeStage } from './owners/template';
import { classifyStage, createSiteEnrichStage, enrichCompanies, loadCompanyRefs, njHicActiveFrom } from './stage';

export const sitesCrawlCommand: CommandSpec = {
  name: 'sites crawl',
  description: 'Crawl one company website through the polite fetcher and list the emails found (accepted and rejected)',
  args: [{ name: 'url', required: true, description: 'Website address' }],
  options: [
    { flags: '--company-id <n>', description: 'Store the email evidence for this company (needs DATABASE_URL)' },
    { flags: '--max-internal <n>', description: 'Internal pages to fetch besides the home page (default from pp.config.json)' },
    { flags: '--no-bundles', description: 'Do not fetch same-site JavaScript bundles' },
    { flags: '--offline', description: 'Fetcher cache only: no network, no browser, no DNS lookups' },
    { flags: '--json', description: 'Print JSON instead of text' },
  ],
  async run(ctx, args, opts) {
    const url = args[0];
    if (!url) throw new Error('usage: pp sites crawl <url>');
    const config = ctx.config();
    const fetcher = await ctx.fetcher();
    const db = process.env.DATABASE_URL ? await ctx.db() : null;
    const offline = opts.offline === true;
    const maxInternal = opts.maxInternal === undefined ? undefined : Number(opts.maxInternal);
    const companyId = opts.companyId === undefined ? undefined : Number(opts.companyId);
    if (companyId !== undefined && !db) throw new Error('--company-id needs DATABASE_URL');

    const crawl = await crawlSite(
      { fetcher, config, log: ctx.log, db, offline, maxInternalPages: maxInternal, fetchBundles: opts.bundles !== false },
      { websiteUrl: url },
    );
    const findings = extractEmails(crawl.pages, { websiteUrl: url, ownDomains: crawl.ownDomains }, crawl.bundles);
    const checks = await mailDomainChecks(findings, createDnsResolver(), db, { cacheOnly: offline });
    const capturedAt = new Date();
    const drafts = emailDrafts(findings, { companyId: companyId ?? 0, capturedAt, checks });
    if (companyId !== undefined) {
      const store = await ctx.evidence();
      await store.recordMany(drafts);
    }

    if (opts.json === true) {
      ctx.out(
        JSON.stringify(
          {
            status: crawl.status,
            ownDomains: crawl.ownDomains,
            pages: crawl.pages.map((p) => ({
              url: p.url,
              finalUrl: p.finalUrl,
              sha256: p.sha256,
              cachePath: p.cachePath,
              rendered: p.rendered,
              renderFailed: p.renderFailed,
              visibleChars: p.visible.text.length,
            })),
            bundles: crawl.bundles.map((b) => ({ url: b.url, sha256: b.sha256, chars: b.text.length })),
            emails: drafts.map((d) => ({
              value: d.value,
              status: d.status,
              reason: d.rejectReason,
              sourceUrl: d.sourceUrl,
              snippet: d.snippet,
              attrs: d.attrs,
            })),
            errors: crawl.errors,
          },
          null,
          2,
        ),
      );
      return;
    }
    ctx.out(`status: ${crawl.status}`);
    ctx.out(`pages: ${crawl.pages.length}`);
    for (const p of crawl.pages) {
      ctx.out(`  ${p.url}${p.rendered ? ' (rendered)' : ''}${p.renderFailed ? ' (render failed)' : ''} ${p.visible.text.length} chars`);
    }
    const accepted = drafts.filter((d) => d.status === 'accepted');
    ctx.out(`emails accepted: ${accepted.length}`);
    for (const d of accepted) {
      ctx.out(`  ${d.value} [${(d.attrs?.methods as string[]).join(',')}] ${String(d.attrs?.kind)} ${d.sourceUrl}`);
    }
    const rest = drafts.filter((d) => d.status !== 'accepted');
    ctx.out(`emails rejected / needs review: ${rest.length}`);
    for (const d of rest) ctx.out(`  ${d.value} (${d.status}: ${d.rejectReason}) ${d.sourceUrl}`);
    for (const e of crawl.errors) ctx.out(`error: ${e.url}: ${e.error}`);
  },
};

export const sitesNamesBuildCommand: CommandSpec = {
  name: 'sites names build',
  description: 'Build packages/sites/data/first-names.txt from the Census 1990 files (and the SSA files when given)',
  options: [
    { flags: '--census-dir <dir>', description: 'Read dist.male.first and dist.female.first from this folder instead of downloading' },
    { flags: '--ssa-dir <dir>', description: 'Folder of extracted SSA yobYYYY.txt files to union (names with a total count >= 50, 1930-2005)' },
  ],
  async run(ctx, _args, opts) {
    const censusDir = typeof opts.censusDir === 'string' ? opts.censusDir : undefined;
    const ssaDir = typeof opts.ssaDir === 'string' ? opts.ssaDir : undefined;
    const fetcher = censusDir ? null : await ctx.fetcher();
    const r = await buildFirstNamesFiles({ fetcher, censusDir, ssaDir });
    ctx.out(`first names: ${r.names.length} (census ${r.fromCensus}, ssa added ${r.fromSsa}, ssa files ${r.ssaFiles})`);
    for (const s of r.sources) ctx.out(`  ${s.url} sha256 ${s.sha256} (${s.lines} lines)`);
  },
};

async function stageContext(ctx: CommandContext, runId: number): Promise<StageContext> {
  const db = await ctx.db();
  return {
    runId,
    config: ctx.config(),
    db,
    evidence: new DbEvidenceStore(db),
    fetcher: await ctx.fetcher(),
    log: createLogger('sites'),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

function runArgs(opts: Record<string, unknown>): { runId: number; companyId?: number } {
  const runId = Number(opts.run);
  if (!Number.isInteger(runId) || runId <= 0) throw new Error('--run <n> is required');
  const companyId = opts.companyId === undefined ? undefined : Number(opts.companyId);
  return { runId, companyId };
}

export const sitesEnrichCommand: CommandSpec = {
  name: 'sites enrich',
  description: 'Crawl the websites of the companies in a run and record email, owner, 13VH and residential-signal evidence',
  options: [
    { flags: '--run <n>', description: 'Run id' },
    { flags: '--company-id <n>', description: 'Only this company' },
    { flags: '--offline', description: 'Fetcher cache only: no network, no browser, no DNS (the fix loop)' },
  ],
  async run(ctx, _args, opts) {
    const { runId, companyId } = runArgs(opts);
    const sctx = await stageContext(ctx, runId);
    const companies = await loadCompanyRefs(sctx.db, runId, companyId);
    const stage = createSiteEnrichStage({ offline: opts.offline === true });
    const outcomes = await enrichCompanies(sctx, stage, companies);
    const done = outcomes.filter((o) => o.result);
    const byStatus: Record<string, number> = {};
    for (const o of done) byStatus[o.result!.status] = (byStatus[o.result!.status] ?? 0) + 1;
    ctx.out(`companies: ${companies.length}, enriched: ${done.length}, failed: ${outcomes.length - done.length}`);
    ctx.out(`site status: ${JSON.stringify(byStatus)}`);
    ctx.out(`emails: ${done.reduce((n, o) => n + o.result!.emails, 0)}, owners: ${done.reduce((n, o) => n + o.result!.owners, 0)}, 13VH numbers: ${done.reduce((n, o) => n + o.result!.licenceNumbers.length, 0)}`);
    for (const o of outcomes.filter((x) => x.error)) ctx.out(`failed: company ${o.company.companyId} ${o.company.name}: ${o.error}`);
    if (companyId === undefined) {
      const fin = await siteFinalizeStage.run(sctx, { runId });
      ctx.out(`template names rejected: ${fin.templateNamesRejected}`);
    }
    return outcomes.some((o) => o.error) ? 1 : 0;
  },
};

export const sitesClassifyCommand: CommandSpec = {
  name: 'sites classify',
  description: 'Decide residential_only / residential_and_commercial / commercial_only / unclear for the companies in a run',
  options: [
    { flags: '--run <n>', description: 'Run id' },
    { flags: '--company-id <n>', description: 'Only this company' },
  ],
  async run(ctx, _args, opts) {
    const { runId, companyId } = runArgs(opts);
    const sctx = await stageContext(ctx, runId);
    const companies = await loadCompanyRefs(sctx.db, runId, companyId);
    const counts: Record<string, number> = {};
    for (const company of companies) {
      const status = await sctx.db.$client.query<{ site_status: string | null }>('SELECT site_status FROM companies WHERE id = $1', [company.companyId]);
      const registry = await sctx.evidence.listForCompany(company.companyId, 'licence_status');
      const decision = await classifyStage.run(sctx, {
        company,
        njHicActive: njHicActiveFrom(registry),
        siteStatus: (status.rows[0]?.site_status ?? null) as never,
      });
      counts[decision.label] = (counts[decision.label] ?? 0) + 1;
    }
    ctx.out(`classified: ${companies.length}`);
    for (const [label, n] of Object.entries(counts).sort()) ctx.out(`  ${label}: ${n}`);
  },
};

export const commands: CommandSpec[] = [sitesCrawlCommand, sitesEnrichCommand, sitesClassifyCommand, sitesNamesBuildCommand];
