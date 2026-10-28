import type { Db } from '@pp/core';

/** Anything that runs a parameterised query: the pool behind a Db, or one checked-out client inside a transaction. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

const runner = (db: Db | Queryable): Queryable => ('$client' in db ? (db.$client as Queryable) : db);

/** Plain parameterised SQL (the same style as the pipeline package). */
export async function q<T extends object = Record<string, unknown>>(db: Db | Queryable, text: string, values: unknown[] = []): Promise<T[]> {
  const res = await runner(db).query(text, values);
  return res.rows as T[];
}

export async function q1<T extends object = Record<string, unknown>>(
  db: Db | Queryable,
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  return (await q<T>(db, text, values))[0] ?? null;
}

/** Runs `fn` in one transaction on one client (BEGIN / COMMIT, ROLLBACK on a throw). */
export async function inTransaction<T>(db: Db, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client as Queryable);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
