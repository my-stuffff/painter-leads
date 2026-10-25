import type { Db, DnsResolver, EvidenceDraft } from '@pp/core';
import type { EmailFinding } from './emails/extract';
import { emailKind, type EmailKind } from './emails/rank';
import { checkMailDomain, type MailDomainCheck } from './emails/mx';
import type { LicenceFinding } from './licence';
import type { OwnerFinding } from './owners/extract';
import type { SignalHit } from './residential/signals';

export const EXTRACTOR_VERSION = '1';
export const EMAIL_EXTRACTOR = 'sites/emails';

const MX_REJECT: Record<string, string> = {
  null_mx: 'null MX (domain does not accept mail)',
  no_records: 'domain has no mail records',
};

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

/** MX / A-fallback verdict for every distinct domain of the accepted findings. */
export async function mailDomainChecks(
  findings: EmailFinding[],
  resolver: DnsResolver,
  db: Db | null,
  opts: { cacheOnly?: boolean; now?: () => Date } = {},
): Promise<Map<string, MailDomainCheck>> {
  const out = new Map<string, MailDomainCheck>();
  for (const f of findings) {
    if (!f.accepted) continue;
    const d = domainOf(f.address);
    if (!out.has(d)) out.set(d, await checkMailDomain(d, resolver, db, opts));
  }
  return out;
}

export interface EmailDraftOptions {
  companyId: number;
  capturedAt: Date;
  checks?: Map<string, MailDomainCheck>;
  /** Kind of each accepted address (personal / role / other). */
  kindOf?: (address: string) => EmailKind;
}

/** ENR-01 / ENR-06: one evidence row per (address, page); rejected candidates are kept for the audit. */
export function emailDrafts(findings: EmailFinding[], o: EmailDraftOptions): EvidenceDraft[] {
  return findings.map((f) => {
    const check = f.accepted ? o.checks?.get(domainOf(f.address)) : undefined;
    let status: EvidenceDraft['status'] = f.accepted ? 'accepted' : 'rejected';
    let rejectReason = f.rejectReason;
    let confidence: EvidenceDraft['confidence'] = !f.accepted ? 'low' : f.methods.every((m) => m === 'bundle') ? 'medium' : 'high';
    if (check && !check.accept) {
      if (check.needsReview) {
        status = 'needs_review';
        confidence = 'low';
        rejectReason = 'mx check error';
      } else {
        status = 'rejected';
        confidence = 'low';
        rejectReason = MX_REJECT[check.result] ?? 'domain cannot receive mail';
      }
    }
    return {
      companyId: o.companyId,
      field: 'email',
      value: f.address,
      sourceType: 'website',
      sourceUrl: f.pageUrl,
      pageSha256: f.pageSha256,
      capturedAt: o.capturedAt,
      snippet: f.snippet.slice(0, 1000) || f.address,
      extractor: EMAIL_EXTRACTOR,
      extractorVersion: EXTRACTOR_VERSION,
      confidence,
      status,
      rejectReason,
      attrs: {
        method: f.methods[0] ?? 'text',
        methods: f.methods,
        kind: (o.kindOf ?? emailKind)(f.address),
        rendered: f.rendered,
        ...(check ? { mx: check.result } : {}),
      },
    };
  });
}

export const OWNER_EXTRACTOR = 'sites/owners';
export const LICENCE_EXTRACTOR = 'sites/licence';

/** ENR-02 / ENR-06: one owner_name row per (person, page); rejected candidates are kept for the audit. */
export function ownerDrafts(findings: OwnerFinding[], o: { companyId: number; capturedAt: Date }): EvidenceDraft[] {
  return findings.map((f) => ({
    companyId: o.companyId,
    field: 'owner_name' as const,
    value: f.name,
    sourceType: 'website' as const,
    sourceUrl: f.pageUrl,
    pageSha256: f.pageSha256,
    capturedAt: o.capturedAt,
    snippet: f.snippet || f.name,
    extractor: OWNER_EXTRACTOR,
    extractorVersion: EXTRACTOR_VERSION,
    confidence: f.confidence,
    status: f.status,
    rejectReason: f.rejectReason,
    attrs: { title: f.title, method: f.method, rendered: f.rendered },
  }));
}

/** D-16: the NJ home-improvement registration number shown on the site (the join key for 01-03). */
export function licenceDrafts(findings: LicenceFinding[], o: { companyId: number; capturedAt: Date }): EvidenceDraft[] {
  return findings.map((f) => ({
    companyId: o.companyId,
    field: 'nj_hic_number' as const,
    value: f.number,
    sourceType: 'website' as const,
    sourceUrl: f.pageUrl,
    pageSha256: f.pageSha256,
    capturedAt: o.capturedAt,
    snippet: f.snippet,
    extractor: LICENCE_EXTRACTOR,
    extractorVersion: EXTRACTOR_VERSION,
    confidence: 'high' as const,
    status: 'accepted' as const,
    attrs: { rendered: f.rendered },
  }));
}

export const RESIDENTIAL_EXTRACTOR = 'sites/residential';
export const CLASSIFY_EXTRACTOR = 'sites/classify';

export interface CrawlMeta {
  pages: number;
  chars: number;
  serviceContent: boolean;
}

/**
 * One residential_signal row per hit: value `<polarity>:<id>`, snippet from the page. A commercial
 * hit cancelled by a negation is stored rejected ('negated'). Website rows carry how much of the site
 * was read (attrs.crawl), because the classify stage decides from the evidence alone.
 */
export function signalDrafts(
  hits: SignalHit[],
  o: { companyId: number; capturedAt: Date; extractor: string; pages?: Map<string, { sha256: string; rendered: boolean }>; crawl?: CrawlMeta },
): EvidenceDraft[] {
  return hits.map((h) => {
    const page = o.pages?.get(h.sourceUrl);
    return {
      companyId: o.companyId,
      field: 'residential_signal' as const,
      value: `${h.polarity}:${h.id}`,
      sourceType: h.sourceType === 'nj_hic_roster' ? ('nj_hic_roster' as const) : h.sourceType,
      sourceUrl: h.sourceUrl,
      pageSha256: page?.sha256 ?? null,
      capturedAt: o.capturedAt,
      snippet: h.snippet || h.text,
      extractor: o.extractor,
      extractorVersion: EXTRACTOR_VERSION,
      confidence: h.strength === 'strong' ? ('high' as const) : ('medium' as const),
      status: h.negated ? ('rejected' as const) : ('accepted' as const),
      rejectReason: h.negated ? 'negated' : null,
      attrs: {
        id: h.id,
        polarity: h.polarity,
        strength: h.strength,
        text: h.text,
        pos: h.position,
        rendered: page?.rendered ?? false,
        ...(o.crawl ? { crawl: o.crawl } : {}),
      },
    };
  });
}
