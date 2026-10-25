import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** US phone to E.164 ("+15123730002"); null when it is not a valid US number. */
export function toE164(raw: string): string | null {
  const parsed = parsePhoneNumberFromString(raw, 'US');
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

/** "+15123730002" -> "(512) 373-0002". */
export function formatUsNational(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164, 'US');
  if (!parsed) return e164;
  return parsed.formatNational();
}

/** Last 10 digits of a raw or E.164 US number; null when fewer than 10 digits. */
export function last10(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length === 10 ? digits : null;
}
