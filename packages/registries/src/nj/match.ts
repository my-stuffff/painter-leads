import {
  FREE_MAIL_DOMAINS,
  getArea,
  isSourceEnabled,
  last10,
  normaliseBusinessName,
  personNameKey,
  registrableDomain,
  titleCaseName,
  zip5,
  type EvidenceDraft,
  type RegistryMatchInput,
  type StageContext,
} from '@pp/core';
import { ensureEvidence, makeDraft, type Provenance } from '../evidence';
import { streetKey } from '../match/address';
import {
  isActiveStatus,
  resolveHits,
  rungFor,
  sameCity,
  sameZip,
  sharedNameWords,
  nameWords,
  type LadderCandidate,
  type LadderHit,
  type LadderOutcome,
} from '../match/ladder';
import {
  clearRegistryStatusKey,
  findByEmailDomain,
  findCandidates,
  getRecord,
  setRegistryStatus,
  toCandidate,
  writeMatches,
  type RegistryRecord,
} from '../records';
import type { SourceOutcome, StageOptions } from '../types';
import { fetchNjOwner, type NjDetail } from './detail-flow';
import { confirmNjPrincipal } from './principal-search';
import { ensureNjRosterOrSkip, type SkippedTowns } from './roster-ensure';
import { NJ_ROSTER_URL } from './roster-parse';

const NJ_SOURCES = ['nj_hic_roster', 'nj_hic_detail', 'nj_principal_search'] as const;

export interface NjLadderInput {
  company: Pick<RegistryMatchInput['company'], 'name' | 'city' | 'zip' | 'street'>;
  licenceNumbers: string[];
  websiteDomain: string | null;
}

const upper = (s: string) => s.trim().toUpperCase();

/**
 * The business name before a Google tagline ("Ekar Home Improvement – Transforming Homes with Painting" → "Ekar Home
 * Improvement"): cut at a spaced dash, en/em dash or bar only, so a hyphenated name stays whole.
 */
export function leadName(name: string): string {
  const lead = (name.split(/\s+[–—|]\s+|\s+-\s+/)[0] ?? '').trim();
  return normaliseBusinessName(lead).norm.length >= 3 ? lead : name;
}

const nameVariants = (name: string): string[] => [...new Set([name, leadName(name)])];

/** Roster email domain = the company's own website domain (never a shared host or a free-mail provider). */
export function emailDomainMatches(rosterEmail: string | null, websiteDomain: string | null): boolean {
  if (!rosterEmail || !websiteDomain) return false;
  const site = registrableDomain(websiteDomain);
  if (!site.domain || site.sharedHost) return false;
  const at = rosterEmail.lastIndexOf('@');
  if (at < 0) return false;
  const mail = registrableDomain(rosterEmail.slice(at + 1));
  if (!mail.domain || mail.sharedHost || FREE_MAIL_DOMAINS.includes(mail.domain)) return false;
  return mail.domain === site.domain;
}

/**
 * The NJ ladder in its fixed order (D-21): 13VH number on the website, roster email domain = website domain,
 * normalised name + same ZIP/town (the name before a Google tagline counts too), street address + a distinctive name
 * word in common (another business at the same address is not a match). The first rung with a strong hit decides (and is recorded);
 * Active registrations are preferred and two Active strong hits are ambiguous (candidates only).
 * Without any strong hit, name-only hits are returned as candidates, never promoted.
 */
