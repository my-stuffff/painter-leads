import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const SHA_RE = /^[0-9a-f]{64}$/;

/** Cache key: sha256 of "METHOD url\nrequestBody". Never derived from URL path components. */
export function cacheKey(method: string, url: string, body = ''): string {
  return createHash('sha256').update(`${method.toUpperCase()} ${url}\n${body}`).digest('hex');
}

/** Key for browser-rendered HTML: prefix 'RENDER ' keeps it distinct from the plain fetch of the URL. */
export function renderedCacheKey(url: string, html: string): string {
  return createHash('sha256').update(`RENDER ${url}\n${html}`).digest('hex');
}

export interface CacheMeta {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  fetchedAt: string;
  rendered: boolean;
}

/** Gzip page cache: <dataDir>/pages/<2 hex>/<2 hex>/<sha256>.html.gz plus a small .meta.json. */
export class PageCache {
  constructor(private readonly root: string) {}

  pathFor(sha256: string): string {
    if (!SHA_RE.test(sha256)) throw new Error('invalid cache key');
    return path.join(this.root, 'pages', sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.html.gz`);
  }

  private metaPathFor(sha256: string): string {
    return this.pathFor(sha256).replace(/\.html\.gz$/, '.meta.json');
  }

  async write(sha256: string, body: Buffer, meta: CacheMeta): Promise<string> {
    const file = this.pathFor(sha256);
    await mkdir(path.dirname(file), { recursive: true });
    await this.atomicWrite(file, gzipSync(body));
    await this.atomicWrite(this.metaPathFor(sha256), Buffer.from(JSON.stringify(meta)));
    return file;
  }

  async read(sha256: string): Promise<{ body: Buffer; meta: CacheMeta | null; path: string } | null> {
    if (!SHA_RE.test(sha256)) return null;
    const file = this.pathFor(sha256);
    let gz: Buffer;
    try {
      gz = await readFile(file);
    } catch {
      return null;
    }
    let meta: CacheMeta | null = null;
    try {
      meta = JSON.parse(await readFile(this.metaPathFor(sha256), 'utf8')) as CacheMeta;
    } catch {
      meta = null;
    }
    return { body: gunzipSync(gz), meta, path: file };
  }

  private async atomicWrite(file: string, data: Buffer): Promise<void> {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }
}
