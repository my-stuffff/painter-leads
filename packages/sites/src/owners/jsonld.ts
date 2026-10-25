import { load } from 'cheerio';
import { titleFromRole } from './patterns';

export interface JsonLdPerson {
  name: string;
  title: string | null;
  snippet: string;
}

const ROLE_WORD = /\b(co-?founder|co-?owner|founder|owner|president|ceo|proprietor)\b/i;

function personName(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') {
    return ((v as { name: string }).name || '').trim() || null;
  }
  return null;
}

function walk(node: unknown, out: JsonLdPerson[]): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const k = key.toLowerCase();
    if (k === 'founder' || k === 'founders') {
      for (const f of Array.isArray(value) ? value : [value]) {
        const name = personName(f);
        if (name) out.push({ name, title: 'Founder', snippet: `JSON-LD founder: ${name}` });
      }
    } else if (k === 'employee' || k === 'employees' || k === 'member' || k === 'members') {
      for (const e of Array.isArray(value) ? value : [value]) {
        if (e && typeof e === 'object') {
          const jobTitle = (e as { jobTitle?: unknown }).jobTitle;
          const name = personName(e);
          const m = typeof jobTitle === 'string' ? ROLE_WORD.exec(jobTitle) : null;
          if (name && m) out.push({ name, title: titleFromRole(m[1] as string), snippet: `JSON-LD ${k}: ${name}, ${String(jobTitle)}` });
        }
      }
    } else {
      walk(value, out);
    }
  }
}

/** schema.org founder, and employee / member entries whose jobTitle is an owner-type role. */
export function jsonLdPeople(html: string): JsonLdPerson[] {
  const $ = load(html);
  const out: JsonLdPerson[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (raw.length === 0) return;
    try {
      walk(JSON.parse(raw), out);
    } catch {
      // not valid JSON: ignore
    }
  });
  return out;
}
