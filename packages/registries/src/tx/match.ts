import {
  isSourceEnabled,
  normaliseBusinessName,
  RobotsDisallowedError,
  zip5,
  type EvidenceDraft,
  type RegistryMatchInput,
  type RegistrySourceStatus,
  type StageContext,
} from '@pp/core';
import { ensureEvidence, makeDraft, type Provenance } from '../evidence';
import { matchLadder } from '../match/ladder';
import { findCandidates, getRecordById, setRegistryStatus, toCandidate, writeMatches, type RegistryRecord } from '../records';
import type { SourceOutcome, StageOptions } from '../types';
import { roleRank } from '../cslb/owner';
import { fetchTxOfficers, type TxOfficerResult } from './comptroller';
import { queryTxTaxpayers, upsertTxTaxpayers } from './opendata';

/** The most distinctive word of a company name for the "contains" search: the longest non-generic word. */
export function distinctiveToken(name: string): string | null {
  const n = normaliseBusinessName(name);
  const words = (n.core || n.norm)
    .split(' ')
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w));
  if (words.length === 0) return null;
  return words.reduce((best, w) => (w.length > best.length ? w : best), words[0] as string);
}

function openDataEvidence(companyId: number, r: RegistryRecord, rung: string): EvidenceDraft[] {
  const prov: Provenance = {
    companyId,
    registryRecordId: r.id,
    sourceType: 'tx_open_data',
    sourceUrl: r.sourceUrl as string,
    capturedAt: r.capturedAt ?? new Date(0),
    extractor: 'tx-open-data',
  };
  const snippet = `taxpayer_number=${r.sourceKey}; taxpayer_name=${r.legalName ?? ''}; taxpayer_city=${r.city ?? ''}; taxpayer_zip=${r.zip ?? ''}`;
  const attrs = { rung, taxpayerNumber: r.sourceKey };
  const out = [makeDraft(prov, 'tx_taxpayer_number', r.sourceKey, snippet, 'high', attrs)];
  if (r.legalName) out.push(makeDraft(prov, 'registry_legal_name', r.legalName, snippet, 'high', attrs));
  return out;
}

