import type { GoldenReplayers, PackageModule, StageRegistry } from '@pp/core';
import { commands } from './commands';

export { commands };
export const stages: Partial<StageRegistry> = {};
export const replayers: Partial<GoldenReplayers> = {};

export const packageModule: PackageModule = { name: 'sites', commands, stages, replayers };
