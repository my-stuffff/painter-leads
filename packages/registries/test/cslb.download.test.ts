import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { downloadCslbFile, IncompleteDownloadError } from '../src/cslb/download';
import { fixture, makeFetcher, tempDir } from './helpers';

const PORTAL = 'https://web.cslb.ca.gov';
const PATH = '/Onlineservices/DataPortal/ContractorList';
const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } };

const linksPage = `<html><body><form>
<input type="hidden" name="__VIEWSTATE" value="vs2"/><input type="hidden" name="__EVENTVALIDATION" value="ev2"/>
<select name="ctl00$MainContent$ddlStatus"><option value="M" selected>License Master</option></select>
<span id="MainContent_lblMasterFile">Updated as of 10/23/2026</span>
<a id="MainContent_lbMasterCSV" href="javascript:__doPostBack('ctl00$MainContent$lbMasterCSV','')">CSV</a>
</form></body></html>`;

describe('CSLB download flow (replayed)', () => {
  it('walks landing -> file type -> CSV postback in one session, saves the file and a sidecar', async () => {
    const { fetcher, agent, config } = makeFetcher();
    const pool = agent.get(PORTAL);
    const posts: URLSearchParams[] = [];
    pool.intercept({ path: PATH, method: 'GET' }).reply(200, fixture('cslb', 'dataportal.html'), {
      headers: { 'content-type': 'text/html', 'set-cookie': 'ASP.NET_SessionId=s1; path=/' },
    });
    pool.intercept({ path: PATH, method: 'POST' }).reply((o) => {
      posts.push(new URLSearchParams(String(o.body)));
      return { statusCode: 200, data: linksPage, responseOptions: HTML };
    });
    const csv = 'LicenseNo,LastUpdate,BusinessName\n1000001,01/01/2026,TEST PAINTING\n';
    pool.intercept({ path: PATH, method: 'POST' }).reply((o) => {
      posts.push(new URLSearchParams(String(o.body)));
      return { statusCode: 200, data: csv, responseOptions: { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename=MasterLicenseData.csv' } } };
    });

    const dir = tempDir();
    const r = await downloadCslbFile(fetcher, config, 'master', { now: new Date('2026-10-25T10:00:00Z'), destDir: dir });
    expect(r.path).toBe(path.join(dir, 'master-2026-10-25.csv'));
    expect(readFileSync(r.path, 'utf8')).toBe(csv);
    expect(r.bytes).toBe(csv.length);
    expect(r.sha256).toBe(createHash('sha256').update(csv).digest('hex'));
    expect(r.asOf).toBe('2026-10-23');
    expect(existsSync(`${r.path}.json`)).toBe(true);

    expect(posts[0]?.get('ctl00$MainContent$ddlStatus')).toBe('M');
    expect(posts[0]?.get('__EVENTTARGET')).toBe('ctl00$MainContent$ddlStatus');
    expect(posts[1]?.get('__EVENTTARGET')).toBe('ctl00$MainContent$lbMasterCSV');
    expect(posts[1]?.get('__VIEWSTATE')).toBe('vs2');
    expect(posts[1]?.get('__EVENTVALIDATION')).toBe('ev2');
  });

  it('refuses a download cut off mid-row (no network error): the file is kept as *.INCOMPLETE and nothing is loadable', async () => {
    const { fetcher, agent, config } = makeFetcher();
    const pool = agent.get(PORTAL);
    pool.intercept({ path: PATH, method: 'GET' }).reply(200, fixture('cslb', 'dataportal.html'), HTML);
    pool.intercept({ path: PATH, method: 'POST' }).reply(200, linksPage, HTML);
    const cut = 'LicenseNo,LastUpdate,BusinessName\n1000001,01/01/2026,TEST PAINTING\n1000002,01/0';
    pool.intercept({ path: PATH, method: 'POST' }).reply(200, cut, { headers: { 'content-type': 'text/csv' } });
    const dir = tempDir();
    const err = await downloadCslbFile(fetcher, config, 'master', { now: new Date('2026-10-25T10:00:00Z'), destDir: dir }).catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteDownloadError);
    expect((err as IncompleteDownloadError).message).toMatch(/refused: a row does not parse/);
    expect(existsSync(path.join(dir, 'master-2026-10-25.csv'))).toBe(false);
    expect(existsSync(path.join(dir, 'master-2026-10-25.csv.INCOMPLETE'))).toBe(true);
  });

  it('refuses an HTML page that comes back instead of the CSV', async () => {
    const { fetcher, agent, config } = makeFetcher();
    const pool = agent.get(PORTAL);
    pool.intercept({ path: PATH, method: 'GET' }).reply(200, fixture('cslb', 'dataportal.html'), HTML);
    pool.intercept({ path: PATH, method: 'POST' }).reply(200, linksPage, HTML);
    pool.intercept({ path: PATH, method: 'POST' }).reply(200, '<html>Runtime Error</html>', HTML);
    await expect(downloadCslbFile(fetcher, config, 'master', { destDir: tempDir() })).rejects.toThrow(/does not start with the master header/);
  });

  it('stops with a clear error when the portal page has no CSV link', async () => {
    const { fetcher, agent, config } = makeFetcher();
    const pool = agent.get(PORTAL);
    pool.intercept({ path: PATH, method: 'GET' }).reply(200, fixture('cslb', 'dataportal.html'), HTML);
    pool.intercept({ path: PATH, method: 'POST' }).reply(200, '<html><body>nothing here</body></html>', HTML);
    await expect(downloadCslbFile(fetcher, config, 'master', { destDir: tempDir() })).rejects.toThrow(/no CSV download link/);
  });
});
