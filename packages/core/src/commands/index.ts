import { configCheckCommand } from './config';
import { dbMigrateCommand } from './db';
import { doctorCommand } from './doctor';
import { geoBuildCommand } from './geo';
import type { CommandSpec } from './types';

export const coreCommands: CommandSpec[] = [doctorCommand, dbMigrateCommand, configCheckCommand, geoBuildCommand];

export type { CommandContext, CommandSpec } from './types';
