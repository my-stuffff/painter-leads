import { describe, expect, it } from 'vitest';
import { checkMailDomain } from '../src/emails/mx';
import { fakeResolver } from './helpers';

describe('mail-domain check', () => {
  const r = fakeResolver({ mx: ['acme.com'], a: ['aonly.com'], nullMx: ['nomail.com'], broken: ['flaky.com'] });

  it('free-mail is never looked up', async () => {
    const out = await checkMailDomain('gmail.com', r, null);
    expect(out).toMatchObject({ result: 'free_mail', accept: true });
    expect(r.calls).toEqual([]);
  });

  it('MX records accept', async () => {
    expect(await checkMailDomain('acme.com', r, null)).toMatchObject({ result: 'mx', accept: true });
  });

  it('a domain with only an address record is accepted as a_fallback', async () => {
    expect(await checkMailDomain('aonly.com', r, null)).toMatchObject({ result: 'a_fallback', accept: true });
  });

  it('a null MX is rejected', async () => {
    expect(await checkMailDomain('nomail.com', r, null)).toMatchObject({ result: 'null_mx', accept: false, needsReview: false });
  });

  it('NXDOMAIN is rejected', async () => {
    expect(await checkMailDomain('missing.example', r, null)).toMatchObject({ result: 'no_records', accept: false, needsReview: false });
  });

  it('any other lookup error is needs_review, not a rejection', async () => {
    expect(await checkMailDomain('flaky.com', r, null)).toMatchObject({ result: 'error', accept: false, needsReview: true });
  });

  it('cache-only mode never touches DNS', async () => {
    const fresh = fakeResolver({ mx: ['acme.com'] });
    const out = await checkMailDomain('acme.com', fresh, null, { cacheOnly: true });
    expect(out.needsReview).toBe(true);
    expect(fresh.calls).toEqual([]);
  });
});
