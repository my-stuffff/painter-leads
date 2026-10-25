import { coreCommands } from './commands';
import type { PackageModule } from './stages/types';

export * from './types';
export { createLogger, type Logger } from './log';
export { dataDir, REPO_ROOT } from './paths';
export { PpConfigSchema, type PpConfig } from './config/schema';
export { loadConfig, isSourceEnabled, defaultConfigPath } from './config/load';
export { createDb, type Db, type DbOrTx } from './db/client';
export { migrateDb, migrationsApplied, createDatabaseIfMissing } from './db/migrate';
export { getTestDb, truncateAll } from './db/test-utils';
export * as schema from './db/schema';
export * from './evidence';
export * from './fetch';
export * from './browser';
export * from './normalise';
export * from './geo';
export * from './stages/types';
export { createFakeStages } from './stages/fakes';
export { coreCommands, type CommandContext, type CommandSpec } from './commands';

export const packageModule: PackageModule = {
  name: 'core',
  commands: coreCommands,
  stages: {},
  replayers: {},
};
