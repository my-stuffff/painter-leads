import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import { last10, normaliseBusinessName, toE164, zip5, type Db } from '@pp/core';
import { soleOwnerFromMasterRow, type SoleOwnerName } from './owner';

export const CSLB_PORTAL_URL = 'https://web.cslb.ca.gov/Onlineservices/DataPortal/ContractorList';

/** Row columns kept in registry_records.raw (the insurance and bond columns are not needed and not stored). */
const RAW_KEYS = [
  'LicenseNo',
  'LastUpdate',
  'BusinessName',
  'BUS-NAME-2',
  'FullBusinessName',
  'MailingAddress',
  'City',
  'State',
  'County',
  'ZIPCode',
  'BusinessPhone',
  'BusinessType',
  'IssueDate',
  'ReissueDate',
  'ExpirationDate',
  'InactivationDate',
  'ReactivationDate',
  'PrimaryStatus',
  'SecondaryStatus',
  'Classifications(s)',
] as const;

export type MasterRow = Record<string, string | undefined>;

export interface MasterRecordDraft {
  sourceKey: string;
  legalName: string;
  dbaName: string | null;
  nameNorm: string;
  nameCore: string;
  aliases: string[];
  address: string | null;
  city: string | null;
  zip: string | null;
  phoneE164: string | null;
  phoneLast10: string | null;
  status: string | null;
  classifications: string | null;
  businessType: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  raw: Record<string, string>;
  soleOwner: SoleOwnerName | null;
}

/** "10/23/2026" -> "2026-10-23" (a plain date: no time zone, no shift); null when it is not a date. */
export function usDateToIso(s: string | undefined | null): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(s ?? '');
  if (!m) return null;
  const [mm, dd, yyyy] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** "B| C33" -> "B, C33". */