async function comptrollerEvidence(ctx: StageContext, companyId: number, r: RegistryRecord, res: TxOfficerResult, rung: string): Promise<number[]> {
  const url = res.sourceUrl as string;
  const prov: Provenance = {
    companyId,
    registryRecordId: r.id,
    sourceType: 'tx_comptroller',
    sourceUrl: url,
    capturedAt: ctx.now(),
    extractor: 'tx-comptroller',
  };
  await ctx.db.$client.query(`DELETE FROM registry_people WHERE registry_record_id = $1 AND source_type = 'tx_comptroller'`, [r.id]);
  const drafts: EvidenceDraft[] = [];
  for (const o of res.officers) {
    const parts = o.display.split(' ');
    await ctx.db.$client.query(
      `INSERT INTO registry_people (registry_record_id, source_type, name_raw, full_name, first_name, last_name, title, role_rank, source_url, captured_at)
       VALUES ($1, 'tx_comptroller', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [r.id, o.raw, o.display, parts[0] ?? null, parts[parts.length - 1] ?? null, o.title, roleRank(o.title), url, ctx.now()],
    );
    drafts.push(
      makeDraft(
        prov,
        'owner_name',
        o.display,
        `AGNT_NM=${o.raw}; AGNT_TITL_TX=${o.titles.join(', ')}; AGNT_ACTV_YR=${o.activeYear ?? ''}; taxpayerId=${res.taxpayerId}`,
        'high',
        { title: o.title, titles: o.titles, rung, taxpayerNumber: res.taxpayerId, alsoRegisteredAgent: o.alsoRegisteredAgent },
      ),
    );
  }
  return ensureEvidence(ctx.evidence, companyId, drafts);
}

/**
 * Texas: taxpayer from data.texas.gov (contains-search on name + ZIP), then - only for a strong match and only if the
 * tx_comptroller switch is on - the officers from the Comptroller detail JSON (D-21, D-36). Brand names and sole
 * proprietors with no entity get no_match and no Texas registry owner.
 */
export async function matchTx(ctx: StageContext, input: RegistryMatchInput, opts: StageOptions): Promise<SourceOutcome> {
  const { company } = input;
  const out: SourceOutcome = { statuses: {}, evidenceIds: [], owners: 0 };
  const comptrollerOn = isSourceEnabled(ctx.config, 'tx_comptroller');
  const notMatched = (s: RegistrySourceStatus): SourceOutcome => {
    out.statuses = { tx_open_data: s, tx_comptroller: comptrollerOn ? 'not_applicable' : 'disabled' };
    return out;
  };

  if (!isSourceEnabled(ctx.config, 'tx_open_data')) return notMatched('disabled');

  const zip = zip5(company.zip);
  const token = distinctiveToken(company.name);
  if (!zip || !token) {
    await setRegistryStatus(ctx.db, company.companyId, { tx_open_data: 'no_match' });
    return notMatched('no_match');
  }

  const q = await queryTxTaxpayers(ctx.fetcher, { zip, nameToken: token }, { offline: opts.offline, runId: ctx.runId });
  await upsertTxTaxpayers(ctx.db, q.rows, { capturedAt: q.fetchedAt, sourceUrl: q.url });

  const nm = normaliseBusinessName(company.name);
  const rows = await findCandidates(ctx.db, { sourceTypes: ['tx_open_data'], state: 'TX', phoneLast10: null, core: nm.core || null, zip });
  const outcome = matchLadder({ name: company.name, city: company.city, zip, phoneLast10: null }, rows.map(toCandidate));
  await writeMatches(ctx.db, company.companyId, ['tx_open_data'], outcome.records);

  if (outcome.outcome !== 'match' || !outcome.chosen) {
    const s: RegistrySourceStatus = outcome.outcome === 'candidate_only' ? 'candidate_only' : 'no_match';
    await setRegistryStatus(ctx.db, company.companyId, { tx_open_data: s });
    return notMatched(s);
  }

  const record = (await getRecordById(ctx.db, outcome.chosen.recordId)) as RegistryRecord;
  const rung = outcome.chosen.rung;
  out.statuses.tx_open_data = 'matched';
  out.evidenceIds.push(...(await ensureEvidence(ctx.evidence, company.companyId, openDataEvidence(company.companyId, record, rung))));
  const status: Record<string, unknown> = { tx_open_data: 'matched', tx_taxpayer: record.sourceKey };

  // Comptroller officers: nothing is requested while the switch is off.
  if (!comptrollerOn) {
    out.statuses.tx_comptroller = 'disabled';
  } else {
    const prior = (await ctx.evidence.listForCompany(company.companyId, 'owner_name')).filter((e) => e.sourceType === 'tx_comptroller' && e.status !== 'rejected');
    if (prior.length > 0) {
      out.statuses.tx_comptroller = 'matched';
      out.owners = prior.length;
      out.evidenceIds.push(...prior.map((e) => e.id));
    } else {
      try {
        const res = await fetchTxOfficers(ctx.fetcher, ctx.config, record.sourceKey, { offline: opts.offline, runId: ctx.runId });
        if (res.status === 'disabled') {
          out.statuses.tx_comptroller = 'disabled';
        } else if (res.officers.length === 0) {
          out.statuses.tx_comptroller = 'no_match';
        } else {
          out.evidenceIds.push(...(await comptrollerEvidence(ctx, company.companyId, record, res, rung)));
          out.owners = res.officers.length;
          out.statuses.tx_comptroller = 'matched';
        }
      } catch (e) {
        const blocked = e instanceof RobotsDisallowedError;
        ctx.log.warn({ taxpayer: record.sourceKey, err: (e as Error).message }, blocked ? 'Comptroller robots.txt disallows the lookup' : 'Comptroller lookup failed');
        out.statuses.tx_comptroller = blocked ? 'blocked' : 'error';
      }
    }
  }
  status.tx_comptroller = out.statuses.tx_comptroller;
  await setRegistryStatus(ctx.db, company.companyId, status);
  return out;
}
