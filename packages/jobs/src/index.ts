import type { PackageModule } from '@pp/core';
import { jobCommands } from './commands';

/**
 * The web app's job engine: `pp worker` runs queued cities with the existing pipeline and builds each finished
 * job's export; `pp jobs export <jobId>` rebuilds one by hand. PackageModule names are a closed list in @pp/core
 * that predates this package, hence the cast (the name is only printed by `pp doctor`).
 */
export const packageModule: PackageModule = {
  name: 'jobs' as PackageModule['name'],
  commands: jobCommands,
  stages: {},
  replayers: {},
};

export { jobCommands } from './commands';
export { Worker, HEARTBEAT_MS, IDLE_MS, type WorkerOptions } from './worker';
export {
  runCity,
  freshDoneRun,
  nextUtcMidnight,
  MAX_BLOCKED_ATTEMPTS,
  MAX_ERROR_ATTEMPTS,
  MAX_CLAIMS,
  BLOCK_WAIT_MINUTES,
  ERROR_WAIT_MINUTES,
  type CityDeps,
} from './city';
export {
  claimNext,
  registerWorker,
  heartbeat,
  setAreaRun,
  finishArea,
  releaseArea,
  sweepCancelled,
  jobStatus,
  jobsReadyToFinish,
  takeExportBuild,
  CLAIM_LOCK_KEY,
  STALE_MINUTES,
  TERMINAL_AREA_STATUSES,
  type ClaimedArea,
  type AreaOutcome,
} from './queue';
export {
  finishJob,
  finishReadyJobs,
  rebuildJobExport,
  loadExportInput,
  saveJobExport,
  type FinishResult,
} from './finish';
export { buildExport, summarise, ruleLine, EXPORT_HEADERS, type BuiltExport, type ExportArea, type ExportInput } from './export';
export { pickList, dedupe, dedupeKey, compareRows, PAINTING_NAME, PAINTING_CATEGORIES, LIKELY_REASON_TEXT, type ListInput, type ListPick } from './lists';
export { readSettings, pipelineConfig, exportConfig } from './settings';
export { inAreaForRun, judgeAgainstRunArea } from './run-area';
