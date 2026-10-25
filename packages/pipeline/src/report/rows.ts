import {
  formatUsNational,
  toE164,
  zip5,
  type Db,
  type EvidenceRow,
  type ExclusionReason,
  type Confidence,
  type ResidentialLabel,
  type SourceType,
} from '@pp/core';
import type { PpConfig } from '@pp/core';
import {
  evidenceByCompany,
  listingsByCompany,
  loadCompanies,
  loadRun,
  runCompanyIds,
  type CompanyRow,
  type ListingRow,
  type RunRow,
} from '../data';
import { computeFacts, qualify } from '../qualify';
import {
  acceptedRows,
  CONFIDENCE_RANK,
  policyFor,
  rowsBehind,
  selectEmail,
  selectField,
  selectLatest,
  selectPhone,
} from '../select/policy';
import { isWebsiteMissingReason } from '../website-check';
import { MASTER_COLUMNS } from './columns';

export type Cell = string | number | null;

/** A value the report shows (or held back for low confidence), with where it came from. */
export interface ShownValue {
  value: string;
  confidence: Confidence;
  sourceUrl: string;
  snippet: string;
}

export const SAB_ADDRESS_TEXT = 'location approximate (service-area business)';

export const CLASSIFY_EXTRACTOR = 'pipeline/classify';

export interface ReportCompany {
  companyId: number;
  /** Keyed by the MASTER_COLUMNS header. */
  cells: Record<string, Cell>;
  name: string;
  state: string;
  city: string;
  qualified: boolean;
  reasons: ExclusionReason[];
  painterStatus: CompanyRow['painterStatus'];
  painterCategory: string | null;
  /** Every category of the company's listings (the Summary lists the unrecognised ones). */
  categories: string[];
  residentialStatus: ResidentialLabel | null;
  /** The company's own Google profile link (key for the verifier). */
  profileUrl: string | null;
  /** Shown value per truth field (name, phone, website, email, owner_name, owner_title, rating, review_count, address, zip, category, residential_status, is_painter). */
  shown: Record<string, ShownValue>;
  /** Candidates held back below config.report.minConfidence, per field. */
  lowCandidates: Record<string, ShownValue[]>;
}

export interface SourceRow {
  companyId: number;
  company: string;
  field: string;
  value: string;
  sourceUrl: string;
  capturedAt: Date;
  confidence: string;
}

export interface ReportData {
  run: RunRow;
  companies: ReportCompany[];
  sources: SourceRow[];
}

const OWNER_SOURCE_LABEL: Record<SourceType, string> = {
  google_maps: 'Google Maps',
  website: 'Company website',
  cslb_master: 'CSLB licence',
  cslb_personnel: 'CSLB licence',
  cslb_lookup: 'CSLB licence',
  nj_hic_roster: 'NJ HIC register',
  nj_hic_detail: 'NJ HIC register',
  nj_principal_search: 'NJ business register',
  tx_open_data: 'TX Comptroller',
  tx_comptroller: 'TX Comptroller',
  bbb: 'BBB',
};

export function sourceLabel(t: SourceType): string {
  return OWNER_SOURCE_LABEL[t];
}

