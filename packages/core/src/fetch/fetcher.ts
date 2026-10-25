import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { request, type Dispatcher } from 'undici';
import { desktopUserAgent } from '../browser/ua';
import type { PpConfig } from '../config/schema';
import type { Db } from '../db/client';
import { pages, requestLog } from '../db/schema';
import { createLogger } from '../log';
import { dataDir as defaultDataDir } from '../paths';
import type { RequestOutcome, SourceId } from '../types';
import { cacheKey, PageCache, renderedCacheKey, type CacheMeta } from './cache';
import { addressResolverFor } from './dns';
import { getDispatcher } from './dispatcher';
import {
  BodyTooLargeError,
  OfflineCacheMissError,
  RobotsDisallowedError,
  SourceDisabledError,
  SsrfRefusedError,
} from './errors';
import { HostRateLimiter } from './ratelimit';
import { RobotsCache } from './robots';
import { CookieJar } from './session';
import { isPublicAddress } from './ssrf';
import type { FetchOptions, FetchResult, FetchSession, Fetcher } from './types';

export interface FetcherDeps {
  config: PpConfig;
  db?: Db | null;
  dispatcher?: Dispatcher;
  dataDir?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Host → addresses used by the SSRF pre-check. Defaults to the per-host DNS override or system DNS. */
  resolveHost?: (host: string) => Promise<string[]>;
}

type Method = 'GET' | 'POST';

interface Req {
  method: Method;
  url: string;
  form?: URLSearchParams;
  opts: FetchOptions;
  jar?: CookieJar;
  skipRobots?: boolean;
  identity?: boolean;
  note?: string;
  /** true for big file downloads: no overall timeout, only per-chunk idle timeouts. */
  streaming?: boolean;
}

interface FinalResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Buffer> & { destroy(error?: Error): unknown };
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