export function ladderNj(input: NjLadderInput, records: LadderCandidate[], emails: Map<string, string | null>, streets: Map<string, string | null>): LadderOutcome {
  const byKey = new Map(records.map((r) => [r.key, r]));
  const rungs: { rung: string; hits: LadderHit[] }[] = [];
  const hit = (c: LadderCandidate, rung: string, strength: 'strong' | 'candidate' = 'strong'): LadderHit => ({
    key: c.key,
    recordId: c.recordId,
    rung,
    strength,
  });

  const wanted = new Set(input.licenceNumbers.map(upper));
  rungs.push({ rung: '13vh', hits: records.filter((r) => wanted.has(upper(r.key))).map((r) => hit(r, '13vh')) });
  rungs.push({
    rung: 'email_domain',
    hits: records.filter((r) => emailDomainMatches(emails.get(r.key) ?? null, input.websiteDomain)).map((r) => hit(r, 'email_domain')),
  });

  const names = nameVariants(input.company.name);
  const nameHits: LadderHit[] = [];
  const candidateHits: LadderHit[] = [];
  for (const r of records) {
    const found = names
      .map((name) => rungFor({ name, city: input.company.city, zip: input.company.zip, phoneLast10: null }, r))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const strong = found.find((x) => x.strength === 'strong');
    const weak = found.find((x) => x.strength === 'candidate');
    if (strong) nameHits.push(hit(r, 'name_zip'));
    else if (weak) candidateHits.push(hit(r, weak.rung, 'candidate'));
  }
  rungs.push({ rung: 'name_zip', hits: nameHits });

  const mine = streetKey(input.company.street);
  const addressHits: LadderHit[] = [];
  if (mine) {
    const myWords = nameWords(names.flatMap((name) => {
      const n = normaliseBusinessName(name);
      return [n.norm, ...n.aliases];
    }));
    for (const r of records) {
      const theirs = streetKey(streets.get(r.key) ?? null);
      if (!theirs || theirs.key !== mine.key || !(sameZip(input.company.zip, r.zip) || sameCity(input.company.city, r.city))) continue;
      const shared = sharedNameWords(myWords, nameWords([r.nameNorm, ...r.aliasNorms]));
      if (shared) addressHits.push({ ...hit(r, 'address'), note: `same street address; shared name word ${shared.join(', ')}` });
    }
  }
  rungs.push({ rung: 'address', hits: addressHits });

  for (const { hits } of rungs) {
    if (hits.length > 0) return resolveHits(hits, byKey);
  }
  return resolveHits(candidateHits, byKey);
}

function rosterExcerpt(r: RegistryRecord): string {
  // Licence number, name, status and town only: no personal address or email in a snippet.
  return `license_no=${r.sourceKey}; full_name=${r.legalName ?? ''}; license_status_name=${r.status ?? ''}; addr_city=${r.city ?? ''} ${r.zip ?? ''}`.trim();
}

/** Evidence for a strongly matched registration (the roster row): legal name, licence, status, expiry, email. */
export function njRosterEvidence(companyId: number, r: RegistryRecord, rung: string): EvidenceDraft[] {
  const prov: Provenance = {
    companyId,
    registryRecordId: r.id,
    sourceType: 'nj_hic_roster',
    sourceUrl: r.sourceUrl ?? NJ_ROSTER_URL,
    capturedAt: r.capturedAt ?? new Date(0),
    extractor: 'nj-hic-roster',
  };
  const snippet = rosterExcerpt(r);
  const attrs = { rung, licenceNo: r.sourceKey };
  const out: EvidenceDraft[] = [];
  if (r.legalName) out.push(makeDraft(prov, 'registry_legal_name', r.legalName, snippet, 'high', attrs));
  out.push(makeDraft(prov, 'licence_number', r.sourceKey, snippet, 'high', { ...attrs, kind: 'nj_hic' }));
  if (r.status) out.push(makeDraft(prov, 'licence_status', r.status, snippet, 'high', attrs));
  if (r.expiresOn) out.push(makeDraft(prov, 'licence_expiry', r.expiresOn, snippet, 'high', attrs));
  if (r.email) {
    out.push(
      makeDraft(prov, 'email', r.email, `addr_email on roster row ${r.sourceKey}`, 'high', {
        ...attrs,
        role: 'registry_email',
        publishedBy: 'registrant',
      }),
    );
  }
  return out;
}

