import { describe, expect, it } from 'vitest';
import { isFillerPage, latinBlocks, zeroCounters } from '../src/filler';
import { visibleText } from '../src/crawl/visible-text';
import { html, loadSite } from './helpers';

const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
const CICERO =
  'tavissent sed ita fugiat arbitrantur, probant sunt quibusdam appellat. Possumus si fore do senserit eu duis quibusdam o do summis legam ex nostrud';

describe('filler page detector (R3)', () => {
  it('flags the Cicero-variant filler on the rutgers about page with reason latin_filler', () => {
    const about = loadSite('rutgerspainting').pages.find((p) => p.url.includes('/about-us/') && !p.url.includes('blog'));
    expect(about).toBeDefined();
    const r = isFillerPage(about!);
    expect(r.filler).toBe(true);
    expect(r.reasons).toContain('latin_filler');
  });

  it('does not flag the real pages of the other probe sites', () => {
    for (const n of ['johnspaint', 'njpaintingco', 'bartonspringspainting', 'wepainttexas'] as const) {
      for (const p of loadSite(n).pages) expect(isFillerPage(p).filler, `${n} ${p.url}`).toBe(false);
    }
  });

  it('classic lorem ipsum is Latin filler; ordinary English with a few Latin-looking words is not', () => {
    expect(isFillerPage({ html: html(`<p>${LOREM}</p>`) })).toMatchObject({ filler: true, reasons: ['latin_filler'] });
    expect(isFillerPage({ html: html(`<p>${CICERO}</p>`) }).filler).toBe(true);
    expect(isFillerPage({ html: html('<p>Please sit down in the quiet room and enjoy the view of the lake with us today.</p>') }).filler).toBe(false);
    expect(latinBlocks(visibleText(html('<p>Lorem ipsum dolor</p>')).blocks)).toEqual([]); // under 8 tokens
  });

  it('two distinct demo markers flag a page; one alone does not', () => {
    expect(isFillerPage({ html: html('<p>Team Member</p><p>John Doe</p>') })).toMatchObject({ filler: true, reasons: ['demo_markers'] });
    expect(isFillerPage({ html: html('<p>Call us at (555) 123-4567</p>') }).filler).toBe(false);
    expect(isFillerPage({ html: html('<p>Hello world! Just another WordPress site</p>') }).filler).toBe(true);
  });

  it('an Elementor count-up counter (data-to-value) is real content and never a signal', () => {
    const counter = '<span class="elementor-counter-number" data-duration="2000" data-to-value="70" data-from-value="0" data-delimiter=",">0</span> +';
    expect(zeroCounters(html(counter))).toBe(0);
    expect(isFillerPage({ html: html(`<p>Projects Complete</p>${counter}`) })).toEqual({ filler: false, reasons: [] });
    // even next to one demo marker: a count-up is not corroboration
    expect(isFillerPage({ html: html(`<p>John Doe</p>${counter}`) }).filler).toBe(false);
  });

  it('a zero counter without an animation target is corroboration only', () => {
    const zero = '<div class="counter"><span class="counter-number">0</span></div>';
    expect(zeroCounters(html(zero))).toBe(1);
    expect(isFillerPage({ html: html(zero) }).filler).toBe(false);
    expect(isFillerPage({ html: html(`<p>Your Name</p>${zero}`) })).toMatchObject({ filler: true, reasons: ['demo_markers', 'zero_counter'] });
    const zeroTarget = '<span class="elementor-counter-number" data-to-value="0">0</span>';
    expect(zeroCounters(html(zeroTarget))).toBe(1);
  });
});
