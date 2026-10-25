import { load } from 'cheerio';

/** Attributes that carry the value a count-up widget animates to. */
export const ANIMATION_TARGET_ATTRS = ['data-to-value', 'data-to', 'data-count', 'data-target', 'data-number', 'data-end'] as const;

/**
 * R3 / Pitfall 8: how many counters show a static zero WITHOUT an animation target. An Elementor
 * count-up (`<span class="elementor-counter-number" data-to-value="70">0`) is real content, not
 * a placeholder, and is never counted. A zero counter is corroboration only (see isFillerPage).
 */
export function zeroCounters(html: string): number {
  const $ = load(html);
  let n = 0;
  $('[class*="counter"], [data-to-value], [data-count], [data-target], [data-number], [data-end]').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 0 && !$el.is('[class*="counter-number"]')) return;
    const text = $el.text().replace(/[\s+,%]/g, '');
    if (text !== '0') return;
    const animated = ANIMATION_TARGET_ATTRS.some((a) => {
      const v = $el.attr(a);
      return v !== undefined && Number(v.replace(/[,\s]/g, '')) !== 0 && v.trim() !== '';
    });
    if (!animated) n++;
  });
  return n;
}
