import {
  isSourceEnabled,
  last10,
  normaliseBusinessName,
  toE164,
  zip5,
  type EvidenceDraft,
  type RegistryMatchInput,
  type RegistrySourceStatus,
  type StageContext,
} from '@pp/core';
import { roleRank } from '../cslb/owner';
import { ensureEvidence, makeDraft, type Provenance } from '../evidence';
import { matchLadder, type LadderCandidate } from '../match/ladder';
import { setRegistryStatus, writeMatches } from '../records';
import type { SourceOutcome, StageOptions } from '../types';
import { BbbBlockedError, BbbBreaker, bbbGet } from './breaker';
import { parseBbbProfile, type BbbProfile } from './profile';
import { discoverBbbProfileUrls, profileSlugName } from './sitemaps';

/** What a profile page tells us, with where and when it was read. */
export interface BbbPage {
  profile: BbbProfile;
  capturedAt: Date;
  sourceUrl: string;
  pageSha256: string | null;
}

/** Per stage instance: one circuit breaker per run, and the profile URLs found for a state+city. */
export class BbbSession {
  private readonly breakers = new Map<number, BbbBreaker>();
  private readonly urls = new Map<string, Promise<string[]>>();

  breaker(runId: number): BbbBreaker {
    let b = this.breakers.get(runId);
    if (!b) {
      b = new BbbBreaker();
      this.breakers.set(runId, b);
    }
    return b;
  }

  profileUrls(ctx: StageContext, where: { state: string; city: string }, opts: StageOptions): Promise<string[]> {
    const key = `${where.state}|${where.city.toLowerCase()}|${ctx.runId}`;
    let p = this.urls.get(key);
    if (!p) {
      p = discoverBbbProfileUrls(ctx.fetcher, this.breaker(ctx.runId), where, { offline: opts.offline });
      this.urls.set(key, p);
      p.catch(() => this.urls.delete(key));
    }
    return p;
  }
}

/** Profile URLs whose slug name looks like the company (equal core name, or one core contains the other). */
export function slugCandidates(urls: string[], companyName: string): string[] {
  const mine = normaliseBusinessName(companyName);
  return urls.filter((u) => {
    const theirs = normaliseBusinessName(profileSlugName(u));
    if (!theirs.core || !mine.core) return theirs.norm === mine.norm;
    return theirs.core === mine.core || theirs.core.includes(mine.core) || mine.core.includes(theirs.core);
  });
}

function pageCandidate(p: BbbProfile, recordId: number): LadderCandidate {
  const n = normaliseBusinessName(p.name ?? profileSlugName(p.url));
  return {
    key: p.url,
    recordId,
    nameNorm: n.norm,
    nameCore: n.core,
    aliasNorms: n.aliases,
    city: p.city,
    zip: zip5(p.zip),
    phoneLast10: p.telephone ? last10(p.telephone) : null,
    status: null,
    expiresOn: null,
  };
}

async function upsertProfileRecord(ctx: StageContext, page: BbbPage): Promise<number> {
  const p = page.profile;
  const n = normaliseBusinessName(p.name ?? profileSlugName(p.url));
  const res = await ctx.db.$client.query(
    `INSERT INTO registry_records (source_type, source_key, state, legal_name, name_norm, name_core, aliases, address, city, zip,
                                   phone_e164, phone_last10, raw, source_url, captured_at)
     VALUES ('bbb', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
     ON CONFLICT (source_type, source_key) DO UPDATE SET
       legal_name = excluded.legal_name, name_norm = excluded.name_norm, name_core = excluded.name_core,
       aliases = excluded.aliases, address = excluded.address, city = excluded.city, zip = excluded.zip,
       phone_e164 = excluded.phone_e164, phone_last10 = excluded.phone_last10, raw = excluded.raw,
       source_url = excluded.source_url, captured_at = excluded.captured_at
     RETURNING id`,
    [
      p.url,
      p.region ? p.region.toUpperCase() : null,
      p.name,
      n.norm,
      n.core,
      n.aliases,
      p.street,
      p.city,
      zip5(p.zip),
      p.telephone ? toE164(p.telephone) : null,
      p.telephone ? last10(p.telephone) : null,
      JSON.stringify({ people: p.people.map((x) => ({ name: x.name, jobTitle: x.jobTitle, from: x.from })), website: p.website }),
      page.sourceUrl,
      page.capturedAt,
    ],
  );
  return res.rows[0].id as number;
}

