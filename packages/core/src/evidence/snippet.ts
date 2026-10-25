/**
 * Trims visible text to at most `max` characters around a match (default 300), collapsing
 * whitespace first, so a snippet always shows what the value was read from.
 */
export function makeSnippet(text: string, index: number, matchLength: number, max = 300): string {
  // Collapse whitespace runs to one space while mapping original offsets to collapsed offsets.
  let collapsed = '';
  const map: number[] = new Array<number>(text.length + 1);
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    map[i] = collapsed.length;
    const isSpace = /\s/.test(text[i] as string);
    if (isSpace) {
      if (!prevSpace) collapsed += ' ';
      prevSpace = true;
    } else {
      collapsed += text[i];
      prevSpace = false;
    }
  }
  map[text.length] = collapsed.length;

  const start = map[Math.max(0, Math.min(index, text.length))] ?? 0;
  const end = map[Math.max(0, Math.min(index + matchLength, text.length))] ?? collapsed.length;
  const len = end - start;

  if (collapsed.length <= max) return collapsed.trim();

  const room = Math.max(0, max - len);
  let from = Math.max(0, start - Math.floor(room / 2));
  let to = Math.min(collapsed.length, from + max);
  from = Math.max(0, to - max);
  // Always include the whole match when it fits.
  if (len <= max && end > to) {
    to = end;
    from = to - max;
  }
  return collapsed.slice(from, to).trim();
}
