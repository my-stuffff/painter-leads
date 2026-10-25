import { fixture } from './helpers';
import type { makeFetcher } from './helpers';

export const HOST = 'https://newjersey.mylicense.com';
const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } };
export const roster = fixture('nj', 'nj-roster-synthetic.txt');

/** The trimmed results fixture has no licensee rows: add one to its grid, so it reads as a town that has registrations. */
const trimmedResults = fixture('nj', 'roster-02_results-trimmed.html');
const gridAt = trimmedResults.indexOf('id="datagrid_results"');
export const resultsWithRows =
  trimmedResults.slice(0, gridAt) +
  trimmedResults
    .slice(gridAt)
    .replace(
      /<\/tr>(\s*)<\/tbody>/,
      '</tr><tr><td><a href="Details.aspx?result=x">BRIGHT COAT PAINTING LLC</a></td><td>13VH90000001</td><td>Home Improvement Contractors</td><td>Home Improvement Business Contr</td><td>Active</td><td>Edison</td><td>NJ</td></tr>$1</tbody>',
    );

export interface Seen {
  method: string;
  path: string;
  body: URLSearchParams;
  cookie: string | undefined;
}

/** The 5-step flow as the site behaves: each POST answers with a redirect to the next page, in one cookie session. */
export function mockRosterFlow(
  agent: ReturnType<typeof makeFetcher>['agent'],
  over: {
    confirm?: string;
    /** The results page of the search (default: a town with registrations). */
    results?: string;
    /** The roster text the final step returns (default: the synthetic Edison roster). */
    roster?: string;
    /** "Download List" bounces to the login page, which answers HTTP 500 (the live Woodbridge Township failure). */
    downloadListFails?: boolean;
  } = {},
) {
  const seen: Seen[] = [];
  const pool = agent.get(HOST);
  const rec = (method: string) => (o: { path: string; body?: unknown; headers?: unknown }) => {
    seen.push({
      method,
      path: o.path,
      body: new URLSearchParams(typeof o.body === 'string' ? o.body : ''),
      cookie: (o.headers as Record<string, string> | undefined)?.cookie,
    });
  };
  const page = (file: string, html?: string) => ({ statusCode: 200, data: html ?? fixture('nj', file), responseOptions: HTML });
  const redirect = (to: string) => ({ statusCode: 302, data: '', responseOptions: { headers: { location: to } } });

  pool.intercept({ path: '/Verification_Bulk/Search.aspx?facility=Y', method: 'GET' }).reply((o) => {
    rec('GET')(o);
    return { statusCode: 200, data: fixture('nj', 'roster-01_form.html'), responseOptions: { headers: { 'content-type': 'text/html', 'set-cookie': 'ASP.NET_SessionId=sess1; path=/; HttpOnly' } } };
  });
  pool.intercept({ path: '/Verification_Bulk/Search.aspx?facility=Y', method: 'POST' }).reply((o) => {
    rec('POST')(o);
    return redirect('SearchResults.aspx');
  });
  pool.intercept({ path: '/Verification_Bulk/SearchResults.aspx', method: 'GET' }).reply((o) => {
    rec('GET')(o);
    return page('', over.results ?? resultsWithRows);
  });
  pool.intercept({ path: '/Verification_Bulk/SearchResults.aspx', method: 'POST' }).reply((o) => {
    rec('POST')(o);
    return redirect(over.downloadListFails ? 'Login.aspx?from_page=Confirmation.aspx' : 'Confirmation.aspx?from_page=Login.aspx');
  });
  if (over.downloadListFails) {
    pool.intercept({ path: '/Verification_Bulk/Login.aspx?from_page=Confirmation.aspx', method: 'GET' }).reply((o) => {
      rec('GET')(o);
      return { statusCode: 500, data: fixture('nj', 'detail-nocookie-500.html'), responseOptions: HTML };
    });
    return seen;
  }
  pool.intercept({ path: '/Verification_Bulk/Confirmation.aspx?from_page=Login.aspx', method: 'GET' }).reply((o) => {
    rec('GET')(o);
    return page('roster-03_confirm.html', over.confirm);
  });
  pool.intercept({ path: '/Verification_Bulk/Confirmation.aspx?from_page=Login.aspx', method: 'POST' }).reply((o) => {
    rec('POST')(o);
    return redirect('PrefDetails.aspx');
  });
  pool.intercept({ path: '/Verification_Bulk/PrefDetails.aspx', method: 'GET' }).reply((o) => {
    rec('GET')(o);
    return page('roster-04_pref.html');
  });
  pool.intercept({ path: '/Verification_Bulk/PrefDetails.aspx', method: 'POST' }).reply((o) => {
    rec('POST')(o);
    return { statusCode: 200, data: over.roster ?? roster, responseOptions: { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment;filename="Data.txt"' } } };
  });
  return seen;
}