function ownerEvidence(companyId: number, recordId: number, page: BbbPage, rung: string): EvidenceDraft[] {
  const prov: Provenance = {
    companyId,
    registryRecordId: recordId,
    sourceType: 'bbb',
    sourceUrl: page.sourceUrl,
    capturedAt: page.capturedAt,
    extractor: 'bbb-profile',
    pageSha256: page.pageSha256,
  };
  const out: EvidenceDraft[] = [];
  for (const person of page.profile.people) {
    const rank = roleRank(person.jobTitle) ?? (/founder|owner|principal|proprietor/i.test(person.jobTitle ?? '') ? 2 : null);
    if (rank === null && !/manager|director|partner/i.test(person.jobTitle ?? '')) continue;
    const source = person.from === 'json-ld' ? 'JSON-LD employee' : 'Business Management';
    out.push(
      makeDraft(prov, 'owner_name', person.name, `${source}: ${person.name}, ${person.jobTitle ?? ''} (${page.profile.name ?? ''}, ${page.profile.city ?? ''})`, rank !== null && rank <= 2 ? 'high' : 'medium', {
        title: person.jobTitle,
        rung,
        profile: page.profile.url,
      }),
    );
  }
  return out;
}

/**
 * Matches one company against already-read BBB profile pages and writes owner evidence for a STRONG match only
 * (phone equal, or equal name in the same ZIP/city). Never an email (BBB shows none).
 */
export async function matchProfiles(
  ctx: StageContext,
  input: RegistryMatchInput,
  pages: BbbPage[],
): Promise<{ status: RegistrySourceStatus; evidenceIds: number[]; owners: number }> {
  const { company } = input;
  const ids = new Map<string, number>();
  const byUrl = new Map<string, BbbPage>();
  const candidates: LadderCandidate[] = [];
  for (const page of pages) {
    const id = await upsertProfileRecord(ctx, page);
    ids.set(page.profile.url, id);
    byUrl.set(page.profile.url, page);
    candidates.push(pageCandidate(page.profile, id));
  }
  const outcome = matchLadder(
    { name: company.name, city: company.city, zip: company.zip, phoneLast10: company.phoneE164 ? last10(company.phoneE164) : null },
    candidates,
  );
  await writeMatches(ctx.db, company.companyId, ['bbb'], outcome.records);
  if (outcome.outcome !== 'match' || !outcome.chosen) {
    const status: RegistrySourceStatus = outcome.outcome === 'candidate_only' ? 'candidate_only' : 'no_match';
    await setRegistryStatus(ctx.db, company.companyId, { bbb: status });
    return { status, evidenceIds: [], owners: 0 };
  }
  const page = byUrl.get(outcome.chosen.key) as BbbPage;
  const drafts = ownerEvidence(company.companyId, ids.get(page.profile.url) as number, page, outcome.chosen.rung);
  const evidenceIds = await ensureEvidence(ctx.evidence, company.companyId, drafts);
  await setRegistryStatus(ctx.db, company.companyId, { bbb: 'matched', bbb_owner: drafts.length > 0 ? 'found' : 'none' });
  return { status: 'matched', evidenceIds, owners: drafts.length > 0 ? 1 : 0 };
}

/**
 * BBB in the stage: find the company's profile through the sitemaps, read it, match. A Cloudflare block (this
 * laptop) trips the per-run breaker: this and every later company get 'blocked' and no further request goes to
 * bbb.org (D-21). A blocked source is never reported as "no owner".
 */
export async function matchBbb(ctx: StageContext, input: RegistryMatchInput, opts: StageOptions, session: BbbSession): Promise<SourceOutcome> {
  const none = (s: RegistrySourceStatus): SourceOutcome => ({ statuses: { bbb: s }, evidenceIds: [], owners: 0 });
  if (!isSourceEnabled(ctx.config, 'bbb')) return none('disabled');
  const { company } = input;
  const breaker = session.breaker(ctx.runId);
  const markBlocked = async (): Promise<SourceOutcome> => {
    await setRegistryStatus(ctx.db, company.companyId, { bbb: 'blocked' });
    return none('blocked');
  };
  if (breaker.tripped) return markBlocked();
  if (!company.city) {
    await setRegistryStatus(ctx.db, company.companyId, { bbb: 'no_match' });
    return none('no_match');
  }

  try {
    const urls = await session.profileUrls(ctx, { state: company.state, city: company.city }, opts);
    const picks = slugCandidates(urls, company.name).slice(0, 3);
    const pages: BbbPage[] = [];
    for (const url of picks) {
      const res = await bbbGet(ctx.fetcher, breaker, url, { offline: opts.offline, runId: ctx.runId });
      if (res.status !== 200) continue;
      pages.push({ profile: parseBbbProfile(res.text(), url), capturedAt: res.fetchedAt, sourceUrl: res.finalUrl, pageSha256: res.sha256 });
    }
    const r = await matchProfiles(ctx, input, pages);
    return { statuses: { bbb: r.status }, evidenceIds: r.evidenceIds, owners: r.owners };
  } catch (e) {
    if (e instanceof BbbBlockedError) return markBlocked();
    throw e;
  }
}
