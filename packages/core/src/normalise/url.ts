/** Host (no `www.`, lowercase) plus path without a trailing slash; query and fragment dropped. */
export function normaliseUrlForCompare(u: string): string {
  const trimmed = u.trim();
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
  } catch {
    return trimmed.toLowerCase();
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${host}${pathname}`;
}
