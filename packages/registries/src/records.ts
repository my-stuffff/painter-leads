import type { Db, SourceType } from '@pp/core';
import type { LadderCandidate, LadderHit } from './match/ladder';

/**
 * Registry tables are read and written with plain SQL on the pool (`db.$client`): this package has no
 * drizzle-orm dependency of its own (no new packages in wave 2), and the statements stay explicit.
 */
export interface RegistryRecord {
  id: number;
  sourceType: string;
  sourceKey: string;
  state: string | null;
  legalName: string | null;
  dbaName: string | null;
  nameNorm: string | null;
  nameCore: string | null;
  aliases: string[];
  address: string | null;
  city: string | null;
  zip: string | null;
  phoneE164: string | null;
  phoneLast10: string | null;
  email: string | null;
  status: string | null;
  classifications: string | null;
  businessType: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  raw: Record<string, unknown> | null;
  sourceUrl: string | null;
  capturedAt: Date | null;
}

export interface RegistryPerson {
  id: number;
  registryRecordId: number;
  sourceType: string;
  nameRaw: string | null;
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  roleRank: number | null;
  associatedOn: string | null;
  dissociatedOn: string | null;
  sourceUrl: string | null;
  capturedAt: Date | null;
}

type Row = Record<string, unknown>;

const RECORD_COLUMNS = `id, source_type, source_key, state, legal_name, dba_name, name_norm, name_core, aliases, address,
  city, zip, phone_e164, phone_last10, email, status, classifications, business_type,
  to_char(issued_on, 'YYYY-MM-DD') AS issued_on, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, raw, source_url, captured_at`;

const PERSON_COLUMNS = `id, registry_record_id, source_type, name_raw, full_name, first_name, last_name, title, role_rank,
  to_char(associated_on, 'YYYY-MM-DD') AS associated_on, to_char(dissociated_on, 'YYYY-MM-DD') AS dissociated_on,
  source_url, captured_at`;

