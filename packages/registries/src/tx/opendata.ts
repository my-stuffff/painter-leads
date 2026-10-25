import { normaliseBusinessName, zip5, type Db, type Fetcher } from '@pp/core';
import { TxPayloadError } from './comptroller';

export const TX_OPEN_DATA_URL = 'https://data.texas.gov/resource/9cir-efmm.json';
export const TX_DATASET_PAGE = 'https://data.texas.gov/dataset/Active-Franchise-Taxpayers/9cir-efmm';

export interface TxTaxpayer {
  taxpayer_number: string;
  taxpayer_name: string;
  taxpayer_address: string | null;
  taxpayer_city: string | null;
  taxpayer_state: string | null;
  taxpayer_zip: string | null;
  taxpayer_organizational_type: string | null;
  sos_status_code: string | null;
  right_to_transact_business_code: string | null;
}

/** SoQL string literal: single quotes doubled; LIKE wildcards and backslashes cannot be smuggled in. */
export function soqlLiteral(s: string): string {
  return s.replace(/[%_\\]/g, '').replace(/'/g, "''");
}

/** The $where clause for one ZIP and one name token (field names from Pitfall 13). */
export function buildTxWhere(q: { zip: string; nameToken: string }): string {
  const zip = zip5(q.zip);
  if (!zip) throw new TxPayloadError(`"${q.zip}" is not a US ZIP`);
  const token = soqlLiteral(q.nameToken.toUpperCase().trim());
  if (token.length < 2) throw new TxPayloadError('the name token is too short to search');
  return `taxpayer_zip='${zip}' AND upper(taxpayer_name) like '%${token}%'`;
}

export function buildTxQueryUrl(q: { zip: string; nameToken: string }, limit = 50): string {
  const params = new URLSearchParams({ $where: buildTxWhere(q), $limit: String(limit) });
  return `${TX_OPEN_DATA_URL}?${params.toString()}`;
}

const s = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

/** Validates the Socrata rows: an array of objects, each with a taxpayer number and a name. */
export function parseTxTaxpayers(json: unknown): TxTaxpayer[] {
  if (!Array.isArray(json)) throw new TxPayloadError('data.texas.gov answer is not a list of rows');
  const out: TxTaxpayer[] = [];
  for (const item of json) {
    const r = item as Record<string, unknown>;
    const number = s(r?.taxpayer_number);
    const name = s(r?.taxpayer_name);
    if (!number || !name || !/^\d{9,11}$/.test(number)) throw new TxPayloadError('a taxpayer row lacks a valid number or name');
    out.push({
      taxpayer_number: number,
      taxpayer_name: name,
      taxpayer_address: s(r.taxpayer_address),
      taxpayer_city: s(r.taxpayer_city),
      taxpayer_state: s(r.taxpayer_state),
      taxpayer_zip: s(r.taxpayer_zip),
      taxpayer_organizational_type: s(r.taxpayer_organizational_type),
      sos_status_code: s(r.sos_status_code),
      right_to_transact_business_code: s(r.right_to_transact_business_code),
    });
  }
  return out;
}

export interface TxQueryResult {
  rows: TxTaxpayer[];
  url: string;
  fetchedAt: Date;
}

/** Active Franchise Taxpayers whose name contains the token, in one ZIP (Socrata SoQL, free, no key). */
export async function queryTxTaxpayers(
  fetcher: Fetcher,
  q: { zip: string; nameToken: string },
  opts: { offline?: boolean; runId?: number | null } = {},
): Promise<TxQueryResult> {
  const url = buildTxQueryUrl(q);
  const res = await fetcher.get(url, { source: 'tx_open_data', cache: 'use', offline: opts.offline, runId: opts.runId ?? null });
  if (res.status !== 200) throw new TxPayloadError(`data.texas.gov answered HTTP ${res.status}`);
  let json: unknown;
  try {
    json = JSON.parse(res.text());
  } catch {
    throw new TxPayloadError('data.texas.gov answer is not JSON');
  }
  return { rows: parseTxTaxpayers(json), url: res.finalUrl, fetchedAt: res.fetchedAt };
}

/** Stores the rows as registry records (source tx_open_data, key = taxpayer number); returns record ids by number. */
export async function upsertTxTaxpayers(
  db: Db,
  rows: TxTaxpayer[],
  opts: { capturedAt: Date; sourceUrl: string },
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const r of rows) {
    const n = normaliseBusinessName(r.taxpayer_name);
    const res = await db.$client.query(
      `INSERT INTO registry_records (source_type, source_key, state, legal_name, name_norm, name_core, aliases, address, city, zip,
                                     status, business_type, raw, source_url, captured_at)
       VALUES ('tx_open_data', $1, 'TX', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
       ON CONFLICT (source_type, source_key) DO UPDATE SET
         legal_name = excluded.legal_name, name_norm = excluded.name_norm, name_core = excluded.name_core,
         aliases = excluded.aliases, address = excluded.address, city = excluded.city, zip = excluded.zip,
         status = excluded.status, business_type = excluded.business_type, raw = excluded.raw,
         source_url = excluded.source_url, captured_at = excluded.captured_at
       RETURNING id`,
      [
        r.taxpayer_number,
        r.taxpayer_name,
        n.norm,
        n.core,
        n.aliases,
        r.taxpayer_address,
        r.taxpayer_city,
        zip5(r.taxpayer_zip),
        txStatus(r),
        r.taxpayer_organizational_type,
        JSON.stringify(r),
        opts.sourceUrl,
        opts.capturedAt,
      ],
    );
    ids.set(r.taxpayer_number, res.rows[0].id as number);
  }
  return ids;
}

/** "Active" when the entity has the right to transact business in Texas; otherwise the register's own codes. */
export function txStatus(r: Pick<TxTaxpayer, 'sos_status_code' | 'right_to_transact_business_code'>): string {
  if (r.right_to_transact_business_code === 'A') return 'Active';
  return `Not active (sos ${r.sos_status_code ?? '?'}, right to transact ${r.right_to_transact_business_code ?? '?'})`;
}
