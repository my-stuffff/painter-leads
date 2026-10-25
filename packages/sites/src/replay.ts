import type { GoldenPage, GoldenReplayers, SiteStatus } from '@pp/core';
import { acceptedAddresses, extractEmails } from './emails/extract';
import { acceptedOwners, extractOwners } from './owners/extract';
import { classifyResidential } from './residential/classify';
import { crawlStats, extractSignals } from './residential/signals';

const asPages = (pages: GoldenPage[]) => pages.map((p) => ({ url: p.url, html: p.html, rendered: p.rendered }));

/**
 * Golden replayers: the same extraction and classification rules run over saved pages. The MX check
 * is treated as recorded-ok offline, so these answer "which addresses would be accepted".
 */
export const replayers: Pick<GoldenReplayers, 'emails' | 'owners' | 'residential'> = {
  emails(pages, site) {
    return acceptedAddresses(extractEmails(asPages(pages), { websiteUrl: site.websiteUrl }));
  },

  owners(pages, site) {
    return acceptedOwners(extractOwners(asPages(pages), { companyName: site.companyName, city: site.city })).map((o) => ({
      name: o.name,
      title: o.title,
      confidence: o.confidence,
    }));
  },

  residential(input) {
    const pages = asPages(input.pages);
    const stats = crawlStats(pages);
    const siteStatus: SiteStatus = pages.length > 0 ? 'ok' : 'no_website';
    return classifyResidential({
      signals: extractSignals(pages, { categories: input.categories, name: input.name }),
      siteStatus,
      pagesCrawled: stats.pages,
      visibleChars: stats.chars,
      hasServiceContent: stats.serviceContent,
      njHicActive: input.njHicActive,
    });
  },
};
