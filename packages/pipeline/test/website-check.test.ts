import { describe, expect, it } from 'vitest';
import { lookupDomain, websiteMissingReason } from '../src/website-check';
import { publicResolver } from './helpers';

describe('lookupDomain (second lookup on a public resolver)', () => {
  it('NXDOMAIN for both address types is confirmed not found', async () => {
    expect(await lookupDomain(publicResolver({}), 'bartspropainting.com')).toBe('not_found');
  });

  it('an address from the public resolver means the domain exists', async () => {
    expect(await lookupDomain(publicResolver({ 'real.com': { a: ['93.184.216.34'] } }), 'real.com')).toBe('exists');
    expect(await lookupDomain(publicResolver({ 'v6.com': { aaaa: ['2606:2800::1'] } }), 'v6.com')).toBe('exists');
  });

  it.each([['ENODATA'], ['ETIMEOUT'], ['ESERVFAIL'], ['ECONNREFUSED'], ['EAI_AGAIN']])(
    'anything but NXDOMAIN (%s) is unknown, never "does not exist"',
    async (code) => {
      expect(await lookupDomain(publicResolver({ 'x.com': { a: code, aaaa: code } }), 'x.com')).toBe('unknown');
      expect(await lookupDomain(publicResolver({ 'x.com': { a: 'ENOTFOUND', aaaa: code } }), 'x.com')).toBe('unknown');
    },
  );

  it('writes the reason with the check date', () => {
    expect(websiteMissingReason(new Date('2026-10-26T08:00:00Z'))).toBe('website listed on Google does not exist (checked 2026-10-26)');
  });
});
