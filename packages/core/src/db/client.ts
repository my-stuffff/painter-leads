import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool };

export const DEFAULT_DEV_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/painter_leads';

export function createDb(url: string | undefined = process.env.DATABASE_URL): {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
} {
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

/** A Db or a transaction handle from db.transaction(): both can run queries. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];
