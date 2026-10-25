/** First US ZIP in the text as 5 digits (ZIP+4 reduced); null when there is none. Never guesses a lost leading zero. */
export function zip5(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /(?<!\d)(\d{5})(?:-\d{4})?(?!\d)/.exec(raw);
  return m ? (m[1] as string) : null;
}
