import { describe, expect, it } from 'vitest';
import { decodeCfEmail } from '../src/emails/cfemail';

function encode(address: string, key: number): string {
  const bytes = Buffer.from(address, 'utf8');
  return [key, ...bytes.map((b) => b ^ key)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('Cloudflare email decode', () => {
  it('round-trips an ASCII address', () => {
    expect(decodeCfEmail(encode('info@acme.com', 0x5a))).toBe('info@acme.com');
  });

  it('decodes a non-ASCII address through the UTF-8 step', () => {
    expect(decodeCfEmail(encode('josé@pintura-ñandú.com', 0x21))).toBe('josé@pintura-ñandú.com');
  });

  it('rejects malformed input', () => {
    expect(decodeCfEmail('zz')).toBeNull();
    expect(decodeCfEmail('abc')).toBeNull();
    expect(decodeCfEmail('')).toBeNull();
  });
});
