import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import type { Fetcher, PpConfig } from '@pp/core';
import { dataDir } from '@pp/core';
import { AspNetFlowError, eventTargetOf, isAspNetError, postBack } from '../aspnet';
import { checkMasterComplete, checkPersonnelComplete, checkPersonnelParses, type CompleteVerdict } from './completeness';
import { CSLB_PORTAL_URL } from './master';

export type CslbKind = 'master' | 'personnel';

const KIND = {
  master: { code: 'M', linkId: 'MainContent_lbMasterCSV', headerStart: 'LicenseNo', label: 'master' },
  personnel: { code: 'P', linkId: 'MainContent_lbtnPersonnelcsv', headerStart: 'LIC-NO', label: 'personnel' },
} as const;

const SELECT_NAME = 'ctl00$MainContent$ddlStatus';

export interface CslbDownload {
  path: string;
  bytes: number;
  sha256: string;
  /** "Updated as of" date shown on the portal (ISO), when the page showed one. */
  asOf: string | null;
  downloadedAt: string;
  /** Result of the completeness check (a refused file is renamed to *.INCOMPLETE and an error is thrown). */
  verdict: CompleteVerdict;
  /** The headers the server answered with, for diagnosing cut-off downloads. */
  serverHeaders: Record<string, string>;
}

/** The portal's own "Updated as of 10/23/2026" line, as an ISO date. */
export function portalAsOf(html: string): string | null {
  const text = cheerio.load(html)('body').text().replace(/\s+/g, ' ');
  const m = /(?:updated|as of)[^0-9]{0,30}(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(text);
  if (!m) return null;
  return `${m[3]}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
}

/** Finds the CSV download control after the file type was chosen: its id, else any csv link for this kind. */
export function findCsvTarget(html: string, kind: CslbKind): string | null {
  const $ = cheerio.load(html);
  const byId = $(`#${KIND[kind].linkId}`).attr('href');
  const direct = eventTargetOf(byId);
  if (direct) return direct;
  const word = kind === 'master' ? /master/i : /personnel/i;
  let found: string | null = null;
  $('a').each((_, el) => {
    const id = $(el).attr('id') ?? '';
    const href = $(el).attr('href') ?? '';
    if (!found && /csv/i.test(id + href) && word.test(id + href)) found = eventTargetOf(href);
  });
  return found;
}

/**
 * Downloads the CSLB statewide master or personnel CSV (official, free, no login): one cookie session,
 * GET the data portal, postback the file type, then postback the CSV link (Pitfall 9). The file goes
 * to <dataDir>/downloads/cslb/<kind>-<yyyy-mm-dd>.csv (outside the repo) with a small .json sidecar.
 */
export async function downloadCslbFile(
  fetcher: Fetcher,
  config: PpConfig,
  kind: CslbKind,
  opts: { now?: Date; destDir?: string; saveFlowHtmlTo?: string; masterMax?: number } = {},
): Promise<CslbDownload> {
  const spec = KIND[kind];
  const now = opts.now ?? new Date();
  const session = fetcher.session(`cslb-${kind}`, 'cslb');
  const generous = { timeoutMs: 600_000, maxBytes: config.fetch.maxDownloadBytes };

  const landing = await session.get(CSLB_PORTAL_URL);
  const landingHtml = landing.text();
  if (landing.status !== 200 || isAspNetError(landingHtml)) {
    throw new AspNetFlowError(`data portal answered HTTP ${landing.status}`, 'cslb landing');
  }

  const chosen = await postBack(session, landing.finalUrl, landingHtml, { [SELECT_NAME]: spec.code }, { eventTarget: SELECT_NAME });
  const chosenHtml = chosen.text();
  if (chosen.status !== 200 || isAspNetError(chosenHtml)) {
    throw new AspNetFlowError(`file-type postback answered HTTP ${chosen.status}`, 'cslb choose file type');
  }
  if (opts.saveFlowHtmlTo) await writeFile(opts.saveFlowHtmlTo, chosenHtml, 'utf8');

  const target = findCsvTarget(chosenHtml, kind);
  if (!target) throw new AspNetFlowError(`no CSV download link for "${spec.label}" on the portal page`, 'cslb find link');

  const file = await postBack(
    session,
    chosen.finalUrl,
    chosenHtml,
    { [SELECT_NAME]: spec.code },
    { eventTarget: target },
    generous,
  );
  if (file.status !== 200) throw new AspNetFlowError(`download answered HTTP ${file.status}`, 'cslb download');
  const head = file.body.subarray(0, 64).toString('utf8').replace(/^﻿/, '');
  if (!head.startsWith(spec.headerStart)) {
    throw new AspNetFlowError(`the downloaded file does not start with the ${spec.label} header`, 'cslb download');
  }

  const dir = opts.destDir ?? path.join(dataDir(config), 'downloads', 'cslb');
  await mkdir(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  const dest = path.join(dir, `${kind}-${day}.csv`);
  await writeFile(dest, file.body);
  const sha256 = createHash('sha256').update(file.body).digest('hex');

  // The portal stops sending after a time limit with no network error, so a slow link gets a file cut off
  // mid-row (D-20). Check every row before anyone loads it.
  const verdict =
    kind === 'master'
      ? await checkMasterComplete(dest)
      : opts.masterMax
        ? await checkPersonnelComplete(dest, opts.masterMax)
        : await checkPersonnelParses(dest);
  const keep = ['content-length', 'content-type', 'content-encoding', 'transfer-encoding', 'content-disposition', 'connection'];
  const serverHeaders = Object.fromEntries(keep.filter((k) => file.headers[k] !== undefined).map((k) => [k, file.headers[k] as string]));
  const result: CslbDownload = {
    path: dest,
    bytes: file.body.length,
    sha256,
    asOf: portalAsOf(chosenHtml),
    downloadedAt: now.toISOString(),
    verdict,
    serverHeaders,
  };
  if (!verdict.ok) {
    const refused = `${dest}.INCOMPLETE`;
    await rename(dest, refused);
    await writeFile(`${refused}.json`, JSON.stringify({ kind, url: CSLB_PORTAL_URL, ...result, path: refused }, null, 2), 'utf8');
    throw new IncompleteDownloadError(kind, result, refused);
  }
  await writeFile(`${dest}.json`, JSON.stringify({ kind, url: CSLB_PORTAL_URL, ...result }, null, 2), 'utf8');
  return result;
}

export class IncompleteDownloadError extends Error {
  constructor(
    readonly kind: CslbKind,
    readonly download: CslbDownload,
    readonly refusedPath: string,
  ) {
    super(
      `CSLB ${kind} download refused: ${download.verdict.reason ?? 'incomplete'} (${download.bytes} bytes kept as ${refusedPath}). ` +
        'The portal cuts long downloads off; run it from a fast connection (Railway) and try again.',
    );
    this.name = 'IncompleteDownloadError';
  }
}
