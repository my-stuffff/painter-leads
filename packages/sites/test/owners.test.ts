import { describe, expect, it } from 'vitest';
import { emailKind, rankEmails } from '../src/emails/rank';
import { acceptedOwners, extractOwners, type OwnerSite } from '../src/owners/extract';
import { html, loadSite, page } from './helpers';

const site: OwnerSite = { companyName: 'Zeta Painting', city: 'Edison', cities: ['Austin', 'San Diego'] };
const one = (body: string, s: OwnerSite = site) => extractOwners([page('https://zeta.com/about', html(body))], s);
const accepted = (body: string, s: OwnerSite = site) => acceptedOwners(one(body, s)).map((f) => [f.name, f.title]);

describe('owner names on the probe sites', () => {
  it('bartonspringspainting: Jeff London (Founder) and Breanna Rene (Owner), medium confidence, snippet from the page', () => {
    const s = loadSite('bartonspringspainting');
    const f = extractOwners(s.pages, { companyName: 'Barton Springs Painting', city: 'Austin', confidence: 'medium' });
    const ok = acceptedOwners(f);
    expect(ok.map((x) => [x.name, x.title])).toEqual([
      ['Jeff London', 'Founder'],
      ['Breanna Rene', 'Owner'],
    ]);
    for (const x of ok) {
      expect(x.confidence).toBe('medium');
      expect(x.pageUrl).toBe('https://bartonspringspainting.com/about-us/');
      expect(x.pageSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(x.snippet).toContain(x.name);
    }
  });

  it('rutgerspainting: the filler "Meet Our Team" page yields zero accepted owners', () => {
    const s = loadSite('rutgerspainting');
    const f = extractOwners(s.pages, { companyName: 'Rutgers Painting', city: 'Edison' });
    expect(acceptedOwners(f)).toEqual([]);
    const brennan = f.find((x) => x.name === 'Brennan Price');
    expect(brennan).toMatchObject({ status: 'rejected', title: 'Owner' });
    expect(brennan?.rejectReason).toMatch(/^filler page \(latin_filler/);
    // the testimonial "Donald, the owner" is a low-confidence review mention only
    const donald = f.find((x) => x.name === 'Donald');
    expect(donald).toMatchObject({ status: 'needs_review', confidence: 'low', method: 'reviewer' });
  });

  it('johnspaint, njpaintingco and wepainttexas show no owner statement', () => {
    for (const [n, company, city] of [['johnspaint', "John's Painting", 'Edison'], ['njpaintingco', 'NJ Painting Co', 'Edison'], ['wepainttexas', 'We Paint Texas', 'Austin']] as const) {
      expect(acceptedOwners(extractOwners(loadSite(n).pages, { companyName: company, city })), n).toEqual([]);
    }
  });
});

describe('owner statements (D-18)', () => {
  it('accepts the explicit forms', () => {
    expect(accepted('<p>Meet John Smith, owner of Zeta Painting, who has painted homes for years.</p>')).toEqual([['John Smith', 'Owner']]);
    expect(accepted('<p>Founded in 2009 by Maria Lopez, we have grown steadily.</p>')).toEqual([['Maria Lopez', 'Founder']]);
    expect(accepted('<p>John Smith, Owner</p>')).toEqual([['John Smith', 'Owner']]);
    expect(accepted('<p>Owner: Carlos Rivera</p>')).toEqual([['Carlos Rivera', 'Owner']]);
    expect(accepted('<p>Maria Lopez is the owner and founder of the company.</p>')).toEqual([['Maria Lopez', 'Owner']]);
    expect(accepted('<p>Family owned and operated by Robert Jones since 1998.</p>')).toEqual([['Robert Jones', 'Owner']]);
    expect(accepted('<p>Our president Susan Clark leads every estimate.</p>')).toEqual([['Susan Clark', 'President']]);
  });

  it('accepts schema.org founder and employee JSON-LD', () => {
    const founder = '<script type="application/ld+json">{"@type":"LocalBusiness","founder":{"@type":"Person","name":"Linda Perez"}}</script>';
    const f = one(founder);
    expect(acceptedOwners(f).map((x) => [x.name, x.title, x.method])).toEqual([['Linda Perez', 'Founder', 'jsonld']]);
    const staff = '<script type="application/ld+json">{"@type":"LocalBusiness","employee":[{"@type":"Person","name":"Tom Baker","jobTitle":"Owner"},{"@type":"Person","name":"Ann Cole","jobTitle":"Estimator"}]}</script>';
    expect(accepted(staff)).toEqual([['Tom Baker', 'Owner']]);
  });

  it('team cards: a name line next to a role line, in either order', () => {
    expect(accepted('<div class="card"><h3>Jane Roe</h3><p>Owner &amp; Founder</p></div>')).toEqual([['Jane Roe', 'Owner']]);
    expect(accepted('<div><p>Founder</p></div><div><p>Peter Hill</p></div>')).toEqual([['Peter Hill', 'Founder']]);
    expect(accepted('<h3>Jane Roe</h3><p>Project Manager</p>')).toEqual([]);
  });

  it('rejects role words, company, city and painting words', () => {
    expect(accepted('<p>Our Owner</p><p>The Founder</p>')).toEqual([]);
    const f = one('<p>Owner: Austin Painting</p><p>Founder: Zeta Painters</p><p>Owner: Edison Home</p>');
    expect(acceptedOwners(f)).toEqual([]);
    expect(f.map((x) => x.rejectReason)).toEqual(expect.arrayContaining(['company, city or painting word']));
  });

  it('a first name with no surname is stored low confidence, needs_review only', () => {
    const f = one("<p>Hi, I'm Mike — owner of the company.</p>");
    expect(acceptedOwners(f)).toEqual([]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ name: 'Mike', status: 'needs_review', confidence: 'low', rejectReason: 'first name only' });
  });

  it('reviewer mentions are low confidence, needs_review only', () => {
    for (const body of [
      '<p>John the owner was great and fast.</p>',
      '<blockquote><p>Thanks, Maria Lopez, owner, did a great job.</p></blockquote>',
      '<div class="testimonial"><p>Robert Jones, Owner, is wonderful.</p></div>',
    ]) {
      const f = one(body);
      expect(acceptedOwners(f), body).toEqual([]);
      expect(f.length, body).toBe(1);
      expect(f[0], body).toMatchObject({ status: 'needs_review', confidence: 'low', method: 'reviewer' });
    }
  });

  it('names with diacritics, hyphens and apostrophes are accepted; case and diacritics do not matter for the first-name lookup', () => {
    expect(accepted('<p>José Álvarez, Owner</p>')).toEqual([['José Álvarez', 'Owner']]);
    expect(accepted('<p>Mary Smith-Jones, Owner</p>')).toEqual([['Mary Smith-Jones', 'Owner']]);
    expect(accepted("<p>Sean O'Brien, Owner</p>")).toEqual([["Sean O'Brien", 'Owner']]);
    expect(accepted('<p>MARIA LOPEZ, OWNER</p>')).toEqual([['Maria Lopez', 'Owner']]);
    expect(accepted('<p>Ana de la Cruz, Owner</p>')).toEqual([['Ana de la Cruz', 'Owner']]);
  });

  it('a first name that is not in the list is rejected with a reason (logged so the gap is measurable)', () => {
    const f = one('<p>Xzqvt Smith, Owner</p>');
    expect(acceptedOwners(f)).toEqual([]);
    expect(f[0]).toMatchObject({ status: 'rejected', rejectReason: 'first name not in list' });
  });

  it('a page with no owner statement yields no names, and an email local part or domain never creates one', () => {
    expect(one('<p>We paint homes. Email john.smith@zeta.com or visit johnsmithpainting.com</p>')).toEqual([]);
  });

  it('the same person on one page is one finding; website confidence follows the config', () => {
    const f = one('<h2>Jeff London – Founder</h2><p>Thanks to our Founder, Jeff London, many homes look better.</p>');
    expect(f).toHaveLength(1);
    expect(extractOwners([page('https://zeta.com/', html('<p>Jeff London, Owner</p>'))], { ...site, confidence: 'low' })[0]).toMatchObject({
      status: 'accepted',
      confidence: 'low',
    });
  });
});

describe('personal email ranking (D-17)', () => {
  const owners = ['John Smith', 'Maria de la Cruz'];
  it('marks first name, last name, initial + last and first + last as personal', () => {
    for (const a of ['john@z.com', 'smith@z.com', 'jsmith@z.com', 'john.smith@z.com', 'johnsmith@z.com', 'maria@z.com', 'mcruz@z.com']) {
      expect(emailKind(a, owners), a).toBe('personal');
    }
    expect(emailKind('info@z.com', owners)).toBe('role');
    expect(emailKind('sales@z.com', owners)).toBe('role');
    expect(emailKind('bob@z.com', owners)).toBe('other');
  });

  it('orders personal > role > other, ties by first page seen then alphabetical', () => {
    const items = [
      { address: 'zed@z.com', kind: emailKind('zed@z.com', owners), firstSeen: 0 },
      { address: 'info@z.com', kind: emailKind('info@z.com', owners), firstSeen: 3 },
      { address: 'john@z.com', kind: emailKind('john@z.com', owners), firstSeen: 5 },
      { address: 'office@z.com', kind: emailKind('office@z.com', owners), firstSeen: 3 },
      { address: 'abe@z.com', kind: emailKind('abe@z.com', owners), firstSeen: 0 },
    ];
    expect(rankEmails(items).map((i) => i.address)).toEqual(['john@z.com', 'info@z.com', 'office@z.com', 'abe@z.com', 'zed@z.com']);
  });
});