export function toRecord(r: Row): RegistryRecord {
  return {
    id: r.id as number,
    sourceType: r.source_type as string,
    sourceKey: r.source_key as string,
    state: (r.state as string | null) ?? null,
    legalName: (r.legal_name as string | null) ?? null,
    dbaName: (r.dba_name as string | null) ?? null,
    nameNorm: (r.name_norm as string | null) ?? null,
    nameCore: (r.name_core as string | null) ?? null,
    aliases: (r.aliases as string[] | null) ?? [],
    address: (r.address as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    zip: (r.zip as string | null) ?? null,
    phoneE164: (r.phone_e164 as string | null) ?? null,
    phoneLast10: (r.phone_last10 as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    classifications: (r.classifications as string | null) ?? null,
    businessType: (r.business_type as string | null) ?? null,
    issuedOn: (r.issued_on as string | null) ?? null,
    expiresOn: (r.expires_on as string | null) ?? null,
    raw: (r.raw as Record<string, unknown> | null) ?? null,
    sourceUrl: (r.source_url as string | null) ?? null,
    capturedAt: (r.captured_at as Date | null) ?? null,
  };
}

export function toPerson(r: Row): RegistryPerson {
  return {
    id: r.id as number,
    registryRecordId: r.registry_record_id as number,
    sourceType: r.source_type as string,
    nameRaw: (r.name_raw as string | null) ?? null,
    fullName: (r.full_name as string | null) ?? null,
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    roleRank: (r.role_rank as number | null) ?? null,
    associatedOn: (r.associated_on as string | null) ?? null,
    dissociatedOn: (r.dissociated_on as string | null) ?? null,
    sourceUrl: (r.source_url as string | null) ?? null,
    capturedAt: (r.captured_at as Date | null) ?? null,
  };
}

export function toCandidate(r: RegistryRecord): LadderCandidate {
  return {
    key: r.sourceKey,
    recordId: r.id,
    nameNorm: r.nameNorm,
    nameCore: r.nameCore,
    aliasNorms: r.aliases,
    city: r.city,
    zip: r.zip,
    phoneLast10: r.phoneLast10,
    status: r.status,
    expiresOn: r.expiresOn,
  };
}

/**
 * Candidate rows for one company in one registry: same phone, same core name, or same ZIP (all indexed);
 * the in-memory ladder then checks the full name and alias rungs on this small set.
 */
export async function findCandidates(
  db: Db,
  q: { sourceTypes: SourceType[]; state: string; phoneLast10: string | null; core: string | null; zip: string | null; city?: string | null },
): Promise<RegistryRecord[]> {
  const ors: string[] = [];
  const params: unknown[] = [q.sourceTypes, q.state];
  if (q.phoneLast10) {
    params.push(q.phoneLast10);
    ors.push(`phone_last10 = $${params.length}`);
  }
  if (q.core) {
    params.push(q.core);
    ors.push(`name_core = $${params.length}`);
  }
  if (q.zip) {
    params.push(q.zip);
    ors.push(`zip = $${params.length}`);
  }
  if (q.city?.trim()) {
    params.push(q.city.trim());
    ors.push(`upper(city) = upper($${params.length})`);
  }
  if (ors.length === 0) return [];
  const res = await db.$client.query(
    `SELECT ${RECORD_COLUMNS} FROM registry_records
     WHERE source_type = ANY($1) AND state = $2 AND (${ors.join(' OR ')}) LIMIT 2000`,
    params,
  );
  return res.rows.map(toRecord);
}

export async function getRecord(db: Db, sourceType: SourceType, sourceKey: string): Promise<RegistryRecord | null> {
  const res = await db.$client.query(`SELECT ${RECORD_COLUMNS} FROM registry_records WHERE source_type = $1 AND source_key = $2`, [
    sourceType,
    sourceKey,
  ]);
  return res.rows[0] ? toRecord(res.rows[0]) : null;
}

export async function getRecordById(db: Db, id: number): Promise<RegistryRecord | null> {
  const res = await db.$client.query(`SELECT ${RECORD_COLUMNS} FROM registry_records WHERE id = $1`, [id]);
  return res.rows[0] ? toRecord(res.rows[0]) : null;
}

/** True when the registry has any row of this source type (CA: "CSLB master not loaded"). */
export async function hasRecords(db: Db, sourceType: SourceType): Promise<boolean> {
  const res = await db.$client.query('SELECT 1 FROM registry_records WHERE source_type = $1 LIMIT 1', [sourceType]);
  return res.rows.length > 0;
}

export async function peopleOf(db: Db, registryRecordId: number, sourceTypes?: SourceType[]): Promise<RegistryPerson[]> {
  const res = sourceTypes
    ? await db.$client.query(`SELECT ${PERSON_COLUMNS} FROM registry_people WHERE registry_record_id = $1 AND source_type = ANY($2) ORDER BY id`,
        [registryRecordId, sourceTypes],
      )
    : await db.$client.query(`SELECT ${PERSON_COLUMNS} FROM registry_people WHERE registry_record_id = $1 ORDER BY id`, [
        registryRecordId,
      ]);
  return res.rows.map(toPerson);
}

/**
 * Replaces this company's stored matches for the given source types with the new ones (the stage is
 * re-runnable). Candidates are stored as 'candidate' and never promoted.
 */
export async function writeMatches(
  db: Db,
  companyId: number,
  sourceTypes: SourceType[],
  records: (LadderHit & { note?: string })[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM registry_matches WHERE company_id = $1
       AND registry_record_id IN (SELECT id FROM registry_records WHERE source_type = ANY($2))`,
      [companyId, sourceTypes],
    );
    for (const r of records) {
      await client.query(
        `INSERT INTO registry_matches (company_id, registry_record_id, rung, strength, detail)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (company_id, registry_record_id)
         DO UPDATE SET rung = excluded.rung, strength = excluded.strength, detail = excluded.detail`,
        [companyId, r.recordId, r.rung, r.strength, JSON.stringify({ key: r.key, ...(r.note ? { note: r.note } : {}), ...extra })],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Merges keys into companies.registry_status (jsonb), leaving the other sources' keys alone. */
export async function setRegistryStatus(db: Db, companyId: number, patch: Record<string, unknown>): Promise<void> {
  await db.$client.query(`UPDATE companies SET registry_status = registry_status || $2::jsonb, updated_at = now() WHERE id = $1`,
    [companyId, JSON.stringify(patch)],
  );
}

/** Drops a key from the company's registry_status (e.g. a "skipped" note a later, complete run supersedes). */
export async function clearRegistryStatusKey(db: Db, companyId: number, key: string): Promise<void> {
  await db.$client.query(`UPDATE companies SET registry_status = registry_status - $2::text WHERE id = $1 AND registry_status ? $2::text`, [companyId, key]);
}

/** Roster rows whose email is on exactly this domain (the roster is small: no index needed). */
export async function findByEmailDomain(db: Db, sourceType: SourceType, domain: string): Promise<RegistryRecord[]> {
  const like = `%@${domain.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}`;
  const res = await db.$client.query(
    `SELECT ${RECORD_COLUMNS} FROM registry_records WHERE source_type = $1 AND email LIKE $2 LIMIT 200`,
    [sourceType, like],
  );
  return res.rows.map(toRecord);
}
