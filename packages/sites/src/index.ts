import type { CommandSpec, GoldenReplayers, PackageModule, StageRegistry } from '@pp/core';

export const commands: CommandSpec[] = [];
export const stages: Partial<StageRegistry> = {};
export const replayers: Partial<GoldenReplayers> = {};

export const packageModule: PackageModule = { name: 'sites', commands, stages, replayers };
