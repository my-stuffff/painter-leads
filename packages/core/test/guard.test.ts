import dns from 'node:dns';
import { describe, expect, it } from 'vitest';
import { request } from 'undici';

describe('network guard', () => {
  it('is switched on and live mode is off', () => {
    expect(process.env.PP_NETWORK_GUARD).toBe('1');
    expect(process.env.PP_LIVE).toBeUndefined();
  });

  it('an un-mocked undici request to https://example.com rejects', async () => {
    await expect(request('https://example.com/')).rejects.toThrow();
  });

  it('global fetch rejects', async () => {
    await expect(fetch('https://example.com/')).rejects.toThrow(/network access is disabled/);
  });

  it('dns.promises.resolveMx rejects', async () => {
    await expect(dns.promises.resolveMx('example.com')).rejects.toThrow(/network access is disabled/);
  });

  it('dns.lookup of a real host fails, an IP literal still works', async () => {
    await expect(dns.promises.lookup('example.com')).rejects.toThrow(/network access is disabled/);
    await expect(dns.promises.lookup('127.0.0.1')).resolves.toMatchObject({ address: '127.0.0.1' });
  });

  it('a Resolver instance fails closed', async () => {
    const r = new dns.promises.Resolver();
    await expect(r.resolve4('example.com')).rejects.toThrow(/network access is disabled/);
  });
});