export const RESIDENTIAL_LABEL_TEXT: Record<ResidentialLabel, string> = {
  residential_only: 'Residential only',
  residential_and_commercial: 'Residential and commercial',
  commercial_only: 'Commercial only',
  unclear: 'Unclear',
};

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** How a captured value is written in a cell (phones in national format, ZIP as 5 digits, email normalised). */
export function formatValue(field: string, row: EvidenceRow): string {
  switch (field) {
    case 'phone':
      return formatUsNational(toE164(row.value) ?? row.value);
    case 'zip':
      return zip5(row.value) ?? row.value;
    case 'email':
      return row.valueNorm;
    case 'tx_taxpayer_number':
      return `TX taxpayer ${row.value}`;
    default:
      return row.value;
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One row per company from the selected evidence values, plus the Sources rows behind every shown value. */
export async function buildReportData(db: Db, config: PpConfig, runId: number): Promise<ReportData> {
  const run = await loadRun(db, runId);
  const ids = await runCompanyIds(db, runId);
  const companies = await loadCompanies(db, ids);
  const listings = await listingsByCompany(db, ids);
  const evidence = await evidenceByCompany(db, ids);
  const policy = policyFor(config);

  const built: { company: ReportCompany; sources: SourceRow[] }[] = [];

  for (const c of companies) {
    const ls: ListingRow[] = listings.get(c.id) ?? [];
    const rows = evidence.get(c.id) ?? [];
    const sources: SourceRow[] = [];
    const cells: Record<string, Cell> = {};
    for (const col of MASTER_COLUMNS) cells[col] = null;

    const sab = c.locationPrecision === 'approximate';
    const primary = ls.find((l) => l.id === c.primaryListingId) ?? ls[0] ?? null;

    const addSources = (label: string, chosen: EvidenceRow | null, field = chosen?.field as string): void => {
      if (!chosen) return;
      for (const r of rowsBehind(rows, chosen)) {
        sources.push({
          companyId: c.id,
          company: c.displayName,
          field: label,
          value: formatValue(field, r),
          sourceUrl: r.sourceUrl,
          capturedAt: r.capturedAt,
          confidence: r.confidence,
        });
      }
    };

    // What the accuracy tools compare against the checker's truth: the value shown per truth field, and the
    // candidates that were held back for low confidence (so precision can be measured per confidence level).
    const shown: Record<string, ShownValue> = {};
    const lowCandidates: Record<string, ShownValue[]> = {};
    const show = (field: string, value: string, row: EvidenceRow | null): void => {
      if (row) shown[field] = { value, confidence: row.confidence, sourceUrl: row.sourceUrl, snippet: row.snippet };
    };
    const minRank = CONFIDENCE_RANK[policy.minConfidence];
    const holdBack = (field: 'owner_name' | 'email' | 'phone' | 'website', chosen: EvidenceRow | null): void => {
      const seen = new Set<string>(chosen ? [chosen.valueNorm] : []);
      const out: ShownValue[] = [];
      for (const r of acceptedRows(rows)) {
        if (r.field !== field || CONFIDENCE_RANK[r.confidence] >= minRank || seen.has(r.valueNorm)) continue;
        if (field === 'phone' && r.sourceType !== 'google_maps') continue;
        seen.add(r.valueNorm);
        out.push({ value: formatValue(field, r), confidence: r.confidence, sourceUrl: r.sourceUrl, snippet: r.snippet });
      }
      if (out.length > 0) lowCandidates[field] = out;
    };

    // Company
    cells['Company'] = c.displayName;
    const nameRows = rows.filter((r) => r.field === 'company_name' && r.status === 'accepted' && r.value === c.displayName);
    const nameRow = nameRows[0] ?? null;
    addSources('Company', nameRow);
    show('name', c.displayName, nameRow);

    // Owner
    const owner = selectField(rows, 'owner_name', policy);
    if (owner) {
      cells['Owner / decision-maker'] = owner.value;
      const title = owner.attrs.title;
      cells['Owner title'] = typeof title === 'string' && title.trim() ? title.trim() : null;
      cells['Owner source'] = sourceLabel(owner.sourceType);
      cells['Owner confidence'] = owner.confidence;
      addSources('Owner / decision-maker', owner);
      show('owner_name', owner.value, owner);
      if (cells['Owner title']) show('owner_title', cells['Owner title'] as string, owner);
    }
    holdBack('owner_name', owner);

    // Phone: the Google listing phone, national format
    const phone = selectPhone(rows, policy);
    if (phone) {
      cells['Phone'] = formatValue('phone', phone);
      addSources('Phone', phone);
      show('phone', cells['Phone'] as string, phone);
    }
    holdBack('phone', phone);

    // Email
    const email = selectEmail(rows, policy);
    if (email) {
      cells['Email'] = email.valueNorm;
      cells['Email source'] = sourceLabel(email.sourceType);
      addSources('Email', email);
      show('email', email.valueNorm, email);
    }
    holdBack('email', email);

    // Website
    const website = selectLatest(rows, 'website', policy, ['google_maps']) ?? selectField(rows, 'website', policy);
    if (website) {
      cells['Website'] = website.value;
      addSources('Website', website);
      show('website', website.value, website);
    } else {
      // The Google-listed domain does not exist: the cell stays blank and the Sources tab says why.
      const missing = rows.find((r) => r.field === 'website' && r.status === 'rejected' && isWebsiteMissingReason(r.rejectReason));
      if (missing) {
        const checked = (missing.attrs.websiteCheck as { checkedAt?: string } | undefined)?.checkedAt;
        sources.push({
          companyId: c.id,
          company: c.displayName,
          field: 'Website',
          value: missing.rejectReason as string,
          sourceUrl: missing.sourceUrl,
          capturedAt: checked ? new Date(checked) : missing.capturedAt,
          confidence: missing.confidence,
        });
      }
    }
    holdBack('website', website);

    // Rating / reviews
    const rating = selectLatest(rows, 'rating', policy);
    if (rating && Number.isFinite(Number(rating.value))) {
      cells['Google rating'] = Number(rating.value);
      addSources('Google rating', rating);
      show('rating', String(Number(rating.value)), rating);
    }
    const reviews = selectLatest(rows, 'review_count', policy);
    if (reviews && Number.isFinite(Number(reviews.value))) {
      cells['Google reviews'] = Number(reviews.value);
      addSources('Google reviews', reviews);
      show('review_count', String(Number(reviews.value)), reviews);
    }

    // Profile link (the listing's own URL is its source)
    const profileUrl = primary?.profileUrl ?? null;
    if (profileUrl) {
      cells['Google profile link'] = profileUrl;
      const own = rows.filter((r) => r.sourceUrl === profileUrl && r.sourceType === 'google_maps');
      const first = own.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())[0];
      sources.push({
        companyId: c.id,
        company: c.displayName,
        field: 'Google profile link',
        value: profileUrl,
        sourceUrl: profileUrl,
        capturedAt: first?.capturedAt ?? primary?.firstSeenAt ?? new Date(0),
        confidence: 'high',
      });
    }

    // Category
    const category = selectField(rows, 'category', policy);
    if (category) {
      cells['Category'] = category.value;
      addSources('Category', category);
      show('category', category.value, category);
    }

    // Address (a service-area business shows no address and no ZIP: its place comes from the map pin)
    if (sab) {
      cells['Address'] = SAB_ADDRESS_TEXT;
    } else {
      const addr = selectLatest(rows, 'street', policy) ?? selectLatest(rows, 'address', policy);
      if (addr) {
        cells['Address'] = addr.value;
        addSources('Address', addr);
        show('address', addr.value, addr);
      }
    }
    const city = selectLatest(rows, 'city', policy);
    if (city) {
      cells['City'] = city.value;
      addSources('City', city);
    }
    if (!sab) {
      const zip = selectLatest(rows, 'zip', policy);
      if (zip) {
        cells['ZIP'] = formatValue('zip', zip);
        addSources('ZIP', zip);
        show('zip', formatValue('zip', zip), zip);
      }
    }
    const state = selectLatest(rows, 'state', policy);
    if (state) {
      cells['State'] = state.value;
      addSources('State', state);
    }

    // Licence / registration number: CSLB (CA), NJ HIC (NJ), Comptroller taxpayer (TX)
    const licence =
      c.state === 'CA'
        ? selectField(
            rows.filter((r) => r.sourceType.startsWith('cslb')),
            'licence_number',
            policy,
          )
        : c.state === 'NJ'
          ? selectField(rows, 'nj_hic_number', policy)
          : c.state === 'TX'
            ? selectField(rows, 'tx_taxpayer_number', policy)
            : null;
    if (licence) {
      cells['Licence/registration no.'] = formatValue(licence.field, licence);
      addSources('Licence/registration no.', licence);
    }

    // Residential status and the signals behind it
    if (c.residentialStatus) {
      const label = RESIDENTIAL_LABEL_TEXT[c.residentialStatus];
      cells['Residential status'] = label;
      for (const r of rows) {
        if (r.field === 'residential_signal' && r.status === 'accepted' && r.extractor === CLASSIFY_EXTRACTOR) {
          sources.push({
            companyId: c.id,
            company: c.displayName,
            field: 'Residential status',
            value: label,
            sourceUrl: r.sourceUrl,
            capturedAt: r.capturedAt,
            confidence: r.confidence,
          });
        }
      }
    }

    // Classifier decisions (rules, not evidence rows of their own) for the accuracy tools
    const profileForShown = profileUrl ?? '';
    if (c.residentialStatus) {
      shown['residential_status'] = {
        value: RESIDENTIAL_LABEL_TEXT[c.residentialStatus],
        confidence: 'high',
        sourceUrl: rows.find((r) => r.field === 'residential_signal' && r.status === 'accepted')?.sourceUrl ?? profileForShown,
        snippet: c.residentialReason ?? RESIDENTIAL_LABEL_TEXT[c.residentialStatus],
      };
    }
    if (c.painterStatus !== 'unknown') {
      shown['is_painter'] = {
        value: c.painterStatus === 'painter' ? 'yes' : 'no',
        confidence: 'high',
        sourceUrl: profileForShown,
        snippet: c.painterReason ?? c.painterStatus,
      };
    }
    if (!shown['name']) shown['name'] = { value: c.displayName, confidence: 'high', sourceUrl: profileForShown, snippet: c.displayName };

    // Dates
    const firstSeen =ls.map((l) => l.firstSeenAt).sort((a, b) => a.getTime() - b.getTime())[0];
    const checked = ls
      .map((l) => l.lastCheckedAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    cells['First seen'] = firstSeen ? isoDate(firstSeen) : null;
    cells['Last checked'] = checked ? isoDate(checked) : null;

    // Qualification, judged now against the current thresholds (QUAL-04)
    const result = qualify(computeFacts(c, ls, rows, config), config);
    cells['Qualified'] = result.qualified ? 'yes' : 'no';
    cells['Exclusion reasons'] = result.reasons.join('; ');

    built.push({
      company: {
        companyId: c.id,
        cells,
        name: c.displayName,
        state: c.state ?? '',
        city: typeof cells['City'] === 'string' ? cells['City'] : '',
        qualified: result.qualified,
        reasons: result.reasons,
        painterStatus: c.painterStatus,
        painterCategory: c.painterCategory,
        categories: [
          ...new Set([
            ...ls.flatMap((l) => l.categories),
            ...rows.filter((r) => r.field === 'category' && r.status === 'accepted').map((r) => r.value),
          ]),
        ],
        residentialStatus: c.residentialStatus,
        profileUrl,
        shown,
        lowCandidates,
      },
      sources,
    });
  }

  // State, city, then company name (case-insensitive); the id breaks ties so two reports match cell for cell.
  built.sort(
    (a, b) =>
      cmp(a.company.state.toLowerCase(), b.company.state.toLowerCase()) ||
      cmp(a.company.city.toLowerCase(), b.company.city.toLowerCase()) ||
      cmp(a.company.name.toLowerCase(), b.company.name.toLowerCase()) ||
      a.company.companyId - b.company.companyId,
  );

  return { run, companies: built.map((b) => b.company), sources: built.flatMap((b) => b.sources) };
}
