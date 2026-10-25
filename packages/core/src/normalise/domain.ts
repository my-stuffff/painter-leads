import { getDomain } from 'tldts';

/**
 * Hosts shared by many unrelated businesses. A company on one of these has no company domain:
 * no domain-based merge, and emails on it are not "company-domain" emails (Pitfall 6).
 */
export const SHARED_HOST_DOMAINS: readonly string[] = [
  'google.com',
  'facebook.com',
  'instagram.com',
  'linktr.ee',
  'business.site',
  'godaddysites.com',
  'weebly.com',
  'wixsite.com',
  'square.site',
  'yelp.com',
  'nextdoor.com',
  'homeadvisor.com',
  'angi.com',
  'thumbtack.com',
  'houzz.com',
  'bbb.org',
];

export const FREE_MAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'yahoo.com',
  'aol.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'optonline.net',
  'protonmail.com',
  'proton.me',
  'ymail.com',
  'rocketmail.com',
  'cox.net',
  'charter.net',
  'earthlink.net',
];

function isShared(domain: string | null): boolean {
  if (!domain) return false;
  return SHARED_HOST_DOMAINS.some((s) => domain === s || domain.endsWith(`.${s}`));
}

/**
 * Registrable domain of a URL or bare host. `allowPrivateDomains` keeps `jdoe.wixsite.com` and
 * `acme.business.site` distinct; `sharedHost` flags hosts that many businesses share.
 */
export function registrableDomain(urlOrHost: string): { host: string; domain: string | null; sharedHost: boolean } {
  const trimmed = urlOrHost.trim();
  let host = '';
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`).hostname.toLowerCase();
  } catch {
    return { host: '', domain: null, sharedHost: false };
  }
  const withPrivate = getDomain(host, { allowPrivateDomains: true });
  const publicOnly = getDomain(host, { allowPrivateDomains: false });
  return {
    host,
    domain: withPrivate,
    sharedHost: isShared(withPrivate) || isShared(publicOnly),
  };
}
