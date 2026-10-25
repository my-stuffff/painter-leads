import type { CommandContext, Db, EvidenceStore, Fetcher, Logger, PpConfig, StageContext } from '@pp/core';

/** Everything the pipeline needs to run, independent of the CLI (tests build this directly). */
export interface PilotEnv {
  config: PpConfig;
  db: Db;
  evidence: EvidenceStore;
  fetcher: Fetcher;
  log: Logger;
  now(): Date;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
}

export function stageContext(env: PilotEnv, runId: number): StageContext {
  return {
    runId,
    config: env.config,
    db: env.db,
    evidence: env.evidence,
    fetcher: env.fetcher,
    log: env.log,
    now: () => env.now(),
    sleep: (ms) => env.sleep(ms),
  };
}

/** Builds the env from the CLI context. The fetcher (and its network use) is only created when real stages need it. */
export async function envFromCommand(cmd: CommandContext, o: { needFetcher: boolean }): Promise<PilotEnv> {
  const db = await cmd.db();
  return {
    config: cmd.config(),
    db,
    evidence: await cmd.evidence(),
    fetcher: o.needFetcher ? await cmd.fetcher() : (undefined as never),
    log: cmd.log,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    out: (line) => cmd.out(line),
  };
}
