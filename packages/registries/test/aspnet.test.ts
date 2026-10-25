import { describe, expect, it } from 'vitest';
import { buildPostBackForm, eventTargetOf, hiddenFields, isAspNetError, postBack } from '../src/aspnet';
import { findCsvTarget, portalAsOf } from '../src/cslb/download';
import { fixture, makeFetcher } from './helpers';

const PORTAL = 'https://web.cslb.ca.gov';
const PATH = '/Onlineservices/DataPortal/ContractorList';
const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } };

describe('ASP.NET helpers', () => {
  const portal = fixture('cslb', 'dataportal.html');

  it('hiddenFields collects every hidden input of the real data portal page', () => {
    const fields = hiddenFields(portal);
    expect(Object.keys(fields).sort()).toEqual(
      ['__EVENTARGUMENT', '__EVENTTARGET', '__EVENTVALIDATION', '__LASTFOCUS', '__VIEWSTATE', '__VIEWSTATEGENERATOR'].sort(),
    );
    expect(fields.__VIEWSTATE?.length).toBeGreaterThan(100);
  });

  it('the postback form re-sends ALL hidden fields, plus the chosen control and the event target', () => {
    const form = buildPostBackForm(portal, { 'ctl00$MainContent$ddlStatus': 'M' }, { eventTarget: 'ctl00$MainContent$ddlStatus' });
    for (const [name, value] of Object.entries(hiddenFields(portal))) {
      if (name === '__EVENTTARGET') continue;
      expect(form[name]).toBe(value);
    }
    expect(form.__EVENTTARGET).toBe('ctl00$MainContent$ddlStatus');
    expect(form['ctl00$MainContent$ddlStatus']).toBe('M');
  });

  it('a submit button is sent as name=value, and the caller can override a hidden value', () => {
    const form = buildPostBackForm('<input type="hidden" name="a" value="1"><input type="hidden" name="b" value="2">', { b: '3' }, { button: { name: 'go', value: 'Search' } });
    expect(form).toEqual({ a: '1', b: '3', go: 'Search' });
  });

  it('detects ASP.NET error pages by content, not only by status', () => {
    expect(isAspNetError('<html><head><title>Runtime Error</title></head><body>...</body></html>')).toBe(true);
    expect(isAspNetError("<h1>Server Error in '/' Application.</h1>")).toBe(true);
    expect(isAspNetError(portal)).toBe(false);
  });

  it('reads the event target of a __doPostBack link and the "as of" date of the portal', () => {
    expect(eventTargetOf("javascript:__doPostBack('ctl00$MainContent$lbMasterCSV','')")).toBe('ctl00$MainContent$lbMasterCSV');
    expect(eventTargetOf(undefined)).toBeNull();
    expect(portalAsOf('<body><span>Updated as of 10/23/2026</span></body>')).toBe('2026-10-23');
    expect(portalAsOf(portal)).toBeNull();
  });

  it('finds the CSV link by its id, and falls back to any csv link for the right file kind', () => {
    const byId = `<a id="MainContent_lbMasterCSV" href="javascript:__doPostBack('ctl00$MainContent$lbMasterCSV','')">CSV</a>`;
    expect(findCsvTarget(byId, 'master')).toBe('ctl00$MainContent$lbMasterCSV');
    const odd = `<a id="x_personnelCsv" href="javascript:__doPostBack('ctl00$x$personnelCsv','')">p</a>`;
    expect(findCsvTarget(odd, 'personnel')).toBe('ctl00$x$personnelCsv');
    expect(findCsvTarget(odd, 'master')).toBeNull();
  });

  it('in one cookie session, the postback carries the cookie and every hidden field of the latest page', async () => {
    const { fetcher, agent } = makeFetcher();
    const pool = agent.get(PORTAL);
    pool.intercept({ path: PATH, method: 'GET' }).reply(200, portal, { headers: { 'content-type': 'text/html', 'set-cookie': 'ASP.NET_SessionId=abc123; path=/; HttpOnly' } });
    let seen: { body: string; cookie: string | undefined } | null = null;
    pool
      .intercept({ path: PATH, method: 'POST' })
      .reply((opts) => {
        const headers = opts.headers as Record<string, string>;
        seen = { body: String(opts.body), cookie: headers.cookie };
        return { statusCode: 200, data: '<html>ok</html>', responseOptions: HTML };
      });
    const session = fetcher.session('test', 'cslb');
    const landing = await session.get(`${PORTAL}${PATH}`);
    await postBack(session, landing.finalUrl, landing.text(), { 'ctl00$MainContent$ddlStatus': 'M' }, { eventTarget: 'ctl00$MainContent$ddlStatus' });
    expect(seen).not.toBeNull();
    const form = new URLSearchParams((seen as unknown as { body: string }).body);
    for (const name of Object.keys(hiddenFields(portal))) expect(form.has(name)).toBe(true);
    expect(form.get('ctl00$MainContent$ddlStatus')).toBe('M');
    expect((seen as unknown as { cookie: string }).cookie).toContain('ASP.NET_SessionId=abc123');
  });
});
