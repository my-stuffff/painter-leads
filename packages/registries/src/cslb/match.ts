import { last10, normaliseBusinessName, zip5, type CompanyRef, type Db, type EvidenceDraft, type EvidenceStore } from '@pp/core';
import type { RegistrySourceStatus } from '@pp/core';
import { ensureEvidence, makeDraft, type Provenance } from '../evidence';
import { matchLadder } from '../match/ladder';
import {
  findCandidates,
  peopleOf,
  setRegistryStatus,
  toCandidate,
  writeMatches,
  type RegistryPerson,
  type RegistryRecord,
} from '../records';
import { CSLB_PORTAL_URL } from './master';
import { pickCslbOwner } from './owner';

export interface MatchDeps {
  db: Db;
  store: EvidenceStore;
  now(): Date;
}

export interface SourceMatchResult {
  status: RegistrySourceStatus;
  evidenceIds: number[];
  owners: number;
  rung?: string;
  recordId?: number;
}

const CSLB_SOURCE_TYPES = ['cslb_master', 'cslb_personnel', 'cslb_lookup'] as const;

function rowExcerpt(r: RegistryRecord): string {
  const raw = r.raw ?? {};
  const parts = [`LicenseNo=${r.sourceKey}`, `BusinessName=${r.legalName ?? ''}`];
  if (raw['BUS-NAME-2']) parts.push(`BUS-NAME-2=${raw['BUS-NAME-2']}`);
  if (raw.BusinessPhone) parts.push(`BusinessPhone=${raw.BusinessPhone}`);
  if (raw.PrimaryStatus) parts.push(`PrimaryStatus=${raw.PrimaryStatus}`);
  return parts.join('; ');
}

/** Licence + registry-phone + legal-name evidence for one strongly matched CSLB licence (D-19, D-22, D-23). */
export function cslbRecordEvidence(companyId: number, r: RegistryRecord, rung: string): EvidenceDraft[] {
  const prov: Provenance = {
    companyId,
    registryRecordId: r.id,
    sourceType: 'cslb_master',
    sourceUrl: r.sourceUrl ?? CSLB_PORTAL_URL,
    capturedAt: r.capturedAt ?? new Date(0),
    extractor: 'cslb-master',
  };
  const snippet = rowExcerpt(r);
  const attrs = { rung, licenceNo: r.sourceKey };
  const out: EvidenceDraft[] = [makeDraft(prov, 'licence_number', r.sourceKey, snippet, 'high', { ...attrs, kind: 'cslb' })];
  if (r.status) out.push(makeDraft(prov, 'licence_status', r.status, snippet, 'high', attrs));
  if (r.classifications) out.push(makeDraft(prov, 'licence_classifications', r.classifications, snippet, 'high', attrs));
  if (r.expiresOn) out.push(makeDraft(prov, 'licence_expiry', r.expiresOn, snippet, 'high', attrs));
  if (r.phoneE164) out.push(makeDraft(prov, 'phone', r.phoneE164, snippet, 'high', { ...attrs, role: 'registry_phone' }));
  if (r.legalName) out.push(makeDraft(prov, 'registry_legal_name', r.legalName, snippet, 'high', attrs));
  return out;
}

export function cslbOwnerEvidence(companyId: number, r: RegistryRecord, person: RegistryPerson, rung: string): EvidenceDraft {
  const sourceType = person.sourceType === 'cslb_personnel' || person.sourceType === 'cslb_lookup' ? person.sourceType : 'cslb_master';
  const prov: Provenance = {
    companyId,
    registryRecordId: r.id,
    sourceType,
    sourceUrl: person.sourceUrl ?? r.sourceUrl ?? CSLB_PORTAL_URL,
    capturedAt: person.capturedAt ?? r.capturedAt ?? new Date(0),
    extractor: `cslb-${sourceType.replace('cslb_', '')}`,
  };
  const snippet = `LicenseNo=${r.sourceKey}; ${person.title ?? 'Owner'}: ${person.nameRaw ?? person.fullName ?? ''}`;
  return makeDraft(prov, 'owner_name', person.fullName as string, snippet, 'high', {
    title: person.title,
    rung,
    licenceNo: r.sourceKey,
    roleRank: person.roleRank,
  });
}

/** CA: match the company to its CSLB licence and write licence + owner evidence (D-19). */
export async function matchCslb(deps: MatchDeps, company: CompanyRef): Promise<SourceMatchResult> {
  const nm = normaliseBusinessName(company.name);
  const rows = await findCandidates(deps.db, {
    sourceTypes: ['cslb_master'],
    state: 'CA',
    phoneLast10: company.phoneE164 ? last10(company.phoneE164) : null,
    core: nm.core || null,
    zip: zip5(company.zip),
  });
  const byKey = new Map(rows.map((r) => [r.sourceKey, r]));
  const outcome = matchLadder(
    { name: company.name, city: company.city, zip: company.zip, phoneLast10: company.phoneE164 ? last10(company.phoneE164) : null },
    rows.map(toCandidate),
  );

  await writeMatches(deps.db, company.companyId, ['cslb_master'], outcome.records);

  if (outcome.outcome !== 'match' || !outcome.chosen) {
    const status: RegistrySourceStatus = outcome.outcome === 'candidate_only' ? 'candidate_only' : 'no_match';
    await setRegistryStatus(deps.db, company.companyId, { cslb: status });
    return { status, evidenceIds: [], owners: 0 };
  }

  const record = byKey.get(outcome.chosen.key) as RegistryRecord;
  const drafts = cslbRecordEvidence(company.companyId, record, outcome.chosen.rung);
  const people = await peopleOf(deps.db, record.id, [...CSLB_SOURCE_TYPES]);
  const owner = pickCslbOwner(people);
  if (owner) drafts.push(cslbOwnerEvidence(company.companyId, record, owner, outcome.chosen.rung));

  const evidenceIds = await ensureEvidence(deps.store, company.companyId, drafts);
  await setRegistryStatus(deps.db, company.companyId, { cslb: 'matched', cslb_owner: owner ? 'found' : 'none' });
  return {
    status: 'matched',
    evidenceIds,
    owners: owner ? 1 : 0,
    rung: outcome.chosen.rung,
    recordId: record.id,
  };
}
