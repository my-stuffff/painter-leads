import { describe, expect, it } from 'vitest';
import { mapRosterRow, parseNjRoster, rosterDate } from '../src/nj/roster-parse';
import { fixture } from './helpers';

const text = fixture('nj', 'nj-roster-synthetic.txt');

describe('NJ roster parse', () => {
  it('the header ends with a pipe but the 18 named columns come out with no empty-key column', () => {
    const rows = parseNjRoster(text);
    expect(rows).toHaveLength(8);
    const keys = Object.keys(rows[0] ?? {});
    expect(keys).toHaveLength(18);
    expect(keys).not.toContain('');
    expect(keys).toEqual(expect.arrayContaining(['full_name', 'license_no', 'license_status_name', 'addr_line_1', 'addr_city', 'addr_zipcode', 'addr_email']));
  });

  it('maps full_name, licence number (string), status, address, ZIP (leading zero kept) and a lower-cased email', () => {
    const row = parseNjRoster(text)[0];
    const d = mapRosterRow(row as NonNullable<typeof row>);
    expect(d).toMatchObject({
      sourceKey: '13VH90000001',
      legalName: 'BRIGHT COAT PAINTING LLC',
      status: 'Active',
      city: 'Edison',
      zip: '08817',
      email: 'info@brightcoat-example.test',
      issuedOn: '2021-04-02',
      expiresOn: '2027-03-31',
    });
    expect(d?.nameNorm).toBe('BRIGHT COAT PAINTING');
    expect(d?.nameCore).toBe('BRIGHT COAT');
  });

  it("gives both sides of 'T/A' as names", () => {
    const row = parseNjRoster(text).find((r) => r.license_no === '13VH90000003');
    const d = mapRosterRow(row as NonNullable<typeof row>);
    expect(d?.nameNorm).toBe('CHERRY PAINTING CONTRACTORS AND HOME IMPROVEMENT');
    expect(d?.aliases).toContain('ANTHONY CHERRY');
  });

  it('keeps unusual characters: quotes in a name are not treated as CSV quoting; BOM and CRLF are fine', () => {
    const header = text.split('\n')[0] as string;
    const row = 'JOE "THE BRUSH" PAINTING|||||Home Improvement Contractors|Home Improvement Business Contr|13VH90000009|1/1/2020|3/31/2026|1 A St||Edison|NJ|08817|Middlesex||Active|';
    const rows = parseNjRoster(`﻿${header}\r\n${row}\r\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.full_name).toBe('JOE "THE BRUSH" PAINTING');
    expect(rows[0]?.license_status_name).toBe('Active');
  });

  it('empty file gives no rows; rows without a licence number are dropped', () => {
    expect(parseNjRoster('')).toEqual([]);
    const header = text.split('\n')[0] as string;
    expect(parseNjRoster(`${header}\nNO NUMBER|||||x|y||||||||||||\n`)).toEqual([]);
  });

  it('dates with or without a time part parse; nonsense is null', () => {
    expect(rosterDate('3/7/2011')).toBe('2011-03-07');
    expect(rosterDate('03/07/2011 00:00:00')).toBe('2011-03-07');
    expect(rosterDate('2011-03-07')).toBe('2011-03-07');
    expect(rosterDate('')).toBeNull();
    expect(rosterDate('sometime')).toBeNull();
  });
});
