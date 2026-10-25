import { createDnsResolver, type CommandSpec } from '@pp/core';
import { crawlSite } from './crawl/crawl';
import { extractEmails } from './emails/extract';
import { emailDrafts, mailDomainChecks } from './evidence';

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

export const commands: CommandSpec[] = [sitesCrawlCommand];
