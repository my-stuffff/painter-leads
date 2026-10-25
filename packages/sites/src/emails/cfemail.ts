/**
 * Decodes a Cloudflare email-protection hex string: the first byte is the XOR key, the rest is the
 * address XOR-ed byte by byte. The bytes are UTF-8 decoded (a char-by-char decode garbles non-ASCII).
 */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  const bytes = Buffer.alloc(hex.length / 2 - 1);
  for (let i = 2; i < hex.length; i += 2) bytes[i / 2 - 1] = parseInt(hex.slice(i, i + 2), 16) ^ key;
  return bytes.toString('utf8');
}
