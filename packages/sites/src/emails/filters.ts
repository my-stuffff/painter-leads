import { FREE_MAIL_DOMAINS, normaliseEmail, registrableDomain } from '@pp/core';

export type EmailMethod = 'mailto' | 'jsonld' | 'cfemail' | 'text' | 'obfuscated' | 'bundle';

export interface FilterCtx {
  /** Registrable domains of the company's own site (empty on a shared host). */
  siteDomains: readonly string[];
  method: EmailMethod;
  /** The address sits in a footer line that credits a web designer / platform. */
  designerCredit?: boolean;
}

export type FilterResult = { accept: true } | { accept: false; reason: string };

export const REJECT = {
  invalid: 'invalid address',
  asset: 'image or asset file name',
  placeholderDomain: 'placeholder domain',
  placeholderLocal: 'placeholder local part',
  privacyProxy: 'privacy proxy',
  designer: 'web designer credit',
  offDomain: 'off-domain, not free-mail',
  bundleOffDomain: 'bundle address not on the site domain',
} as const;

const ASSET_TLDS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'css', 'js']);

const PLACEHOLDER_DOMAINS = [
  'example.com',
  'example.org',
  'example.net',
  'email.com',
  'domain.com',
  'yourdomain.com',
  'yourcompany.com',
  'yoursite.com',
  'ejemplo.com',
  'test.com',
  'sentry.io',
  'sentry-next.wixpress.com',
  'wixpress.com',
  'godaddy.com',
  'godaddysites.com',
];

const PLACEHOLDER_LOCALS = new Set([
  'noreply',
  'no-reply',
  'donotreply',
  'do-not-reply',
  'webmaster',
  'hostmaster',
  'abuse',
  'postmaster',
  'example',
  'test',
  'yourname',
  'name',
  'email',
  'user',
]);

const PRIVACY_PROXIES = [
  'withheldforprivacy.com',
  'contactprivacy.com',
  'domainsbyproxy.com',
  'whoisprivacyprotect.com',
  'privacyprotect.org',
  'anonymised.email',
];

const matchesDomain = (domain: string, list: readonly string[]): boolean =>
  list.some((d) => domain === d || domain.endsWith(`.${d}`));

/** Credit lines like "Website by Acme Web Design" or "Powered by Wix". */
export const DESIGNER_CREDIT = /\b(?:designed|developed|powered|built|created|hosted)\s+by\b|\bweb(?:site)?\s+(?:design\s+)?by\b|\bsite\s+by\b/i;

export function isFreeMail(domain: string): boolean {
  return FREE_MAIL_DOMAINS.includes(domain);
}

/** D-17 / ENR-07: accept an address or say why not. Pure; the MX check is separate. */
export function filterEmail(raw: string, ctx: FilterCtx): FilterResult {
  const address = normaliseEmail(raw);
  const at = address.lastIndexOf('@');
  if (at < 1 || at === address.length - 1 || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(address)) {
    return { accept: false, reason: REJECT.invalid };
  }
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  const tld = domain.slice(domain.lastIndexOf('.') + 1);

  if (ASSET_TLDS.has(tld)) return { accept: false, reason: REJECT.asset };
  if (matchesDomain(domain, PLACEHOLDER_DOMAINS)) return { accept: false, reason: REJECT.placeholderDomain };
  if (PLACEHOLDER_LOCALS.has(local)) return { accept: false, reason: REJECT.placeholderLocal };
  if (matchesDomain(domain, PRIVACY_PROXIES)) return { accept: false, reason: REJECT.privacyProxy };

  const addrDomain = registrableDomain(domain).domain ?? domain;
  const own = ctx.siteDomains.includes(addrDomain);

  if (ctx.method === 'bundle' && !own) return { accept: false, reason: REJECT.bundleOffDomain };
  if (!own && ctx.designerCredit) return { accept: false, reason: REJECT.designer };
  if (!own && !isFreeMail(domain)) return { accept: false, reason: REJECT.offDomain };
  return { accept: true };
}
