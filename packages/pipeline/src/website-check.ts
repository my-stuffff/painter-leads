import { createDnsResolver, type DnsResolver, type StageContext } from '@pp/core';
import { q, q1 } from './sql';

/** Public resolvers for the second lookup: this machine's own DNS is known to miss some real domains. */
export const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

/** Starts the reject reason (and the Sources text) of a Google-listed website whose domain does not exist. */
export const WEBSITE_MISSING_TEXT = 'website listed on Google does not exist';

export function websiteMissingReason(checkedAt: Date): string {
  return `${WEBSITE_MISSING_TEXT} (checked ${checkedAt.toISOString().slice(0, 10)})`;
}

export function isWebsiteMissingReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.startsWith(WEBSITE_MISSING_TEXT);
}

export type DomainVerdict = 'not_found' | 'exists' | 'unknown';

const codeOf = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? '');

/**
 * Confirmed non-existent only when the public resolver answers NXDOMAIN (ENOTFOUND) for both the A and the AAAA
 * lookup. An answer with addresses, "no data", a timeout or any other error is never "does not exist".
 */
export async function lookupDomain(resolver: DnsResolver, host: string): Promise<DomainVerdict> {
  const attempt = async (f: (h: string) => Promise<string[]>): Promise<'found' | 'nxdomain' | 'other'> => {
    try {
      return (await f(host)).length > 0 ? 'found' : 'other';
    } catch (e) {
      return codeOf(e) === 'ENOTFOUND' ? 'nxdomain' : 'other';
    }
  };
  const [a, aaaa] = [await attempt((h) => resolver.resolve4(h)), await attempt((h) => resolver.resolve6(h))];
  if (a === 'found' || aaaa === 'found') return 'exists';
  return a === 'nxdomain' && aaaa === 'nxdomain' ? 'not_found' : 'unknown';
}

function hostOf(listed: string): string | null {
  const t = listed.trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The crawl's last word on this host: the system resolver said ENOTFOUND (not EAI_AGAIN, a timeout or an HTTP error). */
async function systemSaidNotFound(ctx: StageContext, host: string): Promise<boolean> {
  const last = await q1<{ outcome: string; note: string | null }>(
    ctx.db,
    `SELECT outcome, note FROM request_log
      WHERE source = 'websites' AND lower(host) = $1 AND outcome <> 'offline_miss'
      ORDER BY at DESC, id DESC LIMIT 1`,
    [host],
  );
  return last?.outcome === 'dns_error' && /\bENOTFOUND\b/.test(last.note ?? '');
}

export interface WebsiteCheckResult {
  /** Listed websites whose crawl got ENOTFOUND and that were looked up on the public resolver. */
  checked: number;
  /** Of those, confirmed non-existent (their Google-listed value is now rejected with the reason). */
  missing: number;
}

/**
 * A website listed on Google whose domain does not exist is not shown (a blank is acceptable, a wrong value is not).
 * Only a crawl that got ENOTFOUND from the system resolver (read from request_log, so it also works when the fix loop
 * re-runs offline) AND a second lookup on public resolvers that answers NXDOMAIN for both address types counts.
 * The Google-listed evidence stays, marked rejected with the reason; the report shows the reason on the Sources tab.
 * Evidence already rejected is not looked up again.
 */
export async function checkListedWebsites(
  ctx: StageContext,
  companyIds: number[],
  o: { resolver?: DnsResolver } = {},
): Promise<WebsiteCheckResult> {
  const result: WebsiteCheckResult = { checked: 0, missing: 0 };
  if (companyIds.length === 0) return result;

  const rows = await q<{ id: string; company_id: number; value: string }>(
    ctx.db,
    `SELECT id, company_id, value FROM evidence
      WHERE company_id = ANY($1::int[]) AND field = 'website' AND status = 'accepted' ORDER BY id`,
    [companyIds],
  );

  const byHost = new Map<string, { companyId: number; ids: string[] }[]>();
  for (const r of rows) {
    const host = hostOf(r.value);
    if (!host) continue;
    const list = byHost.get(host) ?? [];
    const own = list.find((x) => x.companyId === r.company_id);
    if (own) own.ids.push(r.id);
    else list.push({ companyId: r.company_id, ids: [r.id] });
    byHost.set(host, list);
  }

  let resolver = o.resolver;
  const checkedAt = ctx.now();
  const reason = websiteMissingReason(checkedAt);
  for (const [host, owners] of byHost) {
    if (!(await systemSaidNotFound(ctx, host))) continue;
    resolver ??= createDnsResolver(PUBLIC_RESOLVERS);
    result.checked += 1;
    const verdict = await lookupDomain(resolver, host);
    ctx.log.info({ host, verdict }, 'listed website lookup on public resolvers');
    if (verdict !== 'not_found') continue;
    result.missing += 1;
    const attrs = JSON.stringify({ websiteCheck: { host, resolvers: PUBLIC_RESOLVERS, verdict, checkedAt: checkedAt.toISOString() } });
    await q(
      ctx.db,
      `UPDATE evidence SET status = 'rejected', reject_reason = $2, attrs = attrs || $3::jsonb WHERE id = ANY($1::bigint[])`,
      [owners.flatMap((x) => x.ids), reason, attrs],
    );
  }
  return result;
}
