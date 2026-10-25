import { describe, expect, it } from 'vitest';
import { normaliseValue } from '../src/evidence/normalise-value';
import {
  FREE_MAIL_DOMAINS,
  formatUsNational,
  last10,
  normaliseBusinessName,
  normaliseEmail,
  normaliseUrlForCompare,
  personFirstLastKey,
  personNameKey,
  registrableDomain,
  SHARED_HOST_DOMAINS,
  splitLastFirstMiddle,
  titleCaseName,
  toE164,
  zip5,
} from '../src/normalise';

describe('phone', () => {
  it('toE164 / formatUsNational / last10', () => {
    expect(toE164('(512) 373-0002')).toBe('+15123730002');
    expect(toE164('512.373.0002')).toBe('+15123730002');
    expect(toE164('+1 512 373 0002')).toBe('+15123730002');
    expect(toE164('555')).toBeNull();
    expect(toE164('not a phone')).toBeNull();
    expect(formatUsNational('+15123730002')).toBe('(512) 373-0002');
    expect(last10('(512) 373-0002')).toBe('5123730002');
    expect(last10('+15123730002')).toBe('5123730002');
    expect(last10('373-0002')).toBeNull();
  });
});

describe('registrableDomain (Pitfall 6)', () => {
  it('flags shared hosts', () => {
    expect(registrableDomain('https://jdoe.wixsite.com/x')).toMatchObject({ domain: 'jdoe.wixsite.com', sharedHost: true });
    expect(registrableDomain('https://sites.google.com/view/a')).toMatchObject({ sharedHost: true });
    expect(registrableDomain('facebook.com/acme')).toMatchObject({ sharedHost: true });
    expect(registrableDomain('https://acme.business.site')).toMatchObject({ sharedHost: true });
    expect(registrableDomain('https://acme.godaddysites.com')).toMatchObject({ sharedHost: true });
    expect(registrableDomain('https://www.bbb.org/us/nj/edison/profile/x')).toMatchObject({ sharedHost: true });
  });

  it('gives the registrable domain of an ordinary company site', () => {
    expect(registrableDomain('https://www.acmepainting.com/about')).toMatchObject({
      domain: 'acmepainting.com',
      sharedHost: false,
    });
    expect(registrableDomain('acmepainting.co.uk')).toMatchObject({ domain: 'acmepainting.co.uk', sharedHost: false });
  });

  it('handles junk and IP hosts without throwing', () => {
    expect(registrableDomain('')).toMatchObject({ domain: null, sharedHost: false });
    expect(registrableDomain('http://127.0.0.1/x')).toMatchObject({ domain: null, sharedHost: false });
  });

  it('exports the shared-host and free-mail lists', () => {
    expect(SHARED_HOST_DOMAINS).toContain('godaddysites.com');
    expect(FREE_MAIL_DOMAINS).toContain('gmail.com');
  });
});

describe('normaliseBusinessName (R4)', () => {
  it("JOHN'S PAINTING CONTRACTOR, LLC", () => {
    expect(normaliseBusinessName("JOHN'S PAINTING CONTRACTOR, LLC")).toEqual({
      norm: 'JOHNS PAINTING CONTRACTOR',
      core: 'JOHNS',
      aliases: [],
    });
  });

  it('keeps the trade name after T/A as an alias', () => {
    const r = normaliseBusinessName('CHERRY PAINTING CONTRACTORS & HOME IMPROVEMENT T/A ANTHONY CHERRY');
    expect(r.norm).toBe('CHERRY PAINTING CONTRACTORS AND HOME IMPROVEMENT');
    expect(r.aliases).toEqual(['ANTHONY CHERRY']);
    expect(r.core).toBe('CHERRY');
  });

  it('drops a leading THE and a trailing CO', () => {
    expect(normaliseBusinessName('The Painting Co.').norm).toBe('PAINTING');
  });

  it('drops repeated and spelled-out entity suffixes, folds diacritics, handles D/B/A', () => {
    expect(normaliseBusinessName('Acme Painters L.L.C.').norm).toBe('ACME PAINTERS');
    expect(normaliseBusinessName('Acme Painters L L C').norm).toBe('ACME PAINTERS');
    expect(normaliseBusinessName('Acme Painting Co., Inc.').norm).toBe('ACME PAINTING');
    expect(normaliseBusinessName('José Peña Painting LLC').norm).toBe('JOSE PENA PAINTING');
    expect(normaliseBusinessName('SMITH BROS INC DBA SMITH PAINTING').aliases).toEqual(['SMITH PAINTING']);
  });

  it('never strips a name down to nothing', () => {
    expect(normaliseBusinessName('LLC').norm).toBe('LLC');
  });
});

