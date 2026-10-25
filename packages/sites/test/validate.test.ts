import { describe, expect, it } from 'vitest';
import { validateFirstNameOnly, validateOwnerName, type OwnerNameContext } from '../src/owners/validate';

const ctx: OwnerNameContext = { companyName: 'Barton Springs Painting LLC', city: 'Austin', cities: ['Edison', 'San Diego'] };
const ok = (raw: string) => {
  const v = validateOwnerName(raw, ctx);
  return v.ok ? v.name : `REJECT: ${v.reason}`;
};

describe('owner name validation (ENR-02)', () => {
  it('accepts first + capitalised surname, middle initials, particles, hyphens, apostrophes, diacritics', () => {
    expect(ok('John Smith')).toBe('John Smith');
    expect(ok('John A. Smith')).toBe('John A. Smith');
    expect(ok('Maria Elena Lopez')).toBe('Maria Elena Lopez');
    expect(ok('Mary Smith-Jones')).toBe('Mary Smith-Jones');
    expect(ok("Sean O'Brien")).toBe("Sean O'Brien");
    expect(ok('José Álvarez')).toBe('José Álvarez');
    expect(ok('Carlos de la Cruz')).toBe('Carlos de la Cruz');
    expect(ok('Kevin McDonald')).toBe('Kevin McDonald');
  });

  it('drops leading filler words and honorifics, and title-cases a short all-caps name', () => {
    expect(ok('Meet John Smith')).toBe('John Smith');
    expect(ok('Dr. Susan Clark')).toBe('Susan Clark');
    expect(ok('JOHN SMITH')).toBe('John Smith');
    expect(ok('John Smith Jr.')).toBe('John Smith');
  });

  it('rejects role words ("Our Owner", "The Founder")', () => {
    expect(ok('Our Owner')).toBe('REJECT: role word in name');
    expect(ok('The Founder')).toBe('REJECT: role word in name');
    expect(ok('John Smith Owner')).toBe('REJECT: role word in name');
  });

  it('rejects company, city, state and painting words', () => {
    expect(ok('Barton Smith')).toBe('REJECT: company, city or painting word');
    expect(ok('Springs Hill')).toBe('REJECT: company, city or painting word');
    expect(ok('Austin Painting')).toBe('REJECT: company, city or painting word');
    expect(ok('Edison Home')).toBe('REJECT: company, city or painting word');
    expect(ok('Texas Pros')).toBe('REJECT: company, city or painting word');
    expect(ok('Paint Pros')).toBe('REJECT: company, city or painting word');
    expect(ok('Free Estimates')).toBe('REJECT: company, city or painting word');
  });

  it('rejects ALL-CAPS strings over three tokens', () => {
    expect(ok('JOHN MICHAEL ALLEN SMITH')).toBe('REJECT: all-caps string');
  });

  it('rejects an unknown first name with a reason, and a bad surname', () => {
    expect(ok('Xzqvt Smith')).toBe('REJECT: first name not in list');
    expect(ok('John smith')).toBe('REJECT: surname is not a capitalised word');
    expect(ok('John S.')).toBe('REJECT: surname is not a capitalised word');
    expect(ok('John')).toBe('REJECT: wrong number of words');
  });

  it('first-name lookup is case and diacritic insensitive', () => {
    expect(ok('josé Lopez')).toBe('REJECT: surname is not a capitalised word'); // lower-case word fails the shape check first
    expect(ok('JOSÉ LOPEZ')).toBe('José Lopez');
    expect(ok('MARIA Lopez')).toBe('MARIA Lopez');
  });

  it('first-name-only mode', () => {
    expect(validateFirstNameOnly('Mike', ctx)).toMatchObject({ ok: true, name: 'Mike', last: null });
    expect(validateFirstNameOnly('Xzqvt', ctx)).toEqual({ ok: false, reason: 'first name not in list' });
    expect(validateFirstNameOnly('Meet', ctx)).toEqual({ ok: false, reason: 'wrong number of words' });
    expect(validateFirstNameOnly('Austin', ctx)).toEqual({ ok: false, reason: 'company, city or painting word' });
  });
});
