/** Lowercased, trimmed address without `mailto:`, query string, angle brackets or trailing punctuation. */
export function normaliseEmail(e: string): string {
  return e
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/\?.*$/, '')
    .replace(/^[<"'(]+|[>"'),;.:]+$/g, '')
    .toLowerCase();
}