async function candidateRecords(ctx: StageContext, input: RegistryMatchInput): Promise<RegistryRecord[]> {
  const out = new Map<string, RegistryRecord>();
  const add = (rows: RegistryRecord[]) => rows.forEach((r) => out.set(r.sourceKey, r));

  for (const no of input.licenceNumbers) {
    const r = await getRecord(ctx.db, 'nj_hic_roster', upper(no));
    if (r) out.set(r.sourceKey, r);
  }
  // One query per name variant (the full Google name, and the name before its tagline), each also bringing the rows of
  // the listing's own ZIP and city (roster rows without a ZIP are reached by the city).
  const cores = [...new Set(nameVariants(input.company.name).map((n) => normaliseBusinessName(n).core))];
  for (const [i, core] of (cores.length > 0 ? cores : ['']).entries()) {
    add(
      await findCandidates(ctx.db, {
        sourceTypes: ['nj_hic_roster'],
        state: 'NJ',
        phoneLast10: i === 0 && input.company.phoneE164 ? last10(input.company.phoneE164) : null,
        core: core || null,
        zip: zip5(input.company.zip),
        city: input.company.city,
      }),
    );
  }
  if (input.websiteDomain) add(await findByEmailDomain(ctx.db, 'nj_hic_roster', input.websiteDomain));
  return [...out.values()];
}

/** Both towns the roster must cover for a company: its listing city and the run area's own town. */
export async function townsFor(ctx: StageContext, input: RegistryMatchInput): Promise<string[]> {
  const towns = new Set<string>();
  if (input.company.city) towns.add(input.company.city.trim());
  try {
    const run = await ctx.db.$client.query('SELECT area_id FROM runs WHERE id = $1', [ctx.runId]);
    const areaId = run.rows[0]?.area_id as string | undefined;
    if (areaId) {
      towns.add(getArea(ctx.config, areaId).city);
    }
  } catch {
    // no such run / area file: the listing's own city is enough
  }
  return [...towns].filter((t) => t.length > 0);
}

/**
 * The other towns of the run's NJ painters (listing city of every painter of the run that is not out of area). A
 * company registers in its own town, which is often not the town Google shows (an Edison listing registered in
 * Fords), so these rosters are loaded for every company, before any of them is matched: the result then does not
 * depend on which company happened to come first.
 */
export async function runTowns(ctx: StageContext): Promise<string[]> {
  try {
    const res = await ctx.db.$client.query(
      `SELECT DISTINCT trim(l.city) AS city
         FROM companies c JOIN listings l ON l.id = c.primary_listing_id
        WHERE c.run_id = $1 AND c.state = 'NJ' AND c.painter_status = 'painter' AND c.in_area IS NOT FALSE
          AND l.city IS NOT NULL AND trim(l.city) <> ''
        ORDER BY 1`,
      [ctx.runId],
    );
    return res.rows.map((r: { city: string }) => r.city);
  } catch {
    return [];
  }
}

function splitOwner(display: string): { first: string; last: string } | null {
  const tokens = display
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !/^(jr|sr|ii|iii|iv)$/i.test(t));
  if (tokens.length < 2) return null;
  return { first: tokens[0] as string, last: tokens[tokens.length - 1] as string };
}

/**
 * New Jersey: roster match, then (strong matches only) the registered owner from the HIC detail page in the same
 * cookie session, the free principal-name check, and the roster email (D-21, D-22, D-25).
 */
