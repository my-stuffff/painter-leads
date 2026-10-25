import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  registrableDomain,
  toE164,
  type Db,
  type EvidenceRow,
  type Fetcher,
  type GoldenReplayers,
  type PpConfig,
  type ResidentialLabel,
} from '@pp/core';
import { evidenceByCompany, listingsByCompany, loadCompanies, loadRun } from '../data';
import { q } from '../sql';
import { compareTruth, loadSystemSamples, normaliseForCompare, type ResultRow } from './compare';
import {
  loadGoldenCase,
  MAPS_CARD_KEYS,
  replayCase,
  type GoldenCase,
  type GoldenDiff,
  type GoldenTruth,
  type MapsCardKey,
} from './golden-replay';
import { isNotFindable, NOT_FINDABLE, parseAdjudicationCsv, parseTruthCsv, type TruthField, type TruthRow } from './truth';

/** No golden file may be larger than this (the repo guard refuses files over 1 MB too). */
export const MAX_GOLDEN_FILE_BYTES = 1_000_000;

/**
 * Smaller pages for the repo: drop <style>, <svg>, HTML comments and every <script> except application/ld+json.
 * pages.json keeps the original sha256 and URL, and the post-export replay warns if slimming changed an answer.
 */
export function slimHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, (all, attrs: string) =>
      /type\s*=\s*["']?application\/ld\+json/i.test(attrs) ? all : '',
    );
}

export const nameSlug = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');

export interface GoldenExportOptions {
  truthText: string;
  adjudicationText?: string;
  /** Where the cases go: <outDir>/<state>/<slug>/ (default in the CLI: <repo>/fixtures/golden). */
  outDir: string;
  /** Only readCached is used (pages come from the fetcher's disk cache, nothing is requested). */
  fetcher: Pick<Fetcher, 'readCached'>;
  /** When given, every exported case is replayed once and differences from the system's stored output become warnings. */
  replayers?: Partial<GoldenReplayers>;
  maxFileBytes?: number;
}

export interface GoldenExportResult {
  cases: { state: string; slug: string; dir: string; pages: number }[];
  totalBytes: number;
  warnings: string[];
}

const RESIDENTIAL_KEYS = new Set<string>(['residential_only', 'residential_and_commercial', 'commercial_only', 'unclear']);

