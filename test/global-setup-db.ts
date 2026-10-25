// Vitest globalSetup for the `db` project: one migrated database per worker (D-29).
import { createDb } from '../packages/core/src/db/client';
import { createDatabaseIfMissing, migrateDb } from '../packages/core/src/db/migrate';

const DEFAULT_URL = 'postgres://postgres:postgres@127.0.0.1:5432/painter_leads_test_local';

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  if (!/^painter_leads_test_[a-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing to run db tests against "${name}": database name must match ^painter_leads_test_[a-z0-9_]+$`);
  }
  process.env.TEST_DATABASE_URL = url;
  await createDatabaseIfMissing(url);
  const { db, close } = createDb(url);
  try {
    await migrateDb(db);
  } finally {
    await close();
  }
}
