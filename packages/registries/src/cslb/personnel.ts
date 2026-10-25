import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import { splitLastFirstMiddle, type Db } from '@pp/core';
import { checkPersonnelComplete, robustMax, type CompleteVerdict } from './completeness';
import { CSLB_PORTAL_URL, usDateToIso } from './master';
import { roleRank } from './owner';

export class IncompletePersonnelError extends Error {
  constructor(readonly verdict: CompleteVerdict) {
    super(`CSLB personnel file refused: ${verdict.reason ?? 'incomplete'}`);
    this.name = 'IncompletePersonnelError';
  }
}

export interface PersonnelRole {
  title: string;
  rank: number;
  associatedOn: string | null;
  dissociatedOn: string | null;
}

export interface PersonnelPerson {
  licenceNo: string;
  /** "First Last". */
  display: string;
  first: string;
  last: string;
  /** The name as the file gives it, single-spaced, for the evidence snippet. */
  raw: string;
  roles: PersonnelRole[];
  deceased: boolean;
}

const cell = (v: string | undefined): string[] => (v ?? '').split('|').map((x) => x.trim());

/**
 * One personnel row (a person on a licence) to roles. The fields hold parallel '|'-separated lists: titles,
 * association dates and dis-association dates (a role with no dis-association date is current). Name-TP
 * 'Business' rows (a firm, not a person) and a second 'AKA' name are not people.
 */
export function mapPersonnelRow(row: Record<string, string | undefined>): PersonnelPerson | null {
  const licenceNo = (row['LIC-NO'] ?? '').trim();
  const nameType = cell(row['Name-TP'])[0] ?? '';
  const name = cell(row.Name)[0] ?? '';
  if (!licenceNo || !/principal/i.test(nameType) || name.length === 0) return null;

  const titles = cell(row['EMP-Titl-CDE']);
  const assn = cell(row['ASSN-DT']);
  const dis = cell(row['DIS-ASSN-DT']);
  const deceased = titles.some((t) => /deceased/i.test(t));

  // The fixed-width name ("LAST      FIRST     MIDDLE") has runs of spaces between its parts.
  const raw = (row.Name ?? '').split('|')[0]?.trim() ?? '';
  const names = splitLastFirstMiddle(raw);
  if (!names.first || !names.last) return null;

  const roles: PersonnelRole[] = [];
  titles.forEach((title, i) => {
    const rank = roleRank(title);
    if (!title || rank === null) return;
    roles.push({ title, rank, associatedOn: usDateToIso(assn[i]), dissociatedOn: usDateToIso(dis[i]) });
  });
  return {
    licenceNo,
    display: names.display,
    first: names.first,
    last: names.last,
    raw: raw.replace(/\s+/g, ' '),
    roles,
    deceased,
  };
}

export interface PersonnelLoadResult {
  rows: number;
  people: number;
  licences: number;
  skippedUnknownLicence: number;
}

/** Highest licence number of the loaded master (outliers such as the 88888888 test licence ignored). */
export async function masterMaxLicence(db: Db): Promise<number | null> {
  const res = await db.$client.query(`SELECT source_key FROM registry_records WHERE source_type = 'cslb_master' AND source_key ~ '^[0-9]+$'`);
  return robustMax(res.rows.map((r: { source_key: string }) => Number(r.source_key)));
}

const COLS = ['registry_record_id', 'source_type', 'name_raw', 'full_name', 'first_name', 'last_name', 'title', 'role_rank', 'associated_on', 'dissociated_on', 'source_url', 'captured_at'] as const;

/**
 * Loads a COMPLETE CSLB personnel file into registry_people (source cslb_personnel). A partial file is refused
 * (D-20: last row must parse and the highest licence number must be within 1% of the master's). Only people on
 * licences already in the master are kept, and only roles that can be an owner (D-19 priority list).
 */
export async function loadCslbPersonnel(
  db: Db,
  file: string,
  opts: { capturedAt: Date; masterMax: number; sourceUrl?: string },
): Promise<PersonnelLoadResult> {
  const verdict = await checkPersonnelComplete(file, opts.masterMax);
  if (!verdict.ok) throw new IncompletePersonnelError(verdict);

  const ids = new Map<string, number>();
  const known = await db.$client.query(`SELECT source_key, id FROM registry_records WHERE source_type = 'cslb_master'`);
  for (const r of known.rows as { source_key: string; id: number }[]) ids.set(r.source_key, r.id);

  const sourceUrl = opts.sourceUrl ?? CSLB_PORTAL_URL;
  await db.$client.query(`DELETE FROM registry_people WHERE source_type = 'cslb_personnel'`);

  const parser = createReadStream(file).pipe(
    parse({ bom: true, relax_quotes: true, columns: true, skip_empty_lines: true }),
  );
  let rows = 0;
  let people = 0;
  let skipped = 0;
  const licences = new Set<string>();
  let batch: unknown[][] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const params: unknown[] = [];
    const tuples = batch.map((vals) => {
      const base = params.length;
      params.push(...vals);
      return `(${COLS.map((_, i) => `$${base + i + 1}`).join(', ')})`;
    });
    await db.$client.query(`INSERT INTO registry_people (${COLS.join(', ')}) VALUES ${tuples.join(', ')}`, params);
    batch = [];
  };

  for await (const row of parser as AsyncIterable<Record<string, string>>) {
    rows++;
    const p = mapPersonnelRow(row);
    if (!p || p.deceased) continue;
    const recordId = ids.get(p.licenceNo);
    if (recordId === undefined) {
      skipped++;
      continue;
    }
    for (const role of p.roles) {
      batch.push([
        recordId,
        'cslb_personnel',
        `LIC-NO=${p.licenceNo}; Name=${p.raw}; EMP-Titl-CDE=${role.title}; ASSN-DT=${role.associatedOn ?? ''}; DIS-ASSN-DT=${role.dissociatedOn ?? ''}`,
        p.display,
        p.first,
        p.last,
        role.title,
        role.rank,
        role.associatedOn,
        role.dissociatedOn,
        sourceUrl,
        opts.capturedAt,
      ]);
      people++;
      licences.add(p.licenceNo);
      if (batch.length >= 1000) await flush();
    }
  }
  await flush();
  return { rows, people, licences: licences.size, skippedUnknownLicence: skipped };
}
