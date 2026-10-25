import type { GoldenReplayers, PackageModule, StageRegistry } from '@pp/core';
import { commands } from './commands';
import { registriesMatchStage } from './stage';

export { commands } from './commands';
export { registriesMatchStage, createRegistriesStage } from './stage';
export { hiddenFields, isAspNetError, postBack } from './aspnet';
export { matchLadder } from './match/ladder';
export { downloadCslbFile } from './cslb/download';
export { loadCslbMaster } from './cslb/master';
export { matchCslb } from './cslb/match';
export { pickCslbOwner } from './cslb/owner';

export const stages: Partial<StageRegistry> = { 'registries-match': registriesMatchStage };
export const replayers: Partial<GoldenReplayers> = {};

export const packageModule: PackageModule = { name: 'registries', commands, stages, replayers };
