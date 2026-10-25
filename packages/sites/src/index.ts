import type { GoldenReplayers, PackageModule, StageRegistry } from '@pp/core';
import { commands } from './commands';
import { replayers as goldenReplayers } from './replay';
import { classifyStage, siteEnrichStage, siteFinalizeStage } from './stage';

export { commands };
export const stages: Partial<StageRegistry> = {
  'site-enrich': siteEnrichStage,
  'site-finalize': siteFinalizeStage,
  classify: classifyStage,
};
export const replayers: Partial<GoldenReplayers> = goldenReplayers;

export const packageModule: PackageModule = { name: 'sites', commands, stages, replayers };

export { crawlSite } from './crawl/crawl';
export { selectInternalLinks } from './crawl/links';
export { renderPage } from './crawl/render';
export { visibleText } from './crawl/visible-text';
export { decodeCfEmail } from './emails/cfemail';
export { extractEmails } from './emails/extract';
export { filterEmail } from './emails/filters';
export { checkMailDomain } from './emails/mx';
export { deobfuscate } from './emails/obfuscated';
export { rankEmails } from './emails/rank';
export { isFillerPage } from './filler';
export { scanNjHicNumbers } from './licence';
export { buildFirstNames, loadFirstNames } from './owners/names';
export { extractOwners } from './owners/extract';
export { validateOwnerName } from './owners/validate';
export { classifyResidential } from './residential/classify';
export { extractSignals } from './residential/signals';
export { classifyStage, createSiteEnrichStage, enrichCompanies, siteEnrichStage, siteFinalizeStage } from './stage';
