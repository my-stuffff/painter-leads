interface Cookie {
  name: string;
  value: string;
  path: string;
}

/**
 * A small per-session cookie jar keyed by name + path (enough for ASP.NET_SessionId and antiforgery
 * cookies). Host-only: a session talks to one source. Values never reach logs.
 */
export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  store(setCookieHeaders: string[], requestUrl: string, now: Date = new Date()): void {
    const defaultPath = new URL(requestUrl).pathname.replace(/\/[^/]*$/, '') || '/';
    for (const header of setCookieHeaders) {
      const [pair, ...attrs] = header.split(';').map((s) => s.trim());
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      let cookiePath = defaultPath;
      let expired = false;
      for (const attr of attrs) {
        const [k, ...v] = attr.split('=');
        const key = (k ?? '').toLowerCase();
        const val = v.join('=');
        if (key === 'path' && val.startsWith('/')) cookiePath = val;
        if (key === 'max-age' && Number(val) <= 0) expired = true;
        if (key === 'expires') {
          const t = Date.parse(val);
          if (!Number.isNaN(t) && t <= now.getTime()) expired = true;
        }
      }
      const mapKey = `${name}|${cookiePath}`;
      if (expired || value === '') this.cookies.delete(mapKey);
      else this.cookies.set(mapKey, { name, value, path: cookiePath });
    }
  }

  header(requestUrl: string): string | null {
    const reqPath = new URL(requestUrl).pathname;
    const parts = [...this.cookies.values()]
      .filter((c) => reqPath.startsWith(c.path))
      .sort((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`);
    return parts.length > 0 ? parts.join('; ') : null;
  }

  asRecord(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of this.cookies.values()) out[c.name] = c.value;
    return out;
  }
}
