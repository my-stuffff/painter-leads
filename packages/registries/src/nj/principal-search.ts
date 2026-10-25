import * as cheerio from 'cheerio';
import type { Fetcher, FetchResult } from '@pp/core';
import { AspNetFlowError, buildPostBackForm, formAction, isAspNetError, postBack } from '../aspnet';

export const NJ_STATUS_COPIES_URL = 'https://www.njportal.com/DOR/BusinessRecords/EntityDocs/BusinessStatCopies.aspx';

const WIZ = 'ctl00$mainContent$wzMain';
const RADIO = `${WIZ}$searchInput$rblSearchType`;
const CONTINUE = `${WIZ}$StartNavigationTemplateContainerID$btnContinue`;

export interface NjEntity {
  name: string;
  entityId: string;
  city: string;
  type: string;
  filingDate: string;
}

export interface NjPrincipalResult {
  entities: NjEntity[];
  /** The page the rows were read from. */
  searchUrl: string;
  searchSha256: string;
}

/** Controls that would put something in the cart (a paid order). They must never be part of a posted form. */
const ORDER_CONTROL = /cbStatusReport|cbCopies|StepNavigationTemplateContainerID|btnAddToCart|btnCheckout/i;

export function assertNoOrderControls(form: Record<string, string>): void {
  const bad = Object.keys(form).find((k) => ORDER_CONTROL.test(k));
  if (bad) throw new Error(`refusing to post an order/cart control (${bad}) to the NJ business register`);
}

/** Result rows of the principal-name search (display only: the order checkboxes are ignored). */
export function parseNjEntities(html: string): NjEntity[] {
  const $ = cheerio.load(html);
  const grid = $('table[id$="gvCopiesSearchResult"]').first();
  const headers = grid
    .find('tr')
    .first()
    .find('th')
    .map((_, th) => ($(th).attr('abbr') ?? $(th).text()).replace(/\s+/g, ' ').trim())
    .get();
  const col = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const [iName, iId, iCity, iType, iDate] = [col('Business Name'), col('Entity ID'), col('City'), col('Type'), col('Original Filing Date')];
  if (iName < 0 || iId < 0) return [];
  const out: NjEntity[] = [];
  grid
    .find('tr')
    .slice(1)
    .each((_, tr) => {
      const cells = $(tr)
        .children('td')
        .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
        .get();
      if (!cells[iName] || !cells[iId]) return;
      out.push({
        name: cells[iName] as string,
        entityId: cells[iId] as string,
        city: cells[iCity] ?? '',
        type: cells[iType] ?? '',
        filingDate: cells[iDate] ?? '',
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
 * Confirms "person X is a principal of company Y" against the NJ Division of Revenue business register with the
 * free principal-name search (D-21): WebForms wizard in ONE session - GET, radio postback (PrincipalName), fill
 * last/first name, Continue. The results page is only read: the order / copies checkboxes and cart buttons are
 * never posted (the officer list itself is a paid order and is never bought).
 */
export async function confirmNjPrincipal(
  fetcher: Fetcher,
  who: { first: string; last: string; city?: string },
): Promise<NjPrincipalResult> {
  const session = fetcher.session(`nj-principal-${who.last}`, 'nj_principal_search');

  const landing = await session.get(NJ_STATUS_COPIES_URL, { timeoutMs: 120_000 });
  const landingHtml = ok(landing, 'principal landing');
  if (cheerio.load(landingHtml)(`input[name="${RADIO}"]`).length === 0) {
    throw new AspNetFlowError('expected page marker missing (search type radios)', 'principal landing');
  }

  // Radio postback: __EVENTTARGET is the radio control (njportal, Pitfall 9).
  const picked = await postBack(
    session,
    formAction(landingHtml, landing.finalUrl),
    landingHtml,
    { [RADIO]: 'PrincipalName' },
    { eventTarget: `${RADIO}$2` },
    { timeoutMs: 120_000 },
  );
  const pickedHtml = ok(picked, 'principal search type');
  const $ = cheerio.load(pickedHtml);
  const lastBox = $('input[type="text"][name$="txtPrincipalName"]').attr('name');
  const firstBox = $('input[type="text"][name$="txtFirstName"]').attr('name');
  if (!lastBox || !firstBox) throw new AspNetFlowError('name boxes missing after choosing Principal Name', 'principal search type');

  const fields: Record<string, string> = { [RADIO]: 'PrincipalName', [lastBox]: who.last, [firstBox]: who.first };
  const middleBox = $('input[type="text"][name$="txtMiddleName"]').attr('name');
  const cityBox = $('input[type="text"][name$="txtCity"]').attr('name');
  if (middleBox) fields[middleBox] = '';
  if (cityBox) fields[cityBox] = who.city ?? '';
  const submit = { button: { name: CONTINUE, value: 'Continue' } };

  // Last guard before the post: nothing from the cart / order side may be in the form that goes out.
  assertNoOrderControls(buildPostBackForm(pickedHtml, fields, submit));
  const results = await postBack(session, formAction(pickedHtml, picked.finalUrl), pickedHtml, fields, submit, { timeoutMs: 120_000 });
  const resultsHtml = ok(results, 'principal search');
  return { entities: parseNjEntities(resultsHtml), searchUrl: results.finalUrl, searchSha256: results.sha256 };
}
