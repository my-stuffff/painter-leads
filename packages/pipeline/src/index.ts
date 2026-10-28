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

// Used by @pp/jobs (the web app's workers): the run env, the report rows and the pure qualification step.
export { envFromCommand, type PilotEnv } from './env';
export type { RunOptions, RunOutcome } from './run';
export { evidenceByCompany, listingsByCompany, loadCompanies, loadRun, runCompanyIds, toEvidence } from './data';
export { decideArea } from './area';
export { policyFor, selectLatest } from './select/policy';
export { computeFacts, type QualifyFacts } from './qualify';
export { buildReportData, type Cell, type ReportCompany, type ReportData } from './report/rows';
export { BOM, csvText } from './report/csv';
export { safeHyperlink } from './report/sanitize';
export { LINK_COLUMNS, TEXT_COLUMNS } from './report/columns';
