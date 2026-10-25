import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { dataDir, type Fetcher, type FetchResult, type FetchSession, type PpConfig } from '@pp/core';
import { AspNetFlowError, formAction, isAspNetError, pageText, postBack, type PostBackSubmit } from '../aspnet';
import { NJ_ROSTER_URL } from './roster-parse';

const PROFESSION = 'Home Improvement Contractors';

export class NjChargeError extends Error {
  constructor(readonly shown: string) {
    super(`the NJ roster confirmation page shows a charge (${shown}), not $0.00: stopped before continuing`);
    this.name = 'NjChargeError';
  }
}

/** Free-text charge on the confirmation page: "$0.00 ." Returns the amount string, or null when none is shown. */
export function chargeShown(html: string): string | null {
  const m = /charged\.?\s*\$\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i.exec(pageText(html));
  return m ? (m[1] as string) : null;
}

export function isZeroCharge(amount: string | null): boolean {
  return amount !== null && Number(amount.replace(/,/g, '')) === 0;
}

export interface NjRosterDownload {
  /** null when the town has no registrations (nothing to download). */
  path: string | null;
  bytes: number;
  town: string;
  rows: number;
}

/**
 * True when the results grid lists at least one licensee. A town without registrations still gets a results page
 * with the "Download List" button and an empty grid, and pressing the button there makes the site answer HTTP 500
 * (live, Woodbridge Township). A page without the grid at all is not judged here.
 */
export function listsLicensees(html: string): boolean {
  const $ = cheerio.load(html);
  const grid = $('#datagrid_results');
  if (grid.length === 0) return true;
  // A licensee row has one cell per column; the pager row is a single wide cell and the header row has only <th>.
  return grid.find('tr').filter((_, tr) => $(tr).children('td').length >= 2).length > 0;
}

function expect200(res: FetchResult, step: string): string {
  const html = res.text();
  if (res.status !== 200 || isAspNetError(html)) {
    throw new AspNetFlowError(`HTTP ${res.status}${isAspNetError(html) ? ' with an ASP.NET error page' : ''}`, step);
  }
  return html;
}

function marker(html: string, selector: string, step: string, what: string): void {
  if (cheerio.load(html)(selector).length === 0) throw new AspNetFlowError(`expected page marker missing (${what})`, step);
}

async function step(
  session: FetchSession,
  from: { html: string; url: string },
  fields: Record<string, string>,
  submit: PostBackSubmit,
  name: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ html: string; url: string; res: FetchResult }> {
  // The site answers a search slowly now and then (a 20 s limit timed out in the live run): give each step 2 minutes.
  const res = await postBack(session, formAction(from.html, from.url), from.html, fields, submit, { timeoutMs: 120_000, ...opts });
  return { html: expect200(res, name), url: res.finalUrl, res };
}

/**
 * The 5-step free NJ Home Improvement Contractor roster download for one town (D-21): search form, search,
 * "Download List", confirmation (aborts unless it shows $0.00), preferences, "Download" with the pipe-delimited
 * file type. One cookie session; every step re-sends all hidden fields of the latest page and checks an
 * expected page marker. The file is written to <dataDir>/downloads/nj/<town>-<yyyy-mm-dd>.txt (outside the repo).
 */
export async function downloadNjRoster(
  fetcher: Fetcher,
  config: PpConfig,
  town: string,
  opts: { now?: Date; destDir?: string } = {},
): Promise<NjRosterDownload> {
  const now = opts.now ?? new Date();
  const session = fetcher.session(`nj-roster-${town}`, 'nj_hic_roster');
  const big = { maxBytes: config.fetch.maxDownloadBytes, timeoutMs: 300_000 };

  // 1. search form
  const form = await session.get(NJ_ROSTER_URL, { timeoutMs: 120_000 });
  const formHtml = expect200(form, 'roster search form');
  marker(formHtml, '#t_web_lookup__profession_name', 'roster search form', 'profession selector');

  // 2. search the town
  const results = await step(
    session,
    { html: formHtml, url: form.finalUrl },
    {
      t_web_lookup__profession_name: PROFESSION,
      t_web_lookup__license_type_name: '',
      t_web_lookup__full_name: '',
      t_web_lookup__license_no: '',
      t_web_lookup__addr_city: town,
    },
    { button: { name: 'sch_button', value: 'Search' } },
    'roster search',
  );
  if (cheerio.load(results.html)('#btnBulkDownLoad').length === 0) {
    if (/no\s+(records|results|licen[cs]ees)|did not return|0 records/i.test(pageText(results.html))) {
      return { path: null, bytes: 0, town, rows: 0 };
    }
    throw new AspNetFlowError('no "Download List" button on the results page', 'roster search');
  }
  if (!listsLicensees(results.html)) return { path: null, bytes: 0, town, rows: 0 };

  // 3. "Download List" -> confirmation page; it must say $0.00
  const confirm = await step(session, results, {}, { button: { name: 'btnBulkDownLoad', value: 'Download List' } }, 'roster download list');
  marker(confirm.html, '#btnContinue', 'roster confirmation', 'Continue button');
  const amount = chargeShown(confirm.html);
  if (!isZeroCharge(amount)) throw new NjChargeError(amount === null ? 'no amount shown' : `$${amount}`);

  // 4. Continue -> preferences
  const pref = await step(session, confirm, {}, { button: { name: 'btnContinue', value: 'Continue' } }, 'roster confirmation');
  marker(pref.html, '#sch_button', 'roster preferences', 'Download button');

  // 5. Download the pipe-delimited text file
  const file = await postBack(
    session,
    formAction(pref.html, pref.url),
    pref.html,
    { filetype: 'delimitedtext' },
    { button: { name: 'sch_button', value: 'Download' } },
    big,
  );
  if (file.status !== 200) throw new AspNetFlowError(`HTTP ${file.status}`, 'roster file');
  const text = file.body.toString('utf8').replace(/^﻿/, '');
  if (!text.startsWith('full_name|')) throw new AspNetFlowError('the download is not the roster text file', 'roster file');

  const dir = opts.destDir ?? path.join(dataDir(config), 'downloads', 'nj');
  await mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${townSlug(town)}-${now.toISOString().slice(0, 10)}.txt`);
  await writeFile(dest, file.body);
  const rows = Math.max(0, text.split(/\r?\n/).filter((l) => l.trim().length > 0).length - 1);
  return { path: dest, bytes: file.body.length, town, rows };
}

export function townSlug(town: string): string {
  return town
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
