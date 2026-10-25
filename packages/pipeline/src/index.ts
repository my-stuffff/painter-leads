import type { CommandSpec, GoldenReplayers, PackageModule, StageRegistry } from '@pp/core';
import { pilotCommands } from './commands';
import { mergeStage } from './merge';
import { qualifyStage } from './qualify';
import { reportStage } from './report/stage';

export const commands: CommandSpec[] = [...pilotCommands];
export const stages: Partial<StageRegistry> = { merge: mergeStage, qualify: qualifyStage, report: reportStage };
export const replayers: Partial<GoldenReplayers> = {};

export const packageModule: PackageModule = { name: 'pipeline', commands, stages, replayers };

export { planSearches } from './plan';
export { resolveStages } from './stages';
export { runPilot } from './run';
export { mergeRun, planMerge } from './merge';
export { flagFranchise } from './franchise';
export { classifyPainter } from './filter';
export { assignArea } from './area';
export { enrichCompanies } from './enrich';
export { qualify, qualifyStage } from './qualify';
export { PIPELINE_POLICY } from './select/policy';
export { buildReportData as buildReportRows } from './report/rows';
export { writeWorkbook } from './report/workbook';
export { sanitizeCell } from './report/sanitize';
export { computeYields } from './yields';
export {
  QUALIFIED_COLUMNS,
  MASTER_COLUMNS,
  BY_CITY_COLUMNS,
  COMPLETENESS_COLUMNS,
  SUMMARY_COLUMNS,
  SOURCES_COLUMNS,
} from './report/columns';
export { mergeStage, reportStage };
