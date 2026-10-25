import type { PackageModule, StageName, StageRegistry } from '@pp/core';
import { packageModule as maps } from '@pp/maps';
import { packageModule as registries } from '@pp/registries';
import { packageModule as sites } from '@pp/sites';
import { createDbFakeStages, type FakeStageOptions } from './fake-stages';
import { mergeStage } from './merge';
import { qualifyStage } from './qualify';
import { reportStage } from './report/stage';

/** The stages this package implements itself. */
export const ownStages = { merge: mergeStage, qualify: qualifyStage, report: reportStage } as const;

/** Pipeline order; also the order in which a missing stage is reported. */
export const STAGE_ORDER: StageName[] = [
  'discover',
  'detail',
  'merge',
  'site-enrich',
  'site-finalize',
  'registries-match',
  'classify',
  'qualify',
  'report',
];

/** Which package provides each stage. */
export const STAGE_PACKAGE: Record<StageName, PackageModule['name']> = {
  discover: 'maps',
  detail: 'maps',
  merge: 'pipeline',
  'site-enrich': 'sites',
  'site-finalize': 'sites',
  'registries-match': 'registries',
  classify: 'sites',
  qualify: 'pipeline',
  report: 'pipeline',
};

export interface ResolveOptions {
  /** Stand-ins for maps / sites / registries that write real rows (the pipeline's own stages stay real). */
  fake?: boolean;
  fakeOptions?: FakeStageOptions;
  /** The package modules to look stages up in (tests inject some); default maps, sites, registries. */
  modules?: PackageModule[];
}

/**
 * Looks every stage up by name. A stage nobody provides fails loudly with the package that is missing,
 * never with a silent skip.
 */
export function resolveStages(o: ResolveOptions = {}): StageRegistry {
  if (o.fake) return { ...createDbFakeStages(o.fakeOptions), ...ownStages };

  const modules = o.modules ?? [maps, sites, registries];
  const registry: Partial<Record<StageName, unknown>> = {};
  for (const name of STAGE_ORDER) {
    const pkg = STAGE_PACKAGE[name];
    const own = (ownStages as Record<string, unknown>)[name];
    const found = pkg === 'pipeline' ? own : modules.find((m) => m.name === pkg)?.stages[name];
    if (!found) throw new Error(`stage ${name} not provided (package ${pkg} not merged yet)`);
    registry[name] = found;
  }
  return registry as unknown as StageRegistry;
}
