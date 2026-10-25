import { createDb } from '../db/client';
import { createDatabaseIfMissing, migrateDb } from '../db/migrate';
import type { CommandSpec } from './types';

export const dbMigrateCommand: CommandSpec = {
  name: 'db migrate',
  description: 'Apply the database migrations to DATABASE_URL',
  options: [{ flags: '--create', description: 'create the database named in DATABASE_URL first', defaultValue: false }],
  async run(ctx, _args, opts) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    if (opts.create) {
      const created = await createDatabaseIfMissing(url);
      ctx.out(created ? 'database created' : 'database exists');
    }
    const { db, close } = createDb(url);
    try {
      const tags = await migrateDb(db);
      ctx.out(`migrations applied: ${tags.join(', ')}`);
    } finally {
      await close();
    }
  },
};