export async function matchNj(
  ctx: StageContext,
  input: RegistryMatchInput,
  opts: StageOptions,
  shared: { njSkippedTowns?: SkippedTowns } = {},
): Promise<SourceOutcome> {
  const { company } = input;
  const out: SourceOutcome = { statuses: {}, evidenceIds: [], owners: 0 };

  if (!isSourceEnabled(ctx.config, 'nj_hic_roster')) {
    out.statuses = { nj_hic_roster: 'disabled', nj_hic_detail: 'not_applicable', nj_principal_search: 'not_applicable' };
    return out;
  }

  // The roster of the town(s) must be in the database (pulled once per town within 7 days). A town whose pull keeps
  // failing is skipped: matching, the detail page and the principal check go on with the rosters that are loaded.
  const skippedTowns: string[] = [];
  if (!opts.offline) {
    const skipped = shared.njSkippedTowns ?? new Map<string, string>();
    const own = await townsFor(ctx, input);
    for (const town of own) {
      if ((await ensureNjRosterOrSkip(ctx, town, skipped)).how === 'skipped') skippedTowns.push(town);
    }
    // The run's other towns: best effort. A town that cannot be pulled is skipped quietly (it is not this company's town).
    const seen = new Set(own.map((t) => t.toLowerCase()));
    for (const town of await runTowns(ctx)) {
      if (seen.has(town.toLowerCase())) continue;
      seen.add(town.toLowerCase());
      await ensureNjRosterOrSkip(ctx, town, skipped);
    }
  }

  if (skippedTowns.length === 0 && !opts.offline) await clearRegistryStatusKey(ctx.db, company.companyId, 'nj_roster_skipped');

  const records = await candidateRecords(ctx, input);
  const emails = new Map(records.map((r) => [r.sourceKey, r.email]));
  const streets = new Map(records.map((r) => [r.sourceKey, r.address]));
  const outcome = ladderNj(
    { company, licenceNumbers: input.licenceNumbers, websiteDomain: input.websiteDomain },
    records.map(toCandidate),
    emails,
    streets,
  );
  await writeMatches(ctx.db, company.companyId, ['nj_hic_roster'], outcome.records);

  if (outcome.outcome !== 'match' || !outcome.chosen) {
    // Nothing found while a town's roster is missing is not "not registered": report the gap, never a false no_match.
    const s = outcome.outcome === 'candidate_only' ? 'candidate_only' : skippedTowns.length > 0 ? 'error' : 'no_match';
    await setRegistryStatus(ctx.db, company.companyId, skippedTowns.length > 0 ? { nj_hic: s, nj_roster_skipped: skippedTowns } : { nj_hic: s });
    out.statuses = { nj_hic_roster: s, nj_hic_detail: 'not_applicable', nj_principal_search: 'not_applicable' };
    return out;
  }

  const record = records.find((r) => r.sourceKey === outcome.chosen?.key) as RegistryRecord;
  const rung = outcome.chosen.rung;
  const active = isActiveStatus(record.status);
  out.statuses.nj_hic_roster = 'matched';
  out.evidenceIds.push(...(await ensureEvidence(ctx.evidence, company.companyId, njRosterEvidence(company.companyId, record, rung))));

  const status: Record<string, unknown> = { nj_hic: 'matched', nj_hic_active: active, nj_hic_rung: rung };
  if (skippedTowns.length > 0) status.nj_roster_skipped = skippedTowns;

  // HIC detail page: the registered owner.
  let owner: { display: string; detail: NjDetail | null } | null = null;
  const prior = (await ctx.evidence.listForCompany(company.companyId, 'owner_name')).find((e) => e.sourceType === 'nj_hic_detail' && e.status !== 'rejected');
  if (prior) {
    owner = { display: prior.value, detail: null };
    out.statuses.nj_hic_detail = 'matched';
  } else if (!isSourceEnabled(ctx.config, 'nj_hic_detail')) {
    out.statuses.nj_hic_detail = 'disabled';
  } else if (opts.offline) {
    out.statuses.nj_hic_detail = 'disabled';
  } else {
    try {
      const detail = await fetchNjOwner(ctx.fetcher, record.sourceKey);
      const display = detail.ownerName ? titleCaseName(detail.ownerName) : null;
      if (display && personNameKey(display).split(' ').length >= 2) {
        owner = { display, detail };
        const prov: Provenance = {
          companyId: company.companyId,
          registryRecordId: record.id,
          sourceType: 'nj_hic_detail',
          sourceUrl: detail.detailUrl,
          capturedAt: ctx.now(),
          extractor: 'nj-hic-detail',
        };
        const ids = await ensureEvidence(ctx.evidence, company.companyId, [
          makeDraft(prov, 'owner_name', display, `Owner Name: ${detail.ownerName}; License No: ${record.sourceKey}; License Status: ${detail.status ?? ''}`, 'high', {
            title: 'Owner',
            rung,
            licenceNo: record.sourceKey,
          }),
        ]);
        out.evidenceIds.push(...ids);
        const names = splitOwner(display);
        await ctx.db.$client.query(`DELETE FROM registry_people WHERE registry_record_id = $1 AND source_type = 'nj_hic_detail'`, [record.id]);
        await ctx.db.$client.query(
          `INSERT INTO registry_people (registry_record_id, source_type, name_raw, full_name, first_name, last_name, title, role_rank, source_url, captured_at)
           VALUES ($1, 'nj_hic_detail', $2, $3, $4, $5, 'Owner', 2, $6, $7)`,
          [record.id, detail.ownerName, display, names?.first ?? null, names?.last ?? null, detail.detailUrl, ctx.now()],
        );
        out.statuses.nj_hic_detail = 'matched';
      } else {
        out.statuses.nj_hic_detail = 'no_match';
      }
    } catch (e) {
      ctx.log.warn({ licence: record.sourceKey, err: (e as Error).message }, 'NJ HIC detail lookup failed');
      out.statuses.nj_hic_detail = 'error';
    }
  }

  if (owner) {
    out.owners = 1;
    status.nj_hic_detail = 'matched';
  } else {
    status.nj_hic_detail = out.statuses.nj_hic_detail;
  }

  // Free principal-name check: the owner is a principal of the registered company.
  const priorP = (await ctx.evidence.listForCompany(company.companyId, 'owner_name')).find((e) => e.sourceType === 'nj_principal_search' && e.status !== 'rejected');
  if (!owner) {
    out.statuses.nj_principal_search = 'not_applicable';
  } else if (priorP) {
    out.statuses.nj_principal_search = 'matched';
  } else if (!isSourceEnabled(ctx.config, 'nj_principal_search') || opts.offline) {
    out.statuses.nj_principal_search = 'disabled';
  } else {
    const names = splitOwner(owner.display);
    if (!names) {
      out.statuses.nj_principal_search = 'not_applicable';
    } else {
      try {
        const found = await confirmNjPrincipal(ctx.fetcher, names);
        const wanted = [record.legalName, owner.detail?.doingBusinessAs].filter((n): n is string => !!n).map((n) => normaliseBusinessName(n).norm);
        const entity = found.entities.find((e) => wanted.includes(normaliseBusinessName(e.name).norm));
        if (entity) {
          const prov: Provenance = {
            companyId: company.companyId,
            registryRecordId: record.id,
            sourceType: 'nj_principal_search',
            sourceUrl: found.searchUrl,
            capturedAt: ctx.now(),
            extractor: 'nj-principal-search',
          };
          const ids = await ensureEvidence(ctx.evidence, company.companyId, [
            makeDraft(
              prov,
              'owner_name',
              owner.display,
              `Principal Name search ${names.last.toUpperCase()}, ${names.first.toUpperCase()}: ${entity.name} (entity ${entity.entityId}, ${entity.city}, ${entity.type}, filed ${entity.filingDate})`,
              'high',
              { title: 'Principal', entityId: entity.entityId, confirms: record.sourceKey },
            ),
          ]);
          out.evidenceIds.push(...ids);
          out.statuses.nj_principal_search = 'matched';
        } else {
          out.statuses.nj_principal_search = 'no_match';
        }
      } catch (e) {
        ctx.log.warn({ err: (e as Error).message }, 'NJ principal search failed');
        out.statuses.nj_principal_search = 'error';
      }
    }
  }
  status.nj_principal_search = out.statuses.nj_principal_search;
  await setRegistryStatus(ctx.db, company.companyId, status);
  return out;
}

export { NJ_SOURCES };
