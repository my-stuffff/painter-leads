import * as cheerio from 'cheerio';
import type { Fetcher, FetchResult } from '@pp/core';
import { AspNetFlowError, formAction, isAspNetError, postBack } from '../aspnet';

export const NJ_VERIFICATION_URL = 'https://newjersey.mylicense.com/verification/Search.aspx?facility=Y';

export interface NjDetail {
  licenceNo: string;
  fullName: string | null;
  doingBusinessAs: string | null;
  /** "Owner Name:" on the registration; null when the page shows none. */
  ownerName: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  status: string | null;
  issueDate: string | null;
  expirationDate: string | null;
  /** The Details.aspx page the values were read from (needs the session that made it). */
  detailUrl: string;
  detailSha256: string;
}

const text = ($: cheerio.CheerioAPI, id: string): string | null => {
  const t = $(`#${id}`).first().text().replace(/\s+/g, ' ').trim();
  return t.length > 0 ? t : null;
};

/** Reads the span ids of a HIC registration detail page (SOURCES-PROBE §1a). */
export function parseNjDetail(html: string): Omit<NjDetail, 'licenceNo' | 'detailUrl' | 'detailSha256'> {
  const $ = cheerio.load(html);
  return {
    fullName: text($, 'full_name'),
    doingBusinessAs: text($, 'doing_business_as'),
    ownerName: text($, 'owner_name'),
    address: text($, 'addr_line_1'),
    city: text($, 'addr_city'),
    zip: text($, 'addr_zipcode'),
    status: text($, 'sec_lic_status'),
    issueDate: text($, 'issue'),
    expirationDate: text($, 'expiration_date'),
  };
}

/** The results grid: licence number and Details link of each row. */
export function parseNjResults(html: string, baseUrl: string): { licenceNo: string; href: string; name: string; status: string | null }[] {
  const $ = cheerio.load(html);
  const out: { licenceNo: string; href: string; name: string; status: string | null }[] = [];
  $('#datagrid_results a[href*="Details.aspx"]').each((_, a) => {
    const row = $(a).closest('table').closest('tr');
    const cells = row.children('td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
    const licenceNo = cells.find((c) => /^\d{2}VH\d+$/i.test(c)) ?? '';
    out.push({
      licenceNo,
      href: new URL($(a).attr('href') ?? '', baseUrl).toString(),
      name: $(a).text().replace(/\s+/g, ' ').trim(),
      status: cells[4] ?? null,
    });
  });
  return out;
}

function ok(res: FetchResult, step: string): string {
  const html = res.text();
  if (res.status !== 200 || isAspNetError(html)) {
    throw new AspNetFlowError(`HTTP ${res.status}${isAspNetError(html) ? ' (ASP.NET error page)' : ''}`, step);
  }
  return html;
}

/**
 * The registered owner of one HIC registration (D-21): ONE cookie session for the verification search and the
 * Details page (a Details URL fetched without the session answers HTTP 500). 3 requests per company; only
 * called for companies already matched in the roster. Any failure throws: it is never reported as "no owner".
 */
export async function fetchNjOwner(fetcher: Fetcher, licenceNo: string): Promise<NjDetail> {
  const session = fetcher.session(`nj-detail-${licenceNo}`, 'nj_hic_detail');

  const form = await session.get(NJ_VERIFICATION_URL, { timeoutMs: 120_000 });
  const formHtml = ok(form, 'detail search form');
  if (cheerio.load(formHtml)('#t_web_lookup__license_no').length === 0) {
    throw new AspNetFlowError('expected page marker missing (licence number box)', 'detail search form');
  }

  const results = await postBack(
    session,
    formAction(formHtml, form.finalUrl),
    formHtml,
    {
      t_web_lookup__profession_name: 'Home Improvement Contractors',
      t_web_lookup__license_type_name: '',
      t_web_lookup__full_name: '',
      t_web_lookup__license_no: licenceNo,
      t_web_lookup__addr_city: '',
    },
    { button: { name: 'sch_button', value: 'Search' } },
    { timeoutMs: 120_000 },
  );
  const resultsHtml = ok(results, 'detail search');
  const rows = parseNjResults(resultsHtml, results.finalUrl);
  const hit = rows.find((r) => r.licenceNo.toUpperCase() === licenceNo.toUpperCase());
  if (!hit) {
    throw new AspNetFlowError(`licence ${licenceNo} is not in the search results (${rows.length} rows)`, 'detail search');
  }

  const detail = await session.get(hit.href, { timeoutMs: 120_000 });
  const detailHtml = ok(detail, 'detail page');
  const parsed = parseNjDetail(detailHtml);
  const shownNo = cheerio.load(detailHtml)('#license_no').first().text().trim();
  if (shownNo.toUpperCase() !== licenceNo.toUpperCase()) {
    throw new AspNetFlowError(`the detail page shows licence "${shownNo}", not ${licenceNo}`, 'detail page');
  }
  return { licenceNo, ...parsed, detailUrl: detail.finalUrl, detailSha256: detail.sha256 };
}
