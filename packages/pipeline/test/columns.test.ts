import { describe, expect, it } from 'vitest';
import {
  BY_CITY_COLUMNS,
  COMPLETENESS_COLUMNS,
  MASTER_COLUMNS,
  QUALIFIED_COLUMNS,
  SOURCES_COLUMNS,
  SUMMARY_COLUMNS,
  TAB_HEADERS,
  TAB_NAMES,
} from '../src/report/columns';

// D-27, typed out independently of the source so a stray edit of the headers fails here.
const D27_QUALIFIED = [
  'Company',
  'Owner / decision-maker',
  'Owner title',
  'Owner source',
  'Owner confidence',
  'Phone',
  'Email',
  'Email source',
  'Website',
  'Google rating',
  'Google reviews',
  'Google profile link',
  'Category',
  'Address',
  'City',
  'ZIP',
  'State',
  'Licence/registration no.',
  'Residential status',
  'First seen',
  'Last checked',
];

describe('D-27 headers', () => {
  it('Qualified columns', () => {
    expect([...QUALIFIED_COLUMNS]).toEqual(D27_QUALIFIED);
  });

  it('Master list = Qualified columns + Qualified + Exclusion reasons', () => {
    expect([...MASTER_COLUMNS]).toEqual([...D27_QUALIFIED, 'Qualified', 'Exclusion reasons']);
  });

  it('the other four tabs', () => {
    expect([...BY_CITY_COLUMNS]).toEqual(['City', 'Companies found', 'Qualified', 'With owner', 'With email']);
    expect([...COMPLETENESS_COLUMNS]).toEqual(['Field', 'Count (all)', '% (all)', 'Count (qualified)', '% (qualified)']);
    expect([...SUMMARY_COLUMNS]).toEqual(['Item', 'Value']);
    expect([...SOURCES_COLUMNS]).toEqual(['Company', 'Field', 'Value', 'Source URL', 'Captured at', 'Confidence']);
  });

  it('tab names in the D-27 order, each with its header list', () => {
    expect([...TAB_NAMES]).toEqual(['Qualified', 'Master list', 'By city', 'Contact completeness', 'Summary', 'Sources']);
    for (const name of TAB_NAMES) expect(TAB_HEADERS[name].length).toBeGreaterThan(0);
  });
});
