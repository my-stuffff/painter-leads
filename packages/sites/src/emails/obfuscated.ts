export interface ObfuscatedMatch {
  address: string;
  index: number;
  length: number;
}

const AT = String.raw`\s*[\[\(\{]\s*at\s*[\]\)\}]\s*`;
const DOT = String.raw`\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*`;
// name [at] domain [dot] com, name(at)domain(dot)com, name [at] domain.com, name@domain [dot] com
const FORM = new RegExp(
  String.raw`[A-Z0-9._%+-]+(?:${AT}|@)[A-Z0-9-]+(?:(?:${DOT}|\.)[A-Z0-9-]+)+`,
  'gi',
);
const HAS_TOKEN = new RegExp(`${AT}|${DOT}`, 'i');
const AT_RE = new RegExp(AT, 'gi');
const DOT_RE = new RegExp(DOT, 'gi');
const VALID = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}$/i;

/**
 * Addresses written with an explicit bracketed "at" or "dot" ([at] (at) {at} [dot] (dot) {dot}).
 * Bare "name at domain dot com" prose is NOT matched (too many false positives).
 */
export function deobfuscate(text: string): ObfuscatedMatch[] {
  const out: ObfuscatedMatch[] = [];
  for (const m of text.matchAll(FORM)) {
    if (!HAS_TOKEN.test(m[0])) continue;
    const address = m[0].replace(AT_RE, '@').replace(DOT_RE, '.');
    if (VALID.test(address)) out.push({ address, index: m.index, length: m[0].length });
  }
  return out;
}
