import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import type { Db } from './client';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));

interface JournalEntry {
  idx: number;
  tag: string;
}

export function migrationTags(): string[] {
  const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, 'utf8')) as {
    entries: JournalEntry[];
  };
  return journal.entries.map((e) => e.tag);
}

/** Applies pending migrations; returns the tags of every migration in the journal. */
export async function migrateDb(db: Db): Promise<string[]> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return migrationTags();
}

/** True when every journal migration has a row in drizzle.__drizzle_migrations. */
export async function migrationsApplied(db: Db): Promise<boolean> {
  try {
    const res = await db.$client.query<{ n: string }>('SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations');
    return Number(res.rows[0]?.n ?? 0) >= migrationTags().length;
  } catch {
    return false;
  }
}

/** Creates the database named in `url` (connecting to the `postgres` database first) if it is missing. */
export async function createDatabaseIfMissing(url: string): Promise<boolean> {
  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Refusing to create database with unusual name: ${name}`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount && exists.rowCount > 0) return false;
    await client.query(`CREATE DATABASE "${name}"`);
    return true;
  } finally {
    await client.end();
  }
}
