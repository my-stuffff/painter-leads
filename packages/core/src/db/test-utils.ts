import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { PILOT_TABLES } from './schema';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/painter_leads_test_local';

/** Test database from TEST_DATABASE_URL (the vitest db project migrates it once in globalSetup). */
export function getTestDb(): { db: Db; close(): Promise<void> } {
  const { db, close } = createDb(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);
  return { db, close };
}

export async function truncateAll(db: Db): Promise<void> {
  const list = PILOT_TABLES.map((t) => `"${t}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
}