function headerRecord(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = k.toLowerCase();
    if (key === 'set-cookie' || v === undefined) continue;
    out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function setCookies(raw: Record<string, string | string[] | undefined>): string[] {
  const v = raw['set-cookie'];
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function decodeText(body: Buffer, contentType: string | undefined): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType ?? '');
  try {
    return new TextDecoder(m?.[1] ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

function decompress(body: Buffer, encoding: string | undefined, max: number): Buffer {
  const enc = (encoding ?? '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(body, { maxOutputLength: max });
    if (enc === 'deflate') return inflateSync(body, { maxOutputLength: max });
    if (enc === 'br') return brotliDecompressSync(body, { maxOutputLength: max });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new BodyTooLargeError();
    throw e;
  }
  return body;
}

async function readLimited(body: AsyncIterable<Buffer>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > max) throw new BodyTooLargeError(`response body exceeds ${max} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function classify(e: unknown): RequestOutcome {
  const err = e as { name?: string; code?: string; cause?: { code?: string } } | undefined;
  if (e instanceof SsrfRefusedError || (err?.cause as unknown) instanceof SsrfRefusedError) return 'ssrf_refused';
  if (e instanceof BodyTooLargeError) return 'too_large';
  const code = err?.code ?? err?.cause?.code;
  if (
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    err?.name === 'TimeoutError' ||
    err?.name === 'AbortError'
  ) {
    return 'timeout';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_error';
  return 'http_error';
}

export function createFetcher(deps: FetcherDeps): Fetcher {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const root = deps.dataDir ?? defaultDataDir(config);
  const cache = new PageCache(root);
  const limiter = new HostRateLimiter(now, sleep);
  const log = createLogger('fetch');

  const resolveHost =
    deps.resolveHost ?? (async (host: string) => (await addressResolverFor(host, config)(host)).map((a) => a.address));

  async function assertPublicUrl(url: string): Promise<void> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new SsrfRefusedError(`invalid URL: ${url}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new SsrfRefusedError(`scheme ${u.protocol} is not allowed`);
    }
    const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
    if (isIP(host)) {
      if (!isPublicAddress(host)) throw new SsrfRefusedError(`${host} is not a public address`);
      return;
    }
    const addrs = await resolveHost(host);
    if (addrs.length === 0) throw new SsrfRefusedError(`${host} did not resolve`);
    const bad = addrs.find((a) => !isPublicAddress(a));
    if (bad) throw new SsrfRefusedError(`${host} resolves to non-public address ${bad}`);
  }

  async function logRequest(r: {
    source: SourceId;
    url: string;
    method: string;
    status?: number | null;
    bytes?: number | null;
    ms?: number | null;
    outcome: RequestOutcome;
    runId?: number | null;
    note?: string | null;
  }): Promise<void> {
    if (!deps.db) return;
    let host = '';
    try {
      host = new URL(r.url).host;
    } catch {
      host = '(invalid)';
    }
    try {
      // Never bodies, cookies or form values (Security V7).
      await deps.db.insert(requestLog).values({
        source: r.source,
        host,
        method: r.method,
        url: r.url,
        status: r.status ?? null,
        bytes: r.bytes ?? null,
        ms: r.ms ?? null,
        outcome: r.outcome,
        runId: r.runId ?? null,
        note: r.note ?? null,
      });
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'request_log insert failed');
    }
  }

  /**
   * The one network path: source switch, scheme + SSRF check per hop, robots, rate limit, manual
   * redirects (re-validated and logged per hop), timeouts. `consume` reads the final body.
   */
  async function perform<T>(
    req: Req,
    consume: (r: FinalResponse) => Promise<{ value: T; bytes: number }>,
  ): Promise<{ value: T; finalUrl: string; status: number; headers: Record<string, string> }> {
    const { source } = req.opts;
    const src = config.sources[source];
    if (!src.enabled) throw new SourceDisabledError(`source "${source}" is switched off in pp.config.json`);
    const timeoutMs = req.opts.timeoutMs ?? config.fetch.timeoutMs;
    const runId = req.opts.runId ?? null;

    let method: Method = req.method;
    let form = req.form;
    let url = req.url;

    for (let hop = 0; ; hop++) {
      const base = { source, url, method, runId, note: req.note ?? null };
      try {
        await assertPublicUrl(url);
      } catch (e) {
        await logRequest({ ...base, outcome: classify(e) === 'dns_error' ? 'dns_error' : 'ssrf_refused', note: (e as Error).message });
        throw e;
      }

      if (!req.skipRobots && src.robots === 'respect' && !(await robots.allowed(url))) {
        await logRequest({ ...base, outcome: 'robots_disallowed' });
        throw new RobotsDisallowedError(`robots.txt disallows ${url}`);
      }

      await limiter.wait(new URL(url).host, src.minIntervalMs);

      const headers: Record<string, string> = {
        'user-agent': desktopUserAgent(),
        'accept-language': 'en-US,en;q=0.9',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-encoding': req.identity ? 'identity' : 'gzip, deflate, br',
        ...Object.fromEntries(Object.entries(req.opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      };
      const cookie = req.jar?.header(url);
      if (cookie) headers.cookie = cookie;
      if (form) headers['content-type'] = 'application/x-www-form-urlencoded';

      const started = performance.now();
      let res: Dispatcher.ResponseData;
      try {
        const host = new URL(url).hostname;
        res = await request(url, {
          method,
          headers,
          body: form ? form.toString() : undefined,
          dispatcher: getDispatcher(host, config, { injected: deps.dispatcher }),
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          signal: req.streaming ? undefined : AbortSignal.timeout(timeoutMs * 3),
        });
      } catch (e) {
        await logRequest({ ...base, ms: Math.round(performance.now() - started), outcome: classify(e), note: (e as Error).message });
        const cause = (e as { cause?: unknown }).cause;
        if (cause instanceof SsrfRefusedError) throw cause;
        throw e;
      }

      req.jar?.store(setCookies(res.headers), url, now());
      const respHeaders = headerRecord(res.headers);

      if (REDIRECT.has(res.statusCode) && respHeaders.location) {
        await res.body.dump().catch(() => undefined);
        await logRequest({ ...base, status: res.statusCode, ms: Math.round(performance.now() - started), outcome: 'ok', note: 'redirect' });
        if (hop >= config.fetch.maxRedirects) {
          await logRequest({ ...base, status: res.statusCode, outcome: 'http_error', note: 'too many redirects' });
          throw new Error(`too many redirects (more than ${config.fetch.maxRedirects}) starting at ${req.url}`);
        }
        const next = new URL(respHeaders.location, url).toString();
        if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) {
          method = 'GET';
          form = undefined;
        }
        url = next;
        continue;
      }

      try {
        const { value, bytes } = await consume({
          url,
          status: res.statusCode,
          headers: respHeaders,
          body: res.body as unknown as FinalResponse['body'],
        });
        await logRequest({
          ...base,
          status: res.statusCode,
          bytes,
          ms: Math.round(performance.now() - started),
          outcome: res.statusCode >= 400 ? 'http_error' : 'ok',
        });
        return { value, finalUrl: url, status: res.statusCode, headers: respHeaders };
      } catch (e) {
        await logRequest({ ...base, status: res.statusCode, ms: Math.round(performance.now() - started), outcome: classify(e), note: (e as Error).message });
        throw e;
      }
    }
  }

  const robots = new RobotsCache(
    async (origin) => {
      // Reuse the one network path; failures mean "unreachable" (disallow all, RFC 9309).
      try {
        const sourceForRobots: SourceId = 'websites';
        const r = await perform(
          { method: 'GET', url: `${origin}/robots.txt`, opts: { source: robotsSource.get(origin) ?? sourceForRobots, cache: 'none' }, skipRobots: true, note: 'robots.txt' },
          async (resp) => {
            const buf = await readLimited(resp.body, 500_000);
            const text = decodeText(decompress(buf, resp.headers['content-encoding'], 500_000), resp.headers['content-type']);
            return { value: text, bytes: buf.length };
          },
        );
        return { status: r.status, text: r.value };
      } catch {
        return null;
      }
    },
    config.fetch.robotsCacheHours,
    now,
  );
  // Which source's rate limit applies to the robots.txt fetch of an origin (set by the first caller).
  const robotsSource = new Map<string, SourceId>();

  function makeResult(p: {
    requestedUrl: string;
    finalUrl: string;
    status: number;
    headers: Record<string, string>;
    body: Buffer;
    sha256: string;
    cachePath: string | null;
    fromCache: boolean;
    fetchedAt: Date;
  }): FetchResult {
    return { ...p, text: () => decodeText(p.body, p.headers['content-type']) };
  }

  async function savePage(
    sha: string,
    body: Buffer,
    meta: CacheMeta,
    source: SourceId,
    method: string,
  ): Promise<string> {
    const cachePath = await cache.write(sha, body, meta);
    if (deps.db) {
      const values = {
        url: meta.requestedUrl,
        finalUrl: meta.finalUrl,
        host: new URL(meta.finalUrl).host,
        method,
        sha256: sha,
        statusCode: meta.status,
        contentType: meta.contentType,
        bytes: body.length,
        rendered: meta.rendered,
        source,
        cachePath,
        fetchedAt: new Date(meta.fetchedAt),
      };
      await deps.db
        .insert(pages)
        .values(values)
        .onConflictDoUpdate({ target: pages.sha256, set: values });
    }
    return cachePath;
  }

  async function execute(req: Req): Promise<FetchResult> {
    const { opts } = req;
    const mode = opts.cache ?? (req.method === 'GET' ? 'use' : 'none');
    const key = cacheKey(req.method, req.url, req.form?.toString());
    robotsSource.set(new URL(req.url).origin, opts.source);

    if (mode === 'use' || opts.offline) {
      const hit = await cache.read(key);
      if (hit) {
        await logRequest({ source: opts.source, url: req.url, method: req.method, status: hit.meta?.status ?? 200, bytes: hit.body.length, ms: 0, outcome: 'cache_hit', runId: opts.runId, note: req.note });
        return makeResult({
          requestedUrl: req.url,
          finalUrl: hit.meta?.finalUrl ?? req.url,
          status: hit.meta?.status ?? 200,
          headers: hit.meta?.contentType ? { 'content-type': hit.meta.contentType } : {},
          body: hit.body,
          sha256: key,
          cachePath: hit.path,
          fromCache: true,
          fetchedAt: hit.meta ? new Date(hit.meta.fetchedAt) : now(),
        });
      }
    }
    if (opts.offline) {
      await logRequest({ source: opts.source, url: req.url, method: req.method, outcome: 'offline_miss', runId: opts.runId, note: req.note });
      throw new OfflineCacheMissError(`offline mode: ${req.method} ${req.url} is not in the cache`);
    }

    const maxBytes = opts.maxBytes ?? config.fetch.maxBodyBytes;
    const result = await perform(req, async (resp) => {
      const declared = Number(resp.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes && !resp.headers['content-encoding']) {
        resp.body.destroy();
        throw new BodyTooLargeError(`content-length ${declared} exceeds ${maxBytes} bytes`);
      }
      const raw = await readLimited(resp.body, maxBytes);
      const body = decompress(raw, resp.headers['content-encoding'], maxBytes);
      return { value: body, bytes: body.length };
    });

    const fetchedAt = now();
    let cachePath: string | null = null;
    if (mode !== 'none' && result.status >= 200 && result.status < 300) {
      cachePath = await savePage(
        key,
        result.value,
        {
          requestedUrl: req.url,
          finalUrl: result.finalUrl,
          status: result.status,
          contentType: result.headers['content-type'] ?? null,
          fetchedAt: fetchedAt.toISOString(),
          rendered: false,
        },
        opts.source,
        req.method,
      );
    }
    return makeResult({
      requestedUrl: req.url,
      finalUrl: result.finalUrl,
      status: result.status,
      headers: result.headers,
      body: result.value,
      sha256: key,
      cachePath,
      fromCache: false,
      fetchedAt,
    });
  }

  function toForm(form: Record<string, string> | URLSearchParams): URLSearchParams {
    return form instanceof URLSearchParams ? form : new URLSearchParams(form);
  }

  async function sha256OfFile(file: string): Promise<{ sha256: string; bytes: number }> {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(file)) {
      hash.update(chunk as Buffer);
      bytes += (chunk as Buffer).length;
    }
    return { sha256: hash.digest('hex'), bytes };
  }

  return {
    get: (url, o) => execute({ method: 'GET', url, opts: o }),
    post: (url, form, o) => execute({ method: 'POST', url, form: toForm(form), opts: o }),

    session(label: string, source: SourceId): FetchSession {
      const jar = new CookieJar();
      const merge = (o?: Partial<FetchOptions>): FetchOptions => ({ cache: 'none', ...o, source });
      return {
        get: (url, o) => execute({ method: 'GET', url, opts: merge(o), jar, note: label }),
        post: (url, form, o) => execute({ method: 'POST', url, form: toForm(form), opts: merge(o), jar, note: label }),
        cookies: () => jar.asRecord(),
      };
    },

    async download(url, destPath, o) {
      const max = o.maxBytes ?? config.fetch.maxDownloadBytes;
      if (o.offline) {
        try {
          await stat(destPath);
        } catch {
          await logRequest({ source: o.source, url, method: o.method ?? 'GET', outcome: 'offline_miss', runId: o.runId, note: 'download' });
          throw new OfflineCacheMissError(`offline mode: ${destPath} does not exist`);
        }
        const info = await sha256OfFile(destPath);
        return { path: destPath, ...info };
      }
      await mkdir(path.dirname(destPath), { recursive: true });
      const tmp = `${destPath}.part`;
      try {
        const r = await perform(
          {
            method: o.method ?? 'GET',
            url,
            form: o.form ? new URLSearchParams(o.form) : undefined,
            opts: o,
            identity: true,
            streaming: true,
            note: 'download',
          },
          async (resp) => {
            if (resp.status >= 400) {
              resp.body.destroy();
              throw new Error(`download failed: HTTP ${resp.status} for ${url}`);
            }
            const hash = createHash('sha256');
            let bytes = 0;
            const out = createWriteStream(tmp);
            try {
              for await (const chunk of resp.body) {
                bytes += chunk.length;
                if (bytes > max) throw new BodyTooLargeError(`download exceeds ${max} bytes`);
                hash.update(chunk);
                if (!out.write(chunk)) await new Promise<void>((res) => out.once('drain', () => res()));
              }
              await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
            } catch (e) {
              out.destroy();
              throw e;
            }
            return { value: { sha256: hash.digest('hex'), bytes }, bytes };
          },
        );
        await rename(tmp, destPath);
        return { path: destPath, bytes: r.value.bytes, sha256: r.value.sha256 };
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    },

    async robotsAllowed(url, source) {
      if (config.sources[source].robots === 'override') return true;
      robotsSource.set(new URL(url).origin, source);
      return robots.allowed(url);
    },

    async readCached(sha256) {
      const hit = await cache.read(sha256);
      return hit ? hit.body : null;
    },

    async storeRendered(url, html, o) {
      const sha = renderedCacheKey(url, html);
      const fetchedAt = now();
      const cachePath = await savePage(
        sha,
        Buffer.from(html, 'utf8'),
        { requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', fetchedAt: fetchedAt.toISOString(), rendered: true },
        o.source,
        'GET',
      );
      return { sha256: sha, cachePath };
    },

    assertPublicUrl,
  };
}
