import type { RegistrySourceStatus, SourceId } from '@pp/core';

/** What one source adapter gives back to the stage. */
export interface SourceOutcome {
  /** Per-source statuses the adapter decided (an adapter may report several sources, e.g. NJ). */
  statuses: Partial<Record<SourceId, RegistrySourceStatus>>;
  evidenceIds: number[];
  owners: number;
}

/** Options of one stage instance (the CLI's --source and --offline flags). */
export interface StageOptions {
  /** Run only these sources. */
  only?: ReadonlySet<SourceId>;
  /** Replay from the page cache only: no network (flows that need a live session are skipped as 'disabled'). */
  offline?: boolean;
}