export function normaliseClassifications(s: string | undefined | null): string | null {
  const parts = (s ?? '')
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

const clean = (s: string | undefined | null): string | null => {
  const t = (s ?? '').trim();
  return t.length > 0 ? t : null;
};

/** One master-file row to a registry record draft. Licence numbers stay strings (no numeric conversion). */
export function mapMasterRow(row: MasterRow): MasterRecordDraft | null {
  const licence = clean(row.LicenseNo);
  const name = clean(row.BusinessName);
  if (!licence || !name) return null;

  const own = normaliseBusinessName(name);
  const dba = clean(row['BUS-NAME-2']);
  const full = clean(row.FullBusinessName);
  const aliasSet = new Set<string>(own.aliases);
  for (const extra of [dba, full]) {
    if (!extra) continue;
    const n = normaliseBusinessName(extra);
    if (n.norm && n.norm !== own.norm) aliasSet.add(n.norm);
    for (const a of n.aliases) if (a && a !== own.norm) aliasSet.add(a);
  }

  const phone = clean(row.BusinessPhone);
  const raw: Record<string, string> = {};
  for (const k of RAW_KEYS) {
    const v = clean(row[k]);
    if (v !== null) raw[k] = v;
  }

  const businessType = clean(row.BusinessType);
  return {
    sourceKey: licence,
    legalName: name,
    dbaName: dba,
    nameNorm: own.norm,
    nameCore: own.core,
    aliases: [...aliasSet],
    address: clean(row.MailingAddress),
    city: clean(row.City),
    zip: zip5(row.ZIPCode),
    phoneE164: phone ? toE164(phone) : null,
    phoneLast10: phone ? last10(phone) : null,
    status: clean(row.PrimaryStatus),
    classifications: normaliseClassifications(row['Classifications(s)']),
    businessType,
    issuedOn: usDateToIso(row.IssueDate),
    expiresOn: usDateToIso(row.ExpirationDate),
    raw,
    soleOwner: businessType === 'Sole Owner' ? soleOwnerFromMasterRow(row) : null,
  };
}

const BATCH = 1000;

const RECORD_COLS = [
  'source_type',
  'source_key',
  'state',
  'legal_name',
  'dba_name',
  'name_norm',
  'name_core',
  'aliases',
  'address',
  'city',
  'zip',
  'phone_e164',
  'phone_last10',
  'status',
  'classifications',
  'business_type',
  'issued_on',
  'expires_on',
  'raw',
  'source_url',
  'captured_at',
] as const;

export interface LoadResult {
  rows: number;
  soleOwners: number;
}

/**
 * Streams the CSLB master CSV into registry_records (source_type cslb_master, key = LicenseNo as a string)
 * in batches of 1,000; Sole Owner rows with a readable person name also get a registry_people row.
 * Re-running refreshes the rows. Never logs a row.
 */
export async function loadCslbMaster(
  db: Db,
  file: string,
  opts: { capturedAt: Date; sourceUrl?: string; onProgress?: (rows: number) => void },
): Promise<LoadResult> {
  const sourceUrl = opts.sourceUrl ?? CSLB_PORTAL_URL;
  const parser = createReadStream(file).pipe(
    parse({ bom: true, relax_quotes: true, relax_column_count: true, columns: true, skip_empty_lines: true }),
  );

  let total = 0;
  let owners = 0;
  let batch = new Map<string, MasterRecordDraft>();

  const flush = async (): Promise<void> => {
    if (batch.size === 0) return;
    const drafts = [...batch.values()];
    batch = new Map();
    const params: unknown[] = [];
    const tuples = drafts.map((d) => {
      const base = params.length;
      params.push(
        'cslb_master',
        d.sourceKey,
        'CA',
        d.legalName,
        d.dbaName,
        d.nameNorm,
        d.nameCore,
        d.aliases,
        d.address,
        d.city,
        d.zip,
        d.phoneE164,
        d.phoneLast10,
        d.status,
        d.classifications,
        d.businessType,
        d.issuedOn,
        d.expiresOn,
        JSON.stringify(d.raw),
        sourceUrl,
        opts.capturedAt,
      );
      return `(${RECORD_COLS.map((_, i) => `$${base + i + 1}`).join(', ')})`;
    });
    const updates = RECORD_COLS.filter((c) => c !== 'source_type' && c !== 'source_key')
      .map((c) => `${c} = excluded.${c}`)
      .join(', ');
    const res = await db.$client.query(
      `INSERT INTO registry_records (${RECORD_COLS.join(', ')}) VALUES ${tuples.join(', ')}
       ON CONFLICT (source_type, source_key) DO UPDATE SET ${updates}
       RETURNING id, source_key`,
      params,
    );
    const idByKey = new Map<string, number>(res.rows.map((r: { id: number; source_key: string }) => [r.source_key, r.id]));

    const withOwner = drafts.filter((d) => d.soleOwner !== null);
    const ids = drafts.map((d) => idByKey.get(d.sourceKey)).filter((i): i is number => i !== undefined);
    await db.$client.query(
      `DELETE FROM registry_people WHERE source_type = 'cslb_master' AND registry_record_id = ANY($1)`,
      [ids],
    );
    for (const d of withOwner) {
      const id = idByKey.get(d.sourceKey);
      const o = d.soleOwner;
      if (id === undefined || !o) continue;
      await db.$client.query(
        `INSERT INTO registry_people (registry_record_id, source_type, name_raw, full_name, first_name, last_name, title,
                                      role_rank, source_url, captured_at)
         VALUES ($1, 'cslb_master', $2, $3, $4, $5, 'Sole Owner', 2, $6, $7)`,
        [id, o.raw, o.display, o.first, o.last, sourceUrl, opts.capturedAt],
      );
      owners++;
    }
  };

  for await (const row of parser as AsyncIterable<MasterRow>) {
    const d = mapMasterRow(row);
    if (!d) continue;
    batch.set(d.sourceKey, d);
    total++;
    if (batch.size >= BATCH) {
      await flush();
      opts.onProgress?.(total);
    }
  }
  await flush();
  opts.onProgress?.(total);
  return { rows: total, soleOwners: owners };
}
