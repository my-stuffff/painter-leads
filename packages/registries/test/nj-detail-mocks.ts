import { fixture } from './helpers';
import type { makeFetcher } from './helpers';
import { HOST } from './nj-mocks';

const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } };

export type DetailWho = 'spectra' | 'rutgers' | 'johns';
type Agent = ReturnType<typeof makeFetcher>['agent'];

interface SeenRequest {
  method: string;
  path: string;
  body: URLSearchParams;
  cookie: string | undefined;
}

const cookieOf = (o: { headers?: unknown }): string | undefined => (o.headers as Record<string, string> | undefined)?.cookie;

/**
 * The HIC verification flow as the site behaves: the search sets the session cookie, the results link to
 * Details.aspx?result=GUID, and a Details request WITHOUT that cookie answers HTTP 500 "Runtime Error".
 */
export function mockDetailFlow(agent: Agent, who: DetailWho, over: { drop?: 'detail500' } = {}): SeenRequest[] {
  const pool = agent.get(HOST);
  const results = fixture('nj', `${who}-02_search_results.html`);
  const link = /Details\.aspx\?result=([0-9a-f-]+)/.exec(results)?.[1] as string;
  const seen: SeenRequest[] = [];
  pool.intercept({ path: '/verification/Search.aspx?facility=Y', method: 'GET' }).reply((o) => {
    seen.push({ method: 'GET', path: o.path, body: new URLSearchParams(), cookie: cookieOf(o) });
    return {
      statusCode: 200,
      data: fixture('nj', `${who}-01_search_form.html`),
      responseOptions: { headers: { 'content-type': 'text/html', 'set-cookie': 'ASP.NET_SessionId=sessD; path=/; HttpOnly' } },
    };
  });
  pool.intercept({ path: '/verification/Search.aspx?facility=Y', method: 'POST' }).reply((o) => {
    seen.push({ method: 'POST', path: o.path, body: new URLSearchParams(String(o.body)), cookie: cookieOf(o) });
    return { statusCode: 200, data: results, responseOptions: HTML };
  });
  pool.intercept({ path: `/verification/Details.aspx?result=${link}`, method: 'GET' }).reply((o) => {
    const cookie = cookieOf(o);
    seen.push({ method: 'GET', path: o.path, body: new URLSearchParams(), cookie });
    if (over.drop === 'detail500' || !cookie?.includes('ASP.NET_SessionId=sessD')) {
      return { statusCode: 500, data: fixture('nj', 'detail-nocookie-500.html'), responseOptions: HTML };
    }
    return { statusCode: 200, data: fixture('nj', `${who}-03_detail.html`), responseOptions: HTML };
  });
  return seen;
}

const PORTAL = 'https://www.njportal.com';
const PPATH = '/DOR/BusinessRecords/EntityDocs/BusinessStatCopies.aspx';

/** The principal-name wizard: GET, radio postback, Continue. `found` = the page with the matching entity row. */
export function mockPrincipalFlow(agent: Agent, found: boolean): SeenRequest[] {
  const pool = agent.get(PORTAL);
  const seen: SeenRequest[] = [];
  pool.intercept({ path: PPATH, method: 'GET' }).reply((o) => {
    seen.push({ method: 'GET', path: o.path, body: new URLSearchParams(), cookie: cookieOf(o) });
    return {
      statusCode: 200,
      data: fixture('njbiz', 'principal-01_get.html'),
      responseOptions: { headers: { 'content-type': 'text/html', 'set-cookie': 'ASP.NET_SessionId=sessP; path=/' } },
    };
  });
  pool.intercept({ path: PPATH, method: 'POST' }).reply((o) => {
    seen.push({ method: 'POST', path: o.path, body: new URLSearchParams(String(o.body)), cookie: cookieOf(o) });
    return { statusCode: 200, data: fixture('njbiz', 'principal-02_pick.html'), responseOptions: HTML };
  });
  pool.intercept({ path: PPATH, method: 'POST' }).reply((o) => {
    seen.push({ method: 'POST', path: o.path, body: new URLSearchParams(String(o.body)), cookie: cookieOf(o) });
    return {
      statusCode: 200,
      data: fixture('njbiz', found ? 'principal-03_results.html' : 'principal-03_noresult.html'),
      responseOptions: HTML,
    };
  });
  return seen;
}
