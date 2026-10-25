import type { Db } from '@pp/core';

/**
 * Plain parameterised SQL through the pool behind the drizzle handle. The pipeline package has no
 * query-builder dependency of its own (D-34: no new packages), so every statement is written out.
 * pg returns numeric as string and bigint as string; callers convert.
 */
export async function q<T extends object = Record<string, unknown>>(
  db: Db,
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const res = await db.$client.query(text, values);
  return res.rows as T[];
}

export async function q1<T extends object = Record<string, unknown>>(
  db: Db,
  text: string,
  values: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(db, text, values);
  return rows[0] ?? null;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
