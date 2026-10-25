import type { GoldenReplayers, PackageModule, StageRegistry } from '@pp/core';
import { commands } from './commands';
import { replayers as replay } from './replay';
import { registriesMatchStage } from './stage';

export { commands } from './commands';
export { registriesMatchStage, createRegistriesStage } from './stage';
export { hiddenFields, isAspNetError, postBack } from './aspnet';
export { matchLadder } from './match/ladder';
export { downloadCslbFile } from './cslb/download';
export { loadCslbMaster } from './cslb/master';
export { checkMasterComplete, checkPersonnelComplete } from './cslb/completeness';
export { loadCslbPersonnel } from './cslb/personnel';
export { lookupCslbPersonnel } from './cslb/lookup';
export { matchCslb } from './cslb/match';
export { pickCslbOwner } from './cslb/owner';
export { downloadNjRoster } from './nj/roster-flow';
export { parseNjRoster } from './nj/roster-parse';
export { matchNj } from './nj/match';
export { fetchNjOwner } from './nj/detail-flow';
export { confirmNjPrincipal } from './nj/principal-search';
export { ensureNjRosterForTown } from './nj/roster-ensure';
export { queryTxTaxpayers } from './tx/opendata';
export { matchTx } from './tx/match';
export { fetchTxOfficers } from './tx/comptroller';
export { isCorporateAgent } from './tx/agents';
export { parseBbbSitemapIndex, parseBbbSitemap } from './bbb/sitemaps';
export { parseBbbProfile } from './bbb/profile';
export { matchBbb } from './bbb/match';
export { BbbBreaker } from './bbb/breaker';
export { captureBbb, importBbb } from './bbb/capture';

export const stages: Partial<StageRegistry> = { 'registries-match': registriesMatchStage };
export const replayers: Partial<GoldenReplayers> = replay;

export const packageModule: PackageModule = { name: 'registries', commands, stages, replayers };
