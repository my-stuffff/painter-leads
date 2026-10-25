import { describe, expect, it } from 'vitest';
import { scanNjHicNumbers } from '../src/licence';
import { html, loadSite, page } from './helpers';

describe('13VH registration number scan', () => {
  it('johnspaint shows 13VH06084400 (one finding per page)', () => {
    const f = scanNjHicNumbers(loadSite('johnspaint').pages);
    expect(new Set(f.map((x) => x.number))).toEqual(new Set(['13VH06084400']));
    expect(f.length).toBe(loadSite('johnspaint').pages.length);
    expect(f[0]?.snippet).toContain('13VH06084400');
  });

  it('finds it in visible text, upper-cases it, and is exact about the shape', () => {
    const f = scanNjHicNumbers([page('https://a.com/', html('<p>NJ HIC # 13vh06084400. Also 13VH0608440 and 113VH06084400 and 13VH060844001x.</p>'))]);
    expect(f.map((x) => x.number)).toEqual(['13VH06084400']);
  });

  it('other probe sites show none; the same number twice on a page is one finding', () => {
    expect(scanNjHicNumbers(loadSite('njpaintingco').pages)).toEqual([]);
    expect(scanNjHicNumbers([page('https://a.com/', html('<p>13VH06084400</p><footer>13VH06084400</footer>'))])).toHaveLength(1);
  });
});
