import type { TextBlock } from '../crawl/visible-text';

/**
 * Distinctive Latin filler vocabulary (R3): the classic lorem set plus the Cicero variant seen on
 * rutgerspainting.com. English collisions (sit, in, do, an, a, me, non ...) are left out.
 */
const CLASSIC = `lorem ipsum dolor amet consectetur adipiscing elit eiusmod tempor incididunt labore dolore magna aliqua
veniam quis nostrud exercitation ullamco laboris nisi aliquip commodo consequat duis aute irure reprehenderit voluptate
velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat proident sunt culpa officia deserunt mollit laborum`;
const CICERO = `quibusdam possumus senserit summis legam arbitrantur probant appellat instituendarum familiaritatem
incurreret fabulas cernantur admodum quem ita eram mandaremus tavissent`;

export const LATIN_VOCABULARY: ReadonlySet<string> = new Set(`${CLASSIC} ${CICERO}`.split(/\s+/).filter((w) => w.length > 0));

const MIN_TOKENS = 8;
const MIN_DISTINCT = 3;
const MIN_SHARE = 0.2;

export function tokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0);
}

export interface LatinHit {
  block: string;
  distinct: string[];
  share: number;
}

/** R3: a block of >= 8 tokens is Latin filler when >= 3 distinct vocabulary words make up >= 20% of it. */
export function latinBlocks(blocks: Pick<TextBlock, 'text'>[]): LatinHit[] {
  const hits: LatinHit[] = [];
  for (const b of blocks) {
    const t = tokens(b.text);
    if (t.length < MIN_TOKENS) continue;
    const inVocab = t.filter((w) => LATIN_VOCABULARY.has(w));
    const distinct = [...new Set(inVocab)];
    if (distinct.length >= MIN_DISTINCT && inVocab.length / t.length >= MIN_SHARE) {
      hits.push({ block: b.text, distinct, share: inVocab.length / t.length });
    }
  }
  return hits;
}
