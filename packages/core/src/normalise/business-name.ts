const DBA_SPLIT = /\s+(?:D\/?B\/?A|T\/?A|A\/?K\/?A|TRADING AS|DOING BUSINESS AS)\s+/;

const ENTITY_SUFFIXES = new Set([
  'LLC',
  'INC',
  'INCORPORATED',
  'CORP',
  'CORPORATION',
  'CO',
  'COMPANY',
  'LTD',
  'LIMITED',
  'LP',
  'LLP',
  'PLLC',
  'PC',
  'PLC',
]);

const GENERIC_TRADE_WORDS = new Set([
  'PAINTING',
  'PAINTERS',
  'PAINT',
  'CONTRACTOR',
  'CONTRACTORS',
  'CONTRACTING',
  'SERVICES',
  'SERVICE',
  'HOME',
  'IMPROVEMENT',
  'IMPROVEMENTS',
  'AND',
  'CARPENTRY',
  'DECORATING',
  'PRO',
  'PROS',
  'PROFESSIONAL',
]);

function stripDiacritics(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '');
}

/** Steps 4-7 of R4 on one already upper-cased name part. */
function cleanPart(part: string): string {
  const noApostrophes = part.replace(/['’`".]/g, '');
  const tokens = noApostrophes
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (tokens[0] === 'THE' && tokens.length > 1) tokens.shift();

  // Drop trailing entity suffixes repeatedly ("L L C" is three tokens).
  for (;;) {
    const n = tokens.length;
    if (n >= 4 && tokens[n - 3] === 'L' && tokens[n - 2] === 'L' && tokens[n - 1] === 'C') {
      tokens.splice(n - 3, 3);
    } else if (n >= 2 && ENTITY_SUFFIXES.has(tokens[n - 1] as string)) {
      tokens.pop();
    } else {
      break;
    }
  }
  return tokens.join(' ');
}

/**
 * R4 business-name normalisation for registry matching. `norm` is the main name, `core` is `norm`
 * without generic trade words, `aliases` are the normalised DBA / trade-name parts.
 */
export function normaliseBusinessName(name: string): { norm: string; core: string; aliases: string[] } {
  const upper = stripDiacritics(name).toUpperCase().replace(/\s*[&+]\s*/g, ' AND ').replace(/\s+/g, ' ').trim();
  const [main = '', ...rest] = upper.split(DBA_SPLIT);
  const norm = cleanPart(main);
  const core = norm
    .split(' ')
    .filter((t) => t.length > 0 && !GENERIC_TRADE_WORDS.has(t))
    .join(' ');
  const aliases = [...new Set(rest.map(cleanPart).filter((a) => a.length > 0 && a !== norm))];
  return { norm, core, aliases };
}