function writeGuarded(file: string, data: string | Buffer, max: number, tally: { bytes: number }): void {
  const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  if (size > max) throw new Error(`golden file ${file} is ${size} bytes, over the ${max} byte limit; not written`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  tally.bytes += size;
}

const truthValues = (rows: TruthRow[], sampleId: string, field: TruthField): TruthRow[] =>
  rows.filter((r) => r.sample_id === sampleId && r.field === field && r.value !== '');

function websiteRows(rows: EvidenceRow[], field: 'email' | 'owner_name', statuses: string[]): EvidenceRow[] {
  return rows.filter((r) => r.field === field && r.sourceType === 'website' && statuses.includes(r.status));
}

/**
 * `pp accuracy golden-export`: for each sampled company writes pages (slimmed, gzip), pages.json, maps-card.json,
 * registry.json (no raw roster / personnel columns) and truth.json. Expected values are the checker's truth; owners and
 * emails are limited to what the website extractor can be asked for (a registry-only owner is not demanded of a page).
 */
export async function exportGolden(db: Db, config: PpConfig, runId: number, o: GoldenExportOptions): Promise<GoldenExportResult> {
  const max = o.maxFileBytes ?? MAX_GOLDEN_FILE_BYTES;
  const run = await loadRun(db, runId);
  const systems = await loadSystemSamples(db, config, runId);
  const truth = parseTruthCsv(o.truthText);
  const compared = compareTruth({
    samples: systems,
    truth,
    adjudication: o.adjudicationText ? parseAdjudicationCsv(o.adjudicationText) : [],
    drift: config.accuracy.drift,
    runFrozenAt: run.finishedAt ?? run.createdAt,
    truthWithinHours: config.accuracy.truthWithinHours,
  });

  const ids = systems.map((s) => s.companyId);
  const companies = new Map((await loadCompanies(db, ids)).map((c) => [c.id, c] as const));
  const listings = await listingsByCompany(db, ids);
  const evidence = await evidenceByCompany(db, ids);

  const tally = { bytes: 0 };
  const result: GoldenExportResult = { cases: [], totalBytes: 0, warnings: [] };
  const exported: GoldenCase[] = [];

  for (const s of systems) {
    const company = companies.get(s.companyId);
    if (!company) continue;
    if (!truth.some((r) => r.sample_id === s.sampleId && r.value !== '')) {
      result.warnings.push(`${s.sampleId}: the checker gave no truth values; not exported`);
      continue;
    }
    const ls = listings.get(company.id) ?? [];
    const primary = ls.find((l) => l.id === company.primaryListingId) ?? ls[0];
    const rows = evidence.get(company.id) ?? [];
    const slug = `${s.sampleId.toLowerCase()}-${nameSlug(company.displayName)}`;
    const state = company.state ?? run.state;
    const dir = path.join(o.outDir, state, slug);
    const resultsFor = (field: TruthField): ResultRow[] => compared.rows.filter((r) => r.sampleId === s.sampleId && r.field === field);

    // ---- pages (from the fetcher's disk cache), slimmed and gzipped
    const websiteUrl = primary?.websiteUrl ?? null;
    const hosts = new Set<string>();
    if (websiteUrl) {
      const h = registrableDomain(websiteUrl).host;
      if (h) {
        hosts.add(h);
        hosts.add(h.replace(/^www\./, ''));
        hosts.add(`www.${h.replace(/^www\./, '')}`);
      }
    }
    const shas = [...new Set(rows.map((r) => r.pageSha256).filter((x): x is string => !!x))];
    const pageRows =
      shas.length === 0 && hosts.size === 0
        ? []
        : await q<{ url: string; final_url: string | null; sha256: string; rendered: boolean }>(
            db,
            `SELECT url, final_url, sha256, rendered FROM pages
               WHERE sha256 = ANY($1::text[]) OR (source = 'websites' AND host = ANY($2::text[]))
               ORDER BY id`,
            [shas, [...hosts]],
          );
    const pagesMeta: { url: string; sha256: string; rendered: boolean }[] = [];
    for (const p of pageRows) {
      const body = await o.fetcher.readCached(p.sha256);
      if (!body) {
        result.warnings.push(`${state}/${slug}: page ${p.url} is not in the cache; left out`);
        continue;
      }
      writeGuarded(path.join(dir, 'pages', `${p.sha256}.html.gz`), gzipSync(Buffer.from(slimHtml(body.toString('utf8')), 'utf8'), { level: 9 }), max, tally);
      pagesMeta.push({ url: p.final_url ?? p.url, sha256: p.sha256, rendered: p.rendered });
    }
    writeGuarded(path.join(dir, 'pages.json'), `${JSON.stringify(pagesMeta, null, 2)}\n`, max, tally);

    // ---- maps card
    const cardRow = primary
      ? await q<{ card_raw: unknown; place_raw: unknown }>(db, `SELECT card_raw, place_raw FROM listings WHERE id = $1`, [primary.id])
      : [];
    writeGuarded(
      path.join(dir, 'maps-card.json'),
      `${JSON.stringify({ card_raw: cardRow[0]?.card_raw ?? null, place_raw: cardRow[0]?.place_raw ?? null }, null, 2)}\n`,
      max,
      tally,
    );

    // ---- registry rows (no raw roster / personnel columns: only the fields the matcher and the owner come from)
    const matched = await q<Record<string, unknown>>(
      db,
      `SELECT rr.id AS rid, rr.source_type, rr.source_key, rr.state, rr.legal_name, rr.dba_name, rr.name_norm, rr.name_core,
              rr.aliases, rr.address, rr.city, rr.zip, rr.phone_e164, rr.phone_last10, rr.email, rr.status, rr.classifications,
              rr.business_type, rr.issued_on, rr.expires_on, rr.source_url, rm.rung, rm.strength
         FROM registry_matches rm JOIN registry_records rr ON rr.id = rm.registry_record_id
        WHERE rm.company_id = $1 ORDER BY rr.id`,
      [company.id],
    );
    const candidates: unknown[] = [];
    const matches: { sourceKey: string; strength: 'strong' | 'candidate' }[] = [];
    for (const m of matched) {
      const people = await q<{ full_name: string | null; title: string | null }>(
        db,
        `SELECT full_name, title FROM registry_people WHERE registry_record_id = $1 ORDER BY id`,
        [m.rid],
      );
      candidates.push({
        sourceType: m.source_type,
        sourceKey: m.source_key,
        state: m.state,
        legalName: m.legal_name,
        dbaName: m.dba_name,
        nameNorm: m.name_norm,
        nameCore: m.name_core,
        aliases: m.aliases,
        address: m.address,
        city: m.city,
        zip: m.zip,
        phoneE164: m.phone_e164,
        phoneLast10: m.phone_last10,
        email: m.email,
        status: m.status,
        classifications: m.classifications,
        businessType: m.business_type,
        issuedOn: m.issued_on,
        expiresOn: m.expires_on,
        sourceUrl: m.source_url,
        owners: people.map((p) => ({ name: p.full_name, title: p.title })),
      });
      matches.push({ sourceKey: m.source_key as string, strength: m.strength as 'strong' | 'candidate' });
    }
    writeGuarded(path.join(dir, 'registry.json'), `${JSON.stringify({ candidates, matches }, null, 2)}\n`, max, tally);

    // ---- truth.json
    const fields: GoldenTruth['fields'] = {};

    const emailTruth = truthValues(truth, s.sampleId, 'email');
    if (emailTruth.length > 0) {
      const wanted = emailTruth.filter((t) => !isNotFindable(t.value)).map((t) => normaliseForCompare('email', t.value));
      const onSite = new Set(websiteRows(rows, 'email', ['accepted']).map((r) => r.valueNorm));
      fields.emails = wanted.length === 0 ? NOT_FINDABLE : wanted.filter((e) => onSite.has(e));
    }

    const ownerTruth = truthValues(truth, s.sampleId, 'owner_name');
    if (ownerTruth.length > 0) {
      const wanted = ownerTruth.filter((t) => !isNotFindable(t.value)).map((t) => t.value);
      const wantedKeys = new Set(wanted.map((w) => normaliseForCompare('owner_name', w)));
      const onSite = websiteRows(rows, 'owner_name', ['accepted']);
      const rejectedClaims = websiteRows(rows, 'owner_name', ['rejected', 'needs_review']);
      fields.owners = {
        expected: wanted.length === 0 ? NOT_FINDABLE : onSite.filter((r) => wantedKeys.has(r.valueNorm)).map((r) => r.value),
        ignore: [...new Set(rejectedClaims.map((r) => r.value))],
      };
    }

    const resTruth = truthValues(truth, s.sampleId, 'residential_status')[0];
    if (resTruth) {
      const key = isNotFindable(resTruth.value) ? 'unclear' : normaliseForCompare('residential_status', resTruth.value);
      if (RESIDENTIAL_KEYS.has(key)) fields.residential = key as ResidentialLabel;
    }

    const card: Partial<Record<MapsCardKey, string | null>> = {};
    for (const k of MAPS_CARD_KEYS) {
      const rowsOfField = truthValues(truth, s.sampleId, k);
      const t = rowsOfField[0];
      if (!t) continue;
      if (isNotFindable(t.value)) {
        card[k] = null;
        continue;
      }
      const ok = resultsFor(k).find((r) => r.shown && r.cls === 'correct');
      const value = ok ? ok.systemValue : t.value;
      card[k] = k === 'phone' ? (toE164(value) ?? value) : value;
    }
    if (Object.keys(card).length > 0) fields.maps_card = card;
    fields.registry_match = matches;

    const goldenTruth: GoldenTruth = {
      sample_id: s.sampleId,
      company: {
        name: company.displayName,
        state: (company.state ?? run.state) as GoldenTruth['company']['state'],
        city: primary?.city ?? null,
        zip: primary?.zip ?? null,
        street: primary?.street ?? null,
        websiteUrl,
        phoneE164: primary?.phoneE164 ?? null,
        categories: [...new Set(ls.flatMap((l) => l.categories))],
      },
      nj_hic_active: typeof company.registryStatus.nj_hic_active === 'boolean' ? company.registryStatus.nj_hic_active : null,
      fields,
    };
    writeGuarded(path.join(dir, 'truth.json'), `${JSON.stringify(goldenTruth, null, 2)}\n`, max, tally);

    result.cases.push({ state, slug, dir, pages: pagesMeta.length });

    // What the system itself produced, to prove slimming did not change a golden answer
    if (o.replayers) {
      const storedCard: Partial<Record<MapsCardKey, string | null>> = {
        name: primary?.name ?? null,
        rating: primary?.rating !== null && primary?.rating !== undefined ? String(primary.rating) : null,
        review_count: primary?.reviewCount !== null && primary?.reviewCount !== undefined ? String(primary.reviewCount) : null,
        phone: primary?.phoneE164 ?? null,
        category: primary?.categories[0] ?? null,
        website: primary?.websiteUrl ?? null,
      };
      const stored: GoldenTruth = {
        ...goldenTruth,
        fields: {
          emails: websiteRows(rows, 'email', ['accepted']).map((r) => r.valueNorm),
          owners: { expected: websiteRows(rows, 'owner_name', ['accepted']).map((r) => r.value), ignore: goldenTruth.fields.owners?.ignore ?? [] },
          ...(company.residentialStatus ? { residential: company.residentialStatus } : {}),
          maps_card: storedCard,
          registry_match: matches,
        },
      };
      exported.push(loadGoldenCase(dir, stored));
    }
  }

  if (o.replayers) {
    for (const c of exported) {
      let diffs: GoldenDiff[] = [];
      try {
        diffs = replayCase(c, o.replayers);
      } catch (e) {
        result.warnings.push(`${c.state}/${c.slug}: cannot replay (${(e as Error).message})`);
        continue;
      }
      for (const d of diffs) {
        result.warnings.push(`${d.state}/${d.slug}/${d.field}: replay gives ${d.actual} but the system stored ${d.expected}`);
      }
    }
  }

  result.totalBytes = tally.bytes;
  return result;
}
