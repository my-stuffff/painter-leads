import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hiddenFields } from '../src/aspnet';
import { AspNetFlowError } from '../src/aspnet';
import { chargeShown, downloadNjRoster, isZeroCharge, NjChargeError } from '../src/nj/roster-flow';
import { fixture, makeFetcher, tempDir } from './helpers';
import { HOST, mockRosterFlow, roster } from './nj-mocks';

const HTML = { headers: { 'content-type': 'text/html; charset=utf-8' } };

describe('NJ roster 5-step flow (replayed)', () => {
  it('re-sends every hidden field at each step, keeps the session cookie, and saves the file outside the repo', async () => {
    const { fetcher, agent, config } = makeFetcher();
    const seen = mockRosterFlow(agent);
    const dir = tempDir();
    const r = await downloadNjRoster(fetcher, config, 'Edison', { now: new Date('2026-10-25T10:00:00Z'), destDir: dir });

    expect(r.rows).toBe(8);
    expect(r.path).toBe(path.join(dir, 'edison-2026-10-25.txt'));
    expect(readFileSync(r.path as string, 'utf8')).toBe(roster);

    const posts = seen.filter((s) => s.method === 'POST');
    expect(posts.map((p) => p.path)).toEqual([
      '/Verification_Bulk/Search.aspx?facility=Y',
      '/Verification_Bulk/SearchResults.aspx',
      '/Verification_Bulk/Confirmation.aspx?from_page=Login.aspx',
      '/Verification_Bulk/PrefDetails.aspx',
    ]);
    const pages = ['roster-01_form.html', 'roster-02_results-trimmed.html', 'roster-03_confirm.html', 'roster-04_pref.html'];
    posts.forEach((p, i) => {
      for (const [name, value] of Object.entries(hiddenFields(fixture('nj', pages[i] as string)))) {
        if (name === '__EVENTTARGET' || name === '__EVENTARGUMENT') continue;
        expect(p.body.get(name), `${name} at step ${i + 2}`).toBe(value);
      }
    });
    expect(seen.every((s) => (s.method === 'GET' && s.path.includes('Search.aspx') && !s.cookie) || (s.cookie ?? '').includes('ASP.NET_SessionId=sess1'))).toBe(true);

    expect(posts[0]?.body.get('t_web_lookup__profession_name')).toBe('Home Improvement Contractors');
    expect(posts[0]?.body.get('t_web_lookup__addr_city')).toBe('Edison');
    expect(posts[0]?.body.get('sch_button')).toBe('Search');
    expect(posts[1]?.body.get('btnBulkDownLoad')).toBe('Download List');
    expect(posts[2]?.body.get('btnContinue')).toBe('Continue');
    expect(posts[3]?.body.get('sch_button')).toBe('Download');
    expect(posts[3]?.body.get('filetype')).toBe('delimitedtext');
  });

  it('aborts when the confirmation page shows a charge other than $0.00, before the final step', async () => {
    const { fetcher, agent, config } = makeFetcher();
    const confirm = fixture('nj', 'roster-03_confirm.html').replace('$0.00', '$25.00');
    const seen = mockRosterFlow(agent, { confirm });
    await expect(downloadNjRoster(fetcher, config, 'Edison', { destDir: tempDir() })).rejects.toBeInstanceOf(NjChargeError);
    // the Continue and Download requests never went out
    expect(seen.some((s) => s.path.startsWith('/Verification_Bulk/PrefDetails'))).toBe(false);
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(2);
  });

  it('reads the charge text', () => {
    expect(chargeShown(fixture('nj', 'roster-03_confirm.html'))).toBe('0.00');
    expect(isZeroCharge('0.00')).toBe(true);
    expect(isZeroCharge('0')).toBe(true);
    expect(isZeroCharge('5.00')).toBe(false);
    expect(isZeroCharge(null)).toBe(false);
    expect(chargeShown('<body>Please continue</body>')).toBeNull();
  });

  it('stops with an error when a step returns an ASP.NET error page or lacks its marker', async () => {
    const { fetcher, agent, config } = makeFetcher();
    const pool = agent.get(HOST);
    pool.intercept({ path: '/Verification_Bulk/Search.aspx?facility=Y', method: 'GET' }).reply(200, '<html><head><title>Runtime Error</title></head></html>', HTML);
    await expect(downloadNjRoster(fetcher, config, 'Edison', { destDir: tempDir() })).rejects.toThrow(/roster search form/);
  });

  it('a town with no registrations returns no file', async () => {
    const { fetcher, agent, config } = makeFetcher();
    const pool = agent.get(HOST);
    pool.intercept({ path: '/Verification_Bulk/Search.aspx?facility=Y', method: 'GET' }).reply(200, fixture('nj', 'roster-01_form.html'), HTML);
    pool
      .intercept({ path: '/Verification_Bulk/Search.aspx?facility=Y', method: 'POST' })
      .reply(200, '<html><body><form action="./SearchResults.aspx"><input type="hidden" name="__VIEWSTATE" value="x"/>Your search did not return any results.</form></body></html>', HTML);
    const r = await downloadNjRoster(fetcher, config, 'Nowhereville', { destDir: tempDir() });
    expect(r).toMatchObject({ path: null, rows: 0 });
  });

  it('a results page with the Download List button but no licensee rows is an empty town: the button is never pressed (the live Woodbridge Township 500)', async () => {
    const { fetcher, agent, config } = makeFetcher();
    const seen = mockRosterFlow(agent, { results: fixture('nj', 'roster-02_results-empty.html') });
    const r = await downloadNjRoster(fetcher, config, 'Woodbridge Township', { destDir: tempDir() });
    expect(r).toMatchObject({ path: null, rows: 0, town: 'Woodbridge Township' });
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(1);
  });

  it('a 500 at "Download List" is reported as a flow error of that step', async () => {
    const { fetcher, agent, config } = makeFetcher();
    mockRosterFlow(agent, { downloadListFails: true });
    const err = await downloadNjRoster(fetcher, config, 'Edison', { destDir: tempDir() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AspNetFlowError);
    expect((err as AspNetFlowError).step).toBe('roster download list');
    expect((err as Error).message).toMatch(/HTTP 500 with an ASP\.NET error page/);
  });
});
