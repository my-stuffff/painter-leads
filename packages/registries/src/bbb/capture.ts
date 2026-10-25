import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Fetcher, RegistryMatchInput, StageContext } from '@pp/core';
import { BbbBlockedError, BbbBreaker, bbbGet } from './breaker';
import { matchProfiles, type BbbPage } from './match';
import { parseBbbProfile, type BbbProfile } from './profile';
import { discoverBbbProfileUrls } from './sitemaps';

export interface CaptureEntry {
  url: string;
  /** sha256 of the page body; the file is <sha256>.html.gz. Absent when nothing was captured. */
  sha256: string | null;
  status: number | 'blocked' | 'error';
  bytes: number;
  capturedAt: string;
}

export interface CaptureManifest {
  capturedAt: string;
  /** Where the capture ran (so a Railway capture is recognisable); free text from the operator. */
  note: string | null;
  entries: CaptureEntry[];
}

export interface CaptureResult {
  manifest: CaptureManifest;
  /** true when the breaker tripped: the capture stopped on a block. */
  blocked: boolean;
}

/**
 * Captures BBB profile pages for later offline import (D-37): run it where bbb.org loads (the owner's Railway test
 * service), bring the folder back. Given URLs, or the painting-contractor profiles of some cities found through the
 * sitemaps. Pages are saved as <sha256>.html.gz with a manifest.json. Stops at the first Cloudflare block.
 */
export async function captureBbb(
  fetcher: Fetcher,
  source: { urls: string[] } | { state: string; cities: string[] },
  outDir: string,
  opts: { now?: () => Date; note?: string | null; maxProfiles?: number } = {},
): Promise<CaptureResult> {
  const now = opts.now ?? (() => new Date());
  const breaker = new BbbBreaker();
  await mkdir(outDir, { recursive: true });
  const entries: CaptureEntry[] = [];
  let urls: string[] = [];
  let blocked = false;

  try {
    if ('urls' in source) {
      urls = source.urls;
    } else {
      for (const city of source.cities) {
        urls.push(...(await discoverBbbProfileUrls(fetcher, breaker, { state: source.state, city })));
      }
      urls = [...new Set(urls)];
    }
    for (const url of urls.slice(0, opts.maxProfiles ?? urls.length)) {
      try {
        const res = await bbbGet(fetcher, breaker, url, { cache: 'refresh' });
        if (res.status !== 200) {
          entries.push({ url, sha256: null, status: res.status, bytes: 0, capturedAt: now().toISOString() });
          continue;
        }
        const sha = createHash('sha256').update(res.body).digest('hex');
        await writeFile(path.join(outDir, `${sha}.html.gz`), gzipSync(res.body));
        entries.push({ url, sha256: sha, status: 200, bytes: res.body.length, capturedAt: now().toISOString() });
      } catch (e) {
        if (e instanceof BbbBlockedError) throw e;
        entries.push({ url, sha256: null, status: 'error', bytes: 0, capturedAt: now().toISOString() });
      }
    }
  } catch (e) {
    if (!(e instanceof BbbBlockedError)) throw e;
    blocked = true;
    entries.push({ url: 'bbb.org', sha256: null, status: 'blocked', bytes: 0, capturedAt: now().toISOString() });
  }

  const manifest: CaptureManifest = { capturedAt: now().toISOString(), note: opts.note ?? null, entries };
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { manifest, blocked };
}

export async function readManifest(dir: string): Promise<CaptureManifest> {
  return JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as CaptureManifest;
}

/** Offline: every captured profile of a folder, parsed (nothing is fetched). */
export async function parseBbbDir(dir: string): Promise<{ page: BbbPage; sha256: string }[]> {
  const manifest = await readManifest(dir);
  const out: { page: BbbPage; sha256: string }[] = [];
  for (const e of manifest.entries) {
    if (e.status !== 200 || !e.sha256) continue;
    const html = gunzipSync(await readFile(path.join(dir, `${e.sha256}.html.gz`))).toString('utf8');
    const profile: BbbProfile = parseBbbProfile(html, e.url);
    out.push({ page: { profile, capturedAt: new Date(e.capturedAt), sourceUrl: e.url, pageSha256: e.sha256 }, sha256: e.sha256 });
  }
  return out;
}

/**
 * Offline: runs the BBB match for the given companies against a captured folder, writing owner evidence with the
 * profile URL and the capture date from the manifest. Works from this laptop with files brought back from Railway.
 */
export async function importBbb(
  ctx: StageContext,
  dir: string,
  inputs: RegistryMatchInput[],
): Promise<{ profiles: number; companies: number; matched: number; owners: number }> {
  const pages = (await parseBbbDir(dir)).map((p) => p.page);
  let matched = 0;
  let owners = 0;
  for (const input of inputs) {
    const own = pages.filter((p) => !p.profile.region || p.profile.region.toUpperCase() === input.company.state);
    const r = await matchProfiles(ctx, input, own);
    if (r.status === 'matched') matched++;
    owners += r.owners;
  }
  return { profiles: pages.length, companies: inputs.length, matched, owners };
}
