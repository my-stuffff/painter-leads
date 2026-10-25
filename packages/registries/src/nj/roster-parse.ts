import { readFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { normaliseBusinessName, zip5, type Db } from '@pp/core';
import { usDateToIso } from '../cslb/master';

export const NJ_ROSTER_URL = 'https://newjersey.mylicense.com/Verification_Bulk/Search.aspx?facility=Y';

export interface NjRosterRow {
  full_name: string;
  first_name?: string;
  last_name?: string;
  license_no: string;
  issue_date?: string;
  expiration_date?: string;
  addr_line_1?: string;
  addr_line_2?: string;
  addr_city?: string;
  addr_state?: string;
  addr_zipcode?: string;
  addr_email?: string;
  license_status_name?: string;
  [column: string]: string | undefined;
}

/**
 * The roster header ends with a '|', so the parser sees an empty last column name (Pitfall 12): empty names
 * are dropped (`false`), leaving the 18 named columns. A BOM and CRLF line ends are handled.
 */
export function parseNjRoster(text: string): NjRosterRow[] {
  const rows = parse(text, {
    delimiter: '|',
    bom: true,
    relax_quotes: true,
    relax_column_count: true,
    skip_empty_lines: true,
    columns: (header: string[]) => header.map((h) => (h.trim() === '' ? false : h.trim())),
    quote: false,
  }) as NjRosterRow[];
  return rows.filter((r) => (r.license_no ?? '').trim().length > 0);
}

/** "3/7/2011", "03/07/2011 00:00:00" or "2011-03-07" to "2011-03-07"; null when it is not a date. */
export function rosterDate(s: string | undefined | null): string | null {
  const t = (s ?? '').trim().split(/[ T]/)[0] ?? '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return usDateToIso(t);
}

export interface NjRecordDraft {
  sourceKey: string;
  legalName: string;
  nameNorm: string;
  nameCore: string;
  aliases: string[];
  address: string | null;
  city: string | null;
  zip: string | null;
  email: string | null;
  status: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  raw: Record<string, string>;
}

const clean = (s: string | undefined | null): string | null => {
  const t = (s ?? '').trim();
  return t.length > 0 ? t : null;
};

export function mapRosterRow(row: NjRosterRow): NjRecordDraft | null {
  const key = clean(row.license_no);
  const name = clean(row.full_name);
  if (!key || !name) return null;
  const n = normaliseBusinessName(name);
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    const c = clean(v);
    if (c !== null) raw[k] = c;
  }
  const line1 = clean(row.addr_line_1);
  const line2 = clean(row.addr_line_2);
  return {
    sourceKey: key,
    legalName: name,
    nameNorm: n.norm,
    nameCore: n.core,
    aliases: n.aliases,
    address: [line1, line2].filter(Boolean).join(', ') || null,
    city: clean(row.addr_city),
    zip: zip5(row.addr_zipcode),
    email: clean(row.addr_email)?.toLowerCase() ?? null,
    status: clean(row.license_status_name),
    issuedOn: rosterDate(row.issue_date),
    expiresOn: rosterDate(row.expiration_date),
    raw,
  };
}

const COLS = [
  'source_type',
  'source_key',
  'state',
  'legal_name',
  'name_norm',
  'name_core',
  'aliases',
  'address',
  'city',
  'zip',
  'email',
  'status',
  'business_type',
  'issued_on',
  'expires_on',
  'raw',
  'source_url',
  'captured_at',
] as const;

/** Upserts roster rows (source nj_hic_roster, key = the 13VH licence number). Never logs a row. */
export async function loadNjRosterRows(
  db: Db,
  rows: NjRosterRow[],
  opts: { capturedAt: Date; sourceUrl?: string },
): Promise<number> {
  const byKey = new Map<string, NjRecordDraft>();
  for (const r of rows) {
    const d = mapRosterRow(r);
    if (d) byKey.set(d.sourceKey, d);
  }
  const drafts = [...byKey.values()];
  for (let i = 0; i < drafts.length; i += 500) {
    const batch = drafts.slice(i, i + 500);
    const params: unknown[] = [];
    const tuples = batch.map((d) => {
      const base = params.length;
      params.push(
        'nj_hic_roster',
        d.sourceKey,
        'NJ',
        d.legalName,
        d.nameNorm,
        d.nameCore,
        d.aliases,
        d.address,
        d.city,
        d.zip,
        d.email,
        d.status,
        'Home Improvement Contractor',
        d.issuedOn,
        d.expiresOn,
        JSON.stringify(d.raw),
        opts.sourceUrl ?? NJ_ROSTER_URL,
        opts.capturedAt,
      );
      return `(${COLS.map((_, j) => `$${base + j + 1}`).join(', ')})`;
    });
    const updates = COLS.filter((c) => c !== 'source_type' && c !== 'source_key')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    await db.$client.query(
      `INSERT INTO registry_records (${COLS.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (source_type, source_key) DO UPDATE SET ${updates}`,
      params,
    );
  }
  return drafts.length;
}

export async function loadNjRosterFile(db: Db, file: string, opts: { capturedAt: Date }): Promise<number> {
  const text = await readFile(file, 'utf8');
  return loadNjRosterRows(db, parseNjRoster(text), opts);
}
