import type { Db, DnsResolver, EvidenceDraft } from '@pp/core';
import type { EmailFinding } from './emails/extract';
import { emailKind, type EmailKind } from './emails/rank';
import { checkMailDomain, type MailDomainCheck } from './emails/mx';

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
