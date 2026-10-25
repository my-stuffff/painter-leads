import type { Field } from '../types';

// Temporary local helpers: Task 3 replaces these with the @pp/core normalisers.

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'sr', 'jr', 'ii', 'iii', 'iv']);

function foldDiacritics(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function nameKey(name: string): string {
  const tokens = foldDiacritics(name)
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !HONORIFICS.has(t));
  const kept = tokens.filter((t, i) => !(t.length === 1 && i > 0 && i < tokens.length - 1));
  return kept.join(' ');
}

function phoneNorm(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits.length > 0 ? `+${digits}` : raw.trim();
}

function urlNorm(raw: string): string {
  const s = raw.trim().replace(/^[a-z]+:\/\//i, '');
  const [hostPart, ...rest] = s.split('/');
  const host = (hostPart ?? '').toLowerCase().replace(/^www\./, '');
  const path = rest.join('/').split(/[?#]/)[0]?.replace(/\/+$/, '') ?? '';
  return path ? `${host}/${path}` : host;
}

/** value_norm rules per field (equal value_norm = same value for agreement checks). */
export function normaliseValue(field: Field, value: string): string {
  switch (field) {
    case 'email':
      return value.trim().toLowerCase();
    case 'phone':
      return phoneNorm(value);
    case 'website':
      return urlNorm(value);
    case 'owner_name':
      return nameKey(value);
    default:
      return value.trim().normalize('NFC');
  }
}
