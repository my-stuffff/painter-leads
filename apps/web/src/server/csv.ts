import { parse } from 'csv-parse/sync';
import type { LeadList } from '../shared/api';
import { LEAD_LIST_LABEL } from '../shared/api';

/** Byte-order mark: Excel needs it to read the CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

const cell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The stored export CSV narrowed to one list (its first column is "List"). */
export function csvForList(stored: Buffer, list: LeadList | 'all'): string {
  const text = stored.toString('utf8');
  if (list === 'all') return text.startsWith(BOM) ? text : BOM + text;
  const rows = parse(text.startsWith(BOM) ? text.slice(1) : text, { relax_column_count: true }) as string[][];
  const [header, ...body] = rows;
  if (!header) return BOM;
  const want = LEAD_LIST_LABEL[list];
  const keep = body.filter((r) => r[0] === want);
  return BOM + [header, ...keep].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
