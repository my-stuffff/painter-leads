import type pg from 'pg';

/** Runs a query and returns its rows (the server talks to Postgres in plain SQL, like packages/pipeline/src/sql.ts). */
export async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  pool: pg.Pool | pg.PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function q1<T extends pg.QueryResultRow = Record<string, unknown>>(
  pool: pg.Pool | pg.PoolClient,
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(pool, text, params);
  return rows[0] ?? null;
}

/** One transaction; rolled back when `fn` throws. */
export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const iso = (d: Date | string | null | undefined): string | null =>
  d === null || d === undefined ? null : new Date(d).toISOString();
