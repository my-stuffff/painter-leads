import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataDir, type StageContext } from '@pp/core';
import { downloadNjRoster, townSlug } from './roster-flow';
import { loadNjRosterRows, parseNjRoster } from './roster-parse';

/** A roster pulled less than this many days ago is reused (the register changes slowly; fewer requests). */
export const ROSTER_MAX_AGE_DAYS = 7;

/** One roster flow at a time (the site is a state verification service): pulls queue up behind each other. */
let queue: Promise<unknown> = Promise.resolve();

export function resetRosterQueue(): void {
  queue = Promise.resolve();
}

async function freshFile(dir: string, town: string, now: Date): Promise<{ file: string; date: Date } | null> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const slug = townSlug(town);
  let best: { file: string; date: Date } | null = null;
  for (const n of names) {
    const m = new RegExp(`^${slug}-(\\d{4}-\\d{2}-\\d{2})\\.txt$`).exec(n);
    if (!m) continue;
    const date = new Date(`${m[1]}T00:00:00Z`);
    const ageDays = (now.getTime() - date.getTime()) / 86_400_000;
    if (ageDays <= ROSTER_MAX_AGE_DAYS && (!best || date > best.date)) best = { file: path.join(dir, n), date };
  }
  return best;
}

export interface EnsuredRoster {
  town: string;
  /** 'pulled' = downloaded now, 'reused' = a roster from the last 7 days, 'empty' = no registrations in town. */
  how: 'pulled' | 'reused' | 'empty';
  rows: number;
}

/**
 * Makes sure the HIC roster of a town is in the database, pulled within the last 7 days: reuse a fresh file, else
 * download it (one flow at a time) and load it. So `pp pilot run edison_nj` needs no manual roster step.
 */
export function ensureNjRosterForTown(ctx: StageContext, town: string): Promise<EnsuredRoster> {
  const run = async (): Promise<EnsuredRoster> => {
    const dir = path.join(dataDir(ctx.config), 'downloads', 'nj');
    const now = ctx.now();
    const have = await freshFile(dir, town, now);
    if (have) {
      const loaded = await ctx.db.$client.query(
        `SELECT 1 FROM registry_records WHERE source_type = 'nj_hic_roster' AND upper(city) = upper($1) AND captured_at >= $2 LIMIT 1`,
        [town, have.date],
      );
      if (loaded.rows.length > 0) return { town, how: 'reused', rows: 0 };
      const text = await readFile(have.file, 'utf8');
      const rows = await loadNjRosterRows(ctx.db, parseNjRoster(text), { capturedAt: have.date });
      return { town, how: 'reused', rows };
    }
    const dl = await downloadNjRoster(ctx.fetcher, ctx.config, town, { now, destDir: dir });
    if (!dl.path) {
      // Remember that the town has no registrations, so the next run does not ask again within 7 days.
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${townSlug(town)}-${now.toISOString().slice(0, 10)}.txt`), '');
      return { town, how: 'empty', rows: 0 };
    }
    const text = await readFile(dl.path, 'utf8');
    const rows = await loadNjRosterRows(ctx.db, parseNjRoster(text), { capturedAt: now });
    return { town, how: 'pulled', rows };
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
