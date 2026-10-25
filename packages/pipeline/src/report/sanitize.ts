/** Excel's hard limit for one cell. */
export const MAX_CELL_CHARS = 32767;

const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * T-05-01: a scraped value that starts with = + - @ tab or CR would run as a formula when the file is opened.
 * It gets a leading apostrophe (in xlsx and CSV alike). Over-long text is cut to Excel's cell limit.
 */
export function sanitizeCell(value: string): string {
  let s = value;
  const guarded = FORMULA_START.test(s);
  const limit = guarded ? MAX_CELL_CHARS - 1 : MAX_CELL_CHARS;
  if (s.length > limit) s = s.slice(0, limit);
  return guarded ? `'${s}` : s;
}

/** Inverse of the guard, for the verifier: strips an apostrophe sanitizeCell added. */
export function unguardCell(value: string): string {
  return value.startsWith("'") && FORMULA_START.test(value.slice(1)) ? value.slice(1) : value;
}

/** True when a string still starts like a formula (the verifier flags these). */
export function hasUnguardedFormulaPrefix(value: string): boolean {
  return FORMULA_START.test(value);
}

/** T-05-02: only http/https URLs become hyperlinks; anything else is plain text. */
export function safeHyperlink(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0 || /[\u0000-\u001f\u007f\s]/.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}
