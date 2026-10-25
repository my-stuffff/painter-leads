import type { Db, DnsResolver } from '@pp/core';
import { FREE_MAIL_DOMAINS } from '@pp/core';

export type MailDomainResult = 'free_mail' | 'mx' | 'a_fallback' | 'null_mx' | 'no_records' | 'error';

export interface MailDomainCheck {
  domain: string;
  result: MailDomainResult;
  /** accept = the domain can receive mail (or is free-mail). */
  accept: boolean;
  /** true when the lookup itself failed (kept as needs_review, never rejected). */
  needsReview: boolean;
  detail: string;
  fromCache: boolean;
}

const CACHE_HOURS = 24 * 7;

function code(e: unknown): string {
  return String((e as { code?: unknown }).code ?? '');
}

const NO_DATA = new Set(['ENODATA', 'ENOTFOUND', 'ENOENT']);

function verdict(domain: string, result: Exclude<MailDomainResult, 'free_mail'>, detail: string, fromCache = false): MailDomainCheck {
  return {
    domain,
    result,
    accept: result === 'mx' || result === 'a_fallback',
    needsReview: result === 'error',
    detail,
    fromCache,
  };
}

async function readCache(db: Db, domain: string, now: Date): Promise<MailDomainCheck | null> {
  try {
    const r = await db.$client.query<{ result: string; detail: { text?: string } | null; checked_at: Date }>(
      'SELECT result, detail, checked_at FROM dns_checks WHERE domain = $1',
      [domain],
    );
    const row = r.rows[0];
    if (!row || row.result === 'error') return null;
    if (now.getTime() - row.checked_at.getTime() > CACHE_HOURS * 3_600_000) return null;
    return verdict(domain, row.result as Exclude<MailDomainResult, 'free_mail' | 'error'>, row.detail?.text ?? 'cached', true);
  } catch {
    return null;
  }
}

async function writeCache(db: Db, c: MailDomainCheck, now: Date): Promise<void> {
  try {
    await db.$client.query(
      `INSERT INTO dns_checks (domain, result, detail, checked_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain) DO UPDATE SET result = EXCLUDED.result, detail = EXCLUDED.detail, checked_at = EXCLUDED.checked_at`,
      [c.domain, c.result, JSON.stringify({ text: c.detail }), now],
    );
  } catch {
    // the cache is an optimisation only
  }
}

/**
 * D-17 / ENR-07: can this domain receive mail? Free-mail domains are never looked up. MX records
 * -> 'mx'; none -> A/AAAA fallback (RFC 5321 implicit MX) -> 'a_fallback'; a single MX with an empty
 * exchange or "." is a null MX (RFC 7505) -> reject; NXDOMAIN / nothing -> 'no_records' reject; any
 * other lookup error -> 'error' (needs_review). Results are cached in dns_checks.
 */
export async function checkMailDomain(
  domainRaw: string,
  resolver: DnsResolver,
  db: Db | null,
  opts: { cacheOnly?: boolean; now?: () => Date } = {},
): Promise<MailDomainCheck> {
  const domain = domainRaw.trim().toLowerCase();
  if (FREE_MAIL_DOMAINS.includes(domain)) {
    return { domain, result: 'free_mail', accept: true, needsReview: false, detail: 'free-mail provider, not looked up', fromCache: false };
  }
  const now = (opts.now ?? (() => new Date()))();
  if (db) {
    const cached = await readCache(db, domain, now);
    if (cached) return cached;
  }
  if (opts.cacheOnly) return verdict(domain, 'error', 'mx not cached (offline)');

  let out: MailDomainCheck;
  try {
    const mx = await resolver.resolveMx(domain).catch((e: unknown) => {
      if (NO_DATA.has(code(e))) return { notFound: code(e) === 'ENOTFOUND' };
      throw e;
    });
    if (Array.isArray(mx) && mx.length > 0) {
      const nullMx = mx.length === 1 && ['', '.'].includes((mx[0] as { exchange: string }).exchange.trim());
      out = nullMx
        ? verdict(domain, 'null_mx', 'single MX with empty exchange (RFC 7505)')
        : verdict(domain, 'mx', `${mx.length} MX record(s)`);
    } else if (!Array.isArray(mx) && mx.notFound) {
      out = verdict(domain, 'no_records', 'domain does not exist (NXDOMAIN)');
    } else {
      const a = await resolver.resolve4(domain).catch((e: unknown) => {
        if (NO_DATA.has(code(e))) return [] as string[];
        throw e;
      });
      const aaaa = a.length > 0 ? [] : await resolver.resolve6(domain).catch((e: unknown) => {
        if (NO_DATA.has(code(e))) return [] as string[];
        throw e;
      });
      out = a.length + aaaa.length > 0
        ? verdict(domain, 'a_fallback', 'no MX, address record present')
        : verdict(domain, 'no_records', 'no MX and no address records');
    }
  } catch (e) {
    out = verdict(domain, 'error', `mx check error: ${(e as Error).message}`);
  }
  if (db && out.result !== 'error') await writeCache(db, out, now);
  return out;
}
