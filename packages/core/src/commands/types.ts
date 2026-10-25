import type { PpConfig } from '../config/schema';
import type { Db } from '../db/client';
import type { EvidenceStore } from '../evidence/store';
import type { Fetcher } from '../fetch/types';
import type { Logger } from '../log';

export interface CommandContext {
  config(): PpConfig;
  db(): Promise<Db>;
  fetcher(): Promise<Fetcher>;
  evidence(): Promise<EvidenceStore>;
  log: Logger;
  out(line: string): void;
  /** Names of the registered packageModules, in registration order (set by the pp CLI). */
  moduleNames?: readonly string[];
}

export interface CommandSpec {
  /** Space-separated path, e.g. 'maps discover'. */
  name: string;
  description: string;
  args?: { name: string; required?: boolean; variadic?: boolean; description: string }[];
  options?: { flags: string; description: string; defaultValue?: string | boolean }[];
  /** A returned number becomes the process exit code (EXIT_BLOCKED = 3: stopped on a block). */
  run(ctx: CommandContext, args: string[], opts: Record<string, unknown>): Promise<number | void>;
}
