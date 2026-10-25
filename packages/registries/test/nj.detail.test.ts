import { describe, expect, it } from 'vitest';
import { AspNetFlowError } from '../src/aspnet';
import { fetchNjOwner, parseNjDetail, parseNjResults } from '../src/nj/detail-flow';
import { assertNoOrderControls, confirmNjPrincipal, parseNjEntities } from '../src/nj/principal-search';
import { fixture, makeFetcher } from './helpers';
import { mockDetailFlow, mockPrincipalFlow } from './nj-detail-mocks';

describe('NJ HIC detail page', () => {
  it('replays the Spectra registration: owner Eric Doeler, Active, issued 3/7/2011, expires 3/31/2027', async () => {
    const { fetcher, agent } = makeFetcher();
    const seen = mockDetailFlow(agent, 'spectra');
    const d = await fetchNjOwner(fetcher, '13VH06161800');
    expect(d).toMatchObject({
      licenceNo: '13VH06161800',
      fullName: 'SPECTRA PAINTING, INC',
      ownerName: 'Eric Doeler',
      status: 'Active',
      issueDate: '3/7/2011',
      expirationDate: '3/31/2027',
      city: 'Tinton Falls',
      zip: '07724',
    });
    expect(d.detailUrl).toMatch(/\/verification\/Details\.aspx\?result=/);
    // one cookie session: the search and the detail request carry the session cookie
    expect(seen).toHaveLength(3);
    expect(seen[0]?.cookie).toBeUndefined();
    expect(seen[1]?.cookie).toContain('sessD');
    expect(seen[2]?.cookie).toContain('sessD');
    expect(seen[1]?.body.get('t_web_lookup__license_no')).toBe('13VH06161800');
    expect(seen[1]?.body.get('t_web_lookup__profession_name')).toBe('Home Improvement Contractors');
    expect(seen[1]?.body.get('sch_button')).toBe('Search');
  });

  it('reads the owners of the other two public registrations', async () => {
    for (const [who, no, owner] of [
      ['rutgers', '13VH11241900', 'Donal Lopez'],
      ['johns', '13VH06084400', 'John Catapano'],
    ] as const) {
      const { fetcher, agent } = makeFetcher();
      mockDetailFlow(agent, who);
      expect((await fetchNjOwner(fetcher, no)).ownerName).toBe(owner);
    }
  });

  it('a detail request that fails (HTTP 500 Runtime Error, like a fetch without the session) is an error, never "no owner"', async () => {
    const { fetcher, agent } = makeFetcher();
    mockDetailFlow(agent, 'spectra', { drop: 'detail500' });
    const err = await fetchNjOwner(fetcher, '13VH06161800').catch((e) => e);
    expect(err).toBeInstanceOf(AspNetFlowError);
    expect(String(err.message)).toMatch(/detail page.*HTTP 500/);
    expect(parseNjDetail(fixture('nj', 'detail-nocookie-500.html')).ownerName).toBeNull();
  });

  it('a licence that is not among the search results is an error', async () => {
    const { fetcher, agent } = makeFetcher();
    mockDetailFlow(agent, 'spectra');
    await expect(fetchNjOwner(fetcher, '13VH99999999')).rejects.toThrow(/not in the search results/);
  });

  it('parses the results grid: licence number, name, link and status', () => {
    const rows = parseNjResults(fixture('nj', 'spectra-02_search_results.html'), 'https://newjersey.mylicense.com/verification/Search.aspx?facility=Y');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ licenceNo: '13VH06161800', name: 'SPECTRA PAINTING, INC', status: 'Active' });
    expect(rows[0]?.href).toMatch(/^https:\/\/newjersey\.mylicense\.com\/verification\/Details\.aspx\?result=[0-9a-f-]{36}$/);
  });
});

describe('NJ business register principal-name search', () => {
  it('replays DOELER, ERIC: SPECTRA PAINTING, INC. entity 0100508103, and never posts an order or cart control', async () => {
    const { fetcher, agent } = makeFetcher();
    const seen = mockPrincipalFlow(agent, true);
    const r = await confirmNjPrincipal(fetcher, { first: 'Eric', last: 'Doeler' });
    expect(r.entities).toEqual([
      { name: 'SPECTRA PAINTING, INC.', entityId: '0100508103', city: 'TINTON FALLS', type: 'DP', filingDate: '02/1992' },
    ]);
    const posts = seen.filter((s) => s.method === 'POST');
    expect(posts).toHaveLength(2);
    // radio postback
    expect(posts[0]?.body.get('__EVENTTARGET')).toBe('ctl00$mainContent$wzMain$searchInput$rblSearchType$2');
    expect(posts[0]?.body.get('ctl00$mainContent$wzMain$searchInput$rblSearchType')).toBe('PrincipalName');
    // search
    expect(posts[1]?.body.get('ctl00$mainContent$wzMain$searchInput$txtPrincipalName')).toBe('Doeler');
    expect(posts[1]?.body.get('ctl00$mainContent$wzMain$searchInput$txtFirstName')).toBe('Eric');
    expect(posts[1]?.body.get('ctl00$mainContent$wzMain$StartNavigationTemplateContainerID$btnContinue')).toBe('Continue');
    for (const p of posts) {
      for (const k of p.body.keys()) expect(k).not.toMatch(/cbStatusReport|cbCopies|StepNavigationTemplateContainerID|btnAddToCart/i);
      expect(p.cookie).toContain('sessP');
    }
  });

  it('no result gives an empty list', async () => {
    const { fetcher, agent } = makeFetcher();
    mockPrincipalFlow(agent, false);
    expect((await confirmNjPrincipal(fetcher, { first: 'Nobody', last: 'Atall' })).entities).toEqual([]);
    expect(parseNjEntities(fixture('njbiz', 'principal-03_noresult.html'))).toEqual([]);
  });

  it('the order guard refuses a form with a cart or order control', () => {
    expect(() => assertNoOrderControls({ a: '1', ctl00$x$cbStatusReport: 'on' })).toThrow(/order\/cart/);
    expect(() => assertNoOrderControls({ ctl00$mainContent$wzMain$StepNavigationTemplateContainerID$btnContinue: 'Continue' })).toThrow();
    expect(() => assertNoOrderControls({ ctl00$mainContent$wzMain$StartNavigationTemplateContainerID$btnContinue: 'Continue' })).not.toThrow();
  });
});
