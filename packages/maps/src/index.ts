import type { GoldenReplayers, PackageModule, StageRegistry } from '@pp/core';
import { commands } from './commands';
import { detailStage } from './detail';
import { discoverStage } from './discover';
import { mapsCard } from './replay';

export { commands } from './commands';
export { createDiscoverStage, discoverStage, type DiscoverDeps } from './discover';
export { createDetailStage, detailStage, type DetailDeps } from './detail';
export { runDatacentreTest, type DatacentreSummary } from './datacentre';
export { runProbe, probeOne, type ProbeResult, type ProbeRunOptions } from './probe/run';
export { buildRamp, StepMonitor, type ProbeStep, type StepSummary } from './probe/ramp';
export { runSmoke, SmokeBudgetError } from './smoke';
export { collectStatus } from './status';
export { detectBlock, isLimitedView } from './blocks';
export { buildSearchUrl, QUERY_FORM, type QueryForm } from './query';
export { randomPause } from './throttle';
export { remainingToday } from './cap';
export { parseCard, type ParsedCard } from './parse/card';
export { parsePlace, type ParsedPlace } from './parse/place';
export { parsePlaceUrl, profileLink } from './parse/url';
export { FixtureDriver } from './driver/fixture';
export { PlaywrightDriver } from './driver/playwright';
export type { CardSnapshot, PageDriver, PlaceSnapshot } from './driver/types';

export const stages: Partial<StageRegistry> = { discover: discoverStage, detail: detailStage };
export const replayers: Partial<GoldenReplayers> = { mapsCard };

export const packageModule: PackageModule = { name: 'maps', commands, stages, replayers };
