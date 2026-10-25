import { describe, expect, it } from 'vitest';
import { filterEmail } from '../src/emails/filters';
import { deobfuscate } from '../src/emails/obfuscated';

const ctx = { siteDomains: ['acme.com'], method: 'text' as const };

describe('email acceptance filters', () => {
  it('rejects image names and privacy proxies', () => {
    expect(filterEmail('logo@2x.png', ctx)).toEqual({ accept: false, reason: 'image or asset file name' });
    expect(filterEmail('owner@withheldforprivacy.com', ctx)).toEqual({ accept: false, reason: 'privacy proxy' });
    expect(filterEmail('x@domainsbyproxy.com', ctx)).toEqual({ accept: false, reason: 'privacy proxy' });
  });

  it('rejects placeholders by domain and by local part', () => {
    for (const a of ['jane@email.com', 'name@example.com', 'nombre@ejemplo.com', 'you@example.com', 'a@sentry.io', 'x@o1.ingest.sentry.io']) {
      expect(filterEmail(a, ctx), a).toEqual({ accept: false, reason: 'placeholder domain' });
    }
    expect(filterEmail('noreply@acme.com', ctx)).toEqual({ accept: false, reason: 'placeholder local part' });
    expect(filterEmail('webmaster@acme.com', ctx)).toEqual({ accept: false, reason: 'placeholder local part' });
  });

  it('accepts the site domain (and its subdomains) and free-mail, rejects other domains', () => {
    expect(filterEmail('info@acme.com', ctx)).toEqual({ accept: true });
    expect(filterEmail('info@mail.acme.com', ctx)).toEqual({ accept: true });
    expect(filterEmail('Acme.Painting@Gmail.com', ctx)).toEqual({ accept: true });
    expect(filterEmail('office@other.com', ctx)).toEqual({ accept: false, reason: 'off-domain, not free-mail' });
  });

  it('bundle addresses must be on the site domain', () => {
    const b = { ...ctx, method: 'bundle' as const };
    expect(filterEmail('hi@acme.com', b)).toEqual({ accept: true });
    expect(filterEmail('hi@gmail.com', b)).toEqual({ accept: false, reason: 'bundle address not on the site domain' });
  });

  it('rejects syntactically invalid addresses', () => {
    expect(filterEmail('not-an-address', ctx)).toEqual({ accept: false, reason: 'invalid address' });
    expect(filterEmail('@acme.com', ctx)).toEqual({ accept: false, reason: 'invalid address' });
  });
});

describe('bracketed at/dot forms', () => {
  it('matches only explicit bracket or paren forms', () => {
    expect(deobfuscate('mail sales [at] acme [dot] com now').map((m) => m.address)).toEqual(['sales@acme.com']);
    expect(deobfuscate('bob(at)acme(dot)co(dot)uk').map((m) => m.address)).toEqual(['bob@acme.co.uk']);
    expect(deobfuscate('bob {at} acme.com').map((m) => m.address)).toEqual(['bob@acme.com']);
    expect(deobfuscate('bob at acme dot com')).toEqual([]);
    expect(deobfuscate('plain@acme.com')).toEqual([]);
  });
});
