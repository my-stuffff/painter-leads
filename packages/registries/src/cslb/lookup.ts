import * as cheerio from 'cheerio';
import type { Fetcher } from '@pp/core';
import { formAction, isAspNetError, postBack } from '../aspnet';

export const CSLB_CHECK_LICENSE_URL = 'https://www2.cslb.ca.gov/OnlineServices/CheckLicenseII/CheckLicense.aspx';

export type CslbLookupStatus = 'lookup_unavailable';

export interface CslbLookupResult {
  /**
   * 'lookup_unavailable': the per-licence page could not be read without interaction. This is the honest result of
   * the live probe (2026-10-26, see the plan summary): the fallback is documented, not faked.
   */
  status: CslbLookupStatus;
  licenceNo: string;
  reason: string;
  pages: number;
}

/**
 * Per-licence CSLB lookup (D-20 fallback for matched licences whose people are not in a complete personnel file).
 * Probe result: the "Check a License" page answers a plain POST of the licence number with the search form again
 * (HTTP 200, no message, no detail page); the page loads Google's reCAPTCHA script, and CAPTCHA solving is ruled
 * out, so no personnel list is ever read here. Anything that is not a LicenseDetail page is 'lookup_unavailable'.
 */
export async function lookupCslbPersonnel(fetcher: Fetcher, licenceNo: string): Promise<CslbLookupResult> {
  if (!/^\d{1,8}$/.test(licenceNo)) throw new Error(`"${licenceNo}" is not a CSLB licence number`);
  const session = fetcher.session(`cslb-lookup-${licenceNo}`, 'cslb');
  const form = await session.get(CSLB_CHECK_LICENSE_URL);
  const html = form.text();
  if (form.status !== 200 || isAspNetError(html) || cheerio.load(html)('#MainContent_LicNo').length === 0) {
    return { status: 'lookup_unavailable', licenceNo, reason: `the search form did not load (HTTP ${form.status})`, pages: 1 };
  }
  const res = await postBack(
    session,
    formAction(html, form.finalUrl),
    html,
    { 'ctl00$MainContent$LicNo': licenceNo },
    { button: { name: 'ctl00$MainContent$Contractor_License_Number_Search', value: ' ' } },
  );
  if (/LicenseDetail\.aspx/i.test(res.finalUrl)) {
    return { status: 'lookup_unavailable', licenceNo, reason: 'a detail page came back, but no personnel parser exists (never observed)', pages: 2 };
  }
  return {
    status: 'lookup_unavailable',
    licenceNo,
    reason: 'the licence-number search returned the search form again, not a licence page (reCAPTCHA page; not pursued)',
    pages: 2,
  };
}
