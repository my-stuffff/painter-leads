import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';

export interface CompleteVerdict {
  ok: boolean;
  /** Why the file was refused (null when ok). */
  reason: string | null;
  rows: number;
  /** Highest licence number seen (compared numerically only here; matching keeps them as strings). */
  maxLicence: number | null;
  /** maxLicence / masterMax for a personnel file. */
  ratio: number | null;
  /** The last row had the full set of columns. */
  lastRowParses: boolean;
}

/** Share of the master's highest licence number a personnel file must reach (D-20: "within ~1%"). */
export const PERSONNEL_MIN_RATIO = 0.99;

/**
 * Highest licence number that is not an outlier: the master carries a test licence 88888888 ("DOE JOHN
 * CONSTRUCTION"), so numbers above twice the 99.9th percentile are ignored.
 */
export function robustMax(numbers: number[]): number | null {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const p999 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.999))] as number;
  let best: number | null = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if ((sorted[i] as number) <= p999 * 2) {
      best = sorted[i] as number;
      break;
    }
  }
  return best;
}

async function scan(file: string, licenceColumn: string): Promise<Omit<CompleteVerdict, 'ok' | 'reason' | 'ratio'> & { error: string | null }> {
  // No relax_column_count: a row cut off mid-way has too few columns and raises.
  const parser = createReadStream(file).pipe(
    parse({ bom: true, relax_quotes: true, columns: true, skip_empty_lines: true }),
  );
  let rows = 0;
  const numbers: number[] = [];
  try {
    for await (const row of parser as AsyncIterable<Record<string, string>>) {
      rows++;
      const n = Number((row[licenceColumn] ?? '').trim());
      if (Number.isFinite(n) && n > 0) numbers.push(n);
    }
  } catch (e) {
    return { rows, maxLicence: robustMax(numbers), lastRowParses: false, error: (e as Error).message };
  }
  return { rows, maxLicence: robustMax(numbers), lastRowParses: rows > 0, error: null };
}

/**
 * A CSLB master download is complete only if every row parses to the full column count, the last one
 * included. The portal's server stops sending after a time limit, so a slow link gets a file cut off
 * mid-row (seen 2026-10-25: 42.9 MB of 78 MB, no network error).
 */
export async function checkMasterComplete(file: string): Promise<CompleteVerdict> {
  const s = await scan(file, 'LicenseNo');
  if (s.error) {
    return {
      ok: false,
      reason: `a row does not parse (${s.error.split('\n')[0]}) after ${s.rows} rows: the download was cut off`,
      rows: s.rows,
      maxLicence: s.maxLicence,
      ratio: null,
      lastRowParses: false,
    };
  }
  if (s.rows === 0) {
    return { ok: false, reason: 'the file has no rows', rows: 0, maxLicence: null, ratio: null, lastRowParses: false };
  }
  return { ok: true, reason: null, rows: s.rows, maxLicence: s.maxLicence, ratio: null, lastRowParses: true };
}

/** Parse-only check of a personnel file (no master to compare with): every row, the last included, has all columns. */
export async function checkPersonnelParses(file: string): Promise<CompleteVerdict> {
  const s = await scan(file, 'LIC-NO');
  if (s.error) {
    return {
      ok: false,
      reason: `last row does not parse (${s.error.split('\n')[0]}) after ${s.rows} rows`,
      rows: s.rows,
      maxLicence: s.maxLicence,
      ratio: null,
      lastRowParses: false,
    };
  }
  return { ok: s.rows > 0, reason: s.rows > 0 ? null : 'the file has no rows', rows: s.rows, maxLicence: s.maxLicence, ratio: null, lastRowParses: s.rows > 0 };
}

/**
 * D-20: refuse a personnel file whose last row does not parse, or whose highest licence number is more
 * than 1% below the master's. (The personnel file arrives truncated from slow links.)
 */
export async function checkPersonnelComplete(file: string, masterMax: number): Promise<CompleteVerdict> {
  const s = await scan(file, 'LIC-NO');
  if (s.error) {
    return {
      ok: false,
      reason: `last row does not parse (${s.error.split('\n')[0]}) after ${s.rows} rows`,
      rows: s.rows,
      maxLicence: s.maxLicence,
      ratio: s.maxLicence !== null && masterMax > 0 ? s.maxLicence / masterMax : null,
      lastRowParses: false,
    };
  }
  const ratio = s.maxLicence !== null && masterMax > 0 ? s.maxLicence / masterMax : null;
  if (ratio === null || ratio < PERSONNEL_MIN_RATIO) {
    return {
      ok: false,
      reason: `highest licence number ${s.maxLicence ?? 'unknown'} is ${ratio === null ? 'unknown' : `${(100 - ratio * 100).toFixed(1)}%`} below the master's ${masterMax} (limit 1%)`,
      rows: s.rows,
      maxLicence: s.maxLicence,
      ratio,
      lastRowParses: true,
    };
  }
  return { ok: true, reason: null, rows: s.rows, maxLicence: s.maxLicence, ratio, lastRowParses: true };
}