describe('person names', () => {
  it('splitLastFirstMiddle on fixed-width CSLB names', () => {
    expect(splitLastFirstMiddle('DOCKERY  RANDALL  MARK')).toEqual({
      first: 'Randall',
      middle: 'Mark',
      last: 'Dockery',
      display: 'Randall Dockery',
      full: 'Randall Mark Dockery',
    });
  });

  it('splitLastFirstMiddle on single-spaced and comma forms', () => {
    expect(splitLastFirstMiddle('LOPEZ DONAL')).toMatchObject({ first: 'Donal', last: 'Lopez', middle: null, display: 'Donal Lopez' });
    expect(splitLastFirstMiddle('MCDONALD, MARY ANN')).toMatchObject({ first: 'Mary', middle: 'Ann', last: 'McDonald' });
  });

  it('titleCaseName is Mc / O\' / hyphen aware and leaves mixed case alone', () => {
    expect(titleCaseName('MCDONALD')).toBe('McDonald');
    expect(titleCaseName("O'BRIEN")).toBe("O'Brien");
    expect(titleCaseName('SMITH-JONES')).toBe('Smith-Jones');
    expect(titleCaseName('MACHADO')).toBe('Machado');
    expect(titleCaseName('MACDONALD')).toBe('MacDonald');
    expect(titleCaseName('MCCOY')).toBe('McCoy');
    expect(titleCaseName('McDonald')).toBe('McDonald');
    expect(titleCaseName('ROBERT JR')).toBe('Robert Jr');
  });

  it('personNameKey ignores honorifics, middle initials, case and diacritics', () => {
    expect(personNameKey('Mr. John A. Catapano')).toBe('john catapano');
    expect(personNameKey('JOHN CATAPANO')).toBe('john catapano');
    expect(personNameKey('José  Peña')).toBe('jose pena');
    expect(personNameKey("Dr. Mary O'Brien Jr.")).toBe('mary obrien');
    expect(personNameKey('John Albert Catapano')).toBe('john albert catapano');
  });

  it('personFirstLastKey matches across middle names', () => {
    expect(personFirstLastKey('John Albert Catapano')).toBe(personFirstLastKey('Mr. John Catapano'));
    expect(personFirstLastKey('John Catapano')).not.toBe(personFirstLastKey('Jane Catapano'));
  });
});

describe('email, url, zip', () => {
  it('normaliseEmail', () => {
    expect(normaliseEmail('  Info@Acme.COM ')).toBe('info@acme.com');
    expect(normaliseEmail('mailto:Owner@Acme.com?subject=Hi')).toBe('owner@acme.com');
    expect(normaliseEmail('<owner@acme.com>.')).toBe('owner@acme.com');
  });

  it('normaliseUrlForCompare', () => {
    expect(normaliseUrlForCompare('https://www.Acme.com/')).toBe('acme.com');
    expect(normaliseUrlForCompare('http://acme.com/about/?x=1#top')).toBe('acme.com/about');
    expect(normaliseUrlForCompare('acme.com')).toBe('acme.com');
  });

  it('zip5 never guesses a lost leading zero', () => {
    expect(zip5('Edison, NJ 08817')).toBe('08817');
    expect(zip5('78701-1234')).toBe('78701');
    expect(zip5('8817')).toBeNull();
    expect(zip5(null)).toBeNull();
    expect(zip5('PO Box 123456')).toBeNull();
  });

  it('evidence value_norm uses the normalisers', () => {
    expect(normaliseValue('email', ' Info@Acme.com')).toBe('info@acme.com');
    expect(normaliseValue('phone', '(512) 373-0002')).toBe('+15123730002');
    expect(normaliseValue('website', 'https://www.acme.com/')).toBe('acme.com');
    expect(normaliseValue('owner_name', 'Mr. John A. Catapano')).toBe('john catapano');
    expect(normaliseValue('city', '  Edison ')).toBe('Edison');
  });
});
