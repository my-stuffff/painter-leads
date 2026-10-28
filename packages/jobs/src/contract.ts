// The web app's contract (apps/web/src/shared/api.ts) is the one source of these types and defaults. The file has no
// imports of its own, so the workers can read it straight from the repo.
export {
  DEFAULT_JOB_SETTINGS,
  LEAD_LIST_LABEL,
  type ExportSummary,
  type JobAreaStatus,
  type JobSettings,
  type JobStatus,
  type LeadCounts,
  type LeadList,
  type LeadRow,
  type StateCode,
} from '../../../apps/web/src/shared/api';
