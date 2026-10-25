import { describe, expect, it } from 'vitest';
import { acceptedAddresses, extractEmails } from '../src/emails/extract';
import { html, loadSite, page } from './helpers';

function run(name: Parameters<typeof loadSite>[0]) {
  const s = loadSite(name);
  return extractEmails(s.pages, { websiteUrl: s.websiteUrl }, s.bundles);
}

describe('email extraction on the probe sites', () => {
  it('johnspaint: accepts the hotmail address, rejects the off-domain address with a reason', () => {
    const f = run('johnspaint');
    expect(acceptedAddresses(f)).toEqual(['johnspaint@hotmail.com']);
    const rejected = f.filter((x) => !x.accepted);
    expect(rejected.length).toBeGreaterThan(0);
    expect(new Set(rejected.map((x) => x.address))).toEqual(new Set(['office@johnspaintingnj.com']));
    expect(new Set(rejected.map((x) => x.rejectReason))).toEqual(new Set(['off-domain, not free-mail']));
  });

  it('njpaintingco: one value found by mailto, text and jsonld, one row per page', () => {
    const f = run('njpaintingco');
    expect(acceptedAddresses(f)).toEqual(['info@njpaintingco.com']);
    const methods = new Set(f.flatMap((x) => x.methods));
    expect(methods.has('mailto') && methods.has('text') && methods.has('jsonld')).toBe(true);
    expect(f.length).toBeGreaterThan(1);
    expect(new Set(f.map((x) => x.pageUrl)).size).toBe(f.length);
  });

  it('bartonspringspainting: the address is visible text only (no mailto)', () => {
    const f = run('bartonspringspainting');
    expect(acceptedAddresses(f)).toEqual(['info@bartonspringspainting.com']);
    expect(f.flatMap((x) => x.methods)).toEqual(['text']);
    expect(f[0]?.snippet).toContain('info@bartonspringspainting.com');
  });

  it('wepainttexas: JSON-LD address accepted; bundle placeholders and the unexplained gmail address rejected', () => {
    const f = run('wepainttexas');
    expect(acceptedAddresses(f)).toEqual(['info@wepainttexas.com']);
    expect(f.some((x) => x.address === 'info@wepainttexas.com' && x.methods.includes('jsonld'))).toBe(true);
    const rejected = new Map(f.filter((x) => !x.accepted).map((x) => [x.address, x.rejectReason]));
    for (const a of ['jane@email.com', 'name@example.com', 'nombre@ejemplo.com', 'you@example.com']) {
      expect(rejected.get(a), a).toBe('placeholder domain');
    }
    expect(rejected.get('sstoo@gmail.com')).toBe('bundle address not on the site domain');
    // the text scan never glues the "Email us" label onto the address in the next element
    expect(f.some((x) => x.address.startsWith('usinfo'))).toBe(false);
    expect(loadSite('wepainttexas').pages.some((p) => p.rendered)).toBe(true);
  });

  it('rutgerspainting: no accepted email', () => {
    expect(acceptedAddresses(run('rutgerspainting'))).toEqual([]);
  });
});

describe('email extraction rules', () => {
  const site = { websiteUrl: 'https://acme.com' };

  it('finds every form and keeps letter-case variants as one value', () => {
    const body = html(
      `<a href="mailto:Info@Acme.com?subject=Hi%20there">Mail</a>
       <p>Write to INFO@acme.com or sales [at] acme [dot] com or bob(at)acme.com</p>
       <script type="application/ld+json">{"@type":"LocalBusiness","email":"mailto:office@acme.com"}</script>`,
    );
    const f = extractEmails([page('https://acme.com/', body)], site);
    expect(acceptedAddresses(f).sort()).toEqual(['bob@acme.com', 'info@acme.com', 'office@acme.com', 'sales@acme.com']);
    const info = f.filter((x) => x.address === 'info@acme.com');
    expect(info).toHaveLength(1);
    expect(info[0]?.methods).toEqual(['mailto', 'text']);
    expect(f.find((x) => x.address === 'sales@acme.com')?.methods).toEqual(['obfuscated']);
  });

  it('decodes a Cloudflare-protected address', () => {
    const key = 0x2b;
    const hex = [key, ...Buffer.from('cf@acme.com').map((b) => b ^ key)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const body = html(`<a href="/cdn-cgi/l/email-protection#${hex}"><span class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</span></a>`);
    const f = extractEmails([page('https://acme.com/', body)], site);
    expect(acceptedAddresses(f)).toEqual(['cf@acme.com']);
    expect(f[0]?.methods).toEqual(['cfemail']);
  });

  it('a site with no email yields no findings', () => {
    expect(extractEmails([page('https://acme.com/', html('<p>Call us. Contact form below.</p>'))], site)).toEqual([]);
  });

  it('does not treat bare "name at domain dot com" prose as an address', () => {
    expect(extractEmails([page('https://acme.com/', html('<p>email bob at acme dot com</p>'))], site)).toEqual([]);
  });

  it('rejects a web-designer credit address but keeps a free-mail contact next to "Powered by"', () => {
    const body = html(
      `<footer><p>Website by Pixel Co <a href="mailto:sales@pixelco.com">sales@pixelco.com</a></p>
       <p>Powered by WordPress</p><p>Contact: acmepainter@gmail.com</p></footer>`,
    );
    const f = extractEmails([page('https://acme.com/', body)], site);
    expect(acceptedAddresses(f)).toEqual(['acmepainter@gmail.com']);
    expect(f.find((x) => x.address === 'sales@pixelco.com')?.rejectReason).toBe('web designer credit');
  });

  it('keeps bundle-only addresses only on the site domain', () => {
    const f = extractEmails([page('https://acme.com/', html('<p>hi</p>'))], site, [
      { url: 'https://acme.com/a.js', text: 'x="hello@acme.com";y="someone@gmail.com";z="logo@2x.png"' },
    ]);
    expect(acceptedAddresses(f)).toEqual(['hello@acme.com']);
    expect(f.find((x) => x.address === 'someone@gmail.com')?.rejectReason).toBe('bundle address not on the site domain');
    expect(f.find((x) => x.address === 'logo@2x.png')?.rejectReason).toBe('image or asset file name');
  });

  it('never constructs an address: a site without one stays empty even with a company name and domain', () => {
    const f = extractEmails([page('https://acme.com/', html('<h1>Acme Painting</h1><p>John Smith, Owner</p>'))], site);
    expect(acceptedAddresses(f)).toEqual([]);
  });

  it('on a shared host only free-mail is accepted (no company domain)', () => {
    const f = extractEmails([page('https://acme.business.site/', html('<p>info@acme.com acme@gmail.com</p>'))], {
      websiteUrl: 'https://acme.business.site/',
    });
    expect(acceptedAddresses(f)).toEqual(['acme@gmail.com']);
  });
});
