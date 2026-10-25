import { fixture } from './helpers';
import type { makeFetcher } from './helpers';

export const HOST = 'https://newjersey.mylicense.com';
const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } };
export const roster = fixture('nj', 'nj-roster-synthetic.txt');

export interface Seen {
  method: string;
  path: string;
  body: URLSearchParams;
  cookie: string | undefined;
}

/** The 5-step flow as the site behaves: each POST answers with a redirect to the next page, in one cookie session. */
export function mockRosterFlow(agent: ReturnType<typeof makeFetcher>['agent'], over: { confirm?: string } = {}) {
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
    return page('roster-02_results-trimmed.html');
  });
  pool.intercept({ path: '/Verification_Bulk/SearchResults.aspx', method: 'POST' }).reply((o) => {
    rec('POST')(o);
    return redirect('Confirmation.aspx?from_page=Login.aspx');
  });
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
    return { statusCode: 200, data: roster, responseOptions: { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment;filename="Data.txt"' } } };
  });
  return seen;
}

