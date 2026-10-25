import { configCheckCommand } from './config';
import { dbMigrateCommand } from './db';
import { doctorCommand } from './doctor';
import type { CommandSpec } from './types';

export const coreCommands: CommandSpec[] = [doctorCommand, dbMigrateCommand, configCheckCommand];

export type { CommandContext, CommandSpec } from './types';
