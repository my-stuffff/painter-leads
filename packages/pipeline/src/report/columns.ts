/** Exact D-27 headers. Tabs, workbook cells and CSV columns all come from these arrays. */
export const QUALIFIED_COLUMNS = [
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
] as const;

export const MASTER_COLUMNS = [...QUALIFIED_COLUMNS, 'Qualified', 'Exclusion reasons'] as const;

export const BY_CITY_COLUMNS = ['City', 'Companies found', 'Qualified', 'With owner', 'With email'] as const;

export const COMPLETENESS_COLUMNS = ['Field', 'Count (all)', '% (all)', 'Count (qualified)', '% (qualified)'] as const;

export const SUMMARY_COLUMNS = ['Item', 'Value'] as const;

export const SOURCES_COLUMNS = ['Company', 'Field', 'Value', 'Source URL', 'Captured at', 'Confidence'] as const;

export const TAB_NAMES = ['Qualified', 'Master list', 'By city', 'Contact completeness', 'Summary', 'Sources'] as const;

export const TAB_HEADERS: Record<(typeof TAB_NAMES)[number], readonly string[]> = {
  Qualified: QUALIFIED_COLUMNS,
  'Master list': MASTER_COLUMNS,
  'By city': BY_CITY_COLUMNS,
  'Contact completeness': COMPLETENESS_COLUMNS,
  Summary: SUMMARY_COLUMNS,
  Sources: SOURCES_COLUMNS,
};

/** Columns that hold a hyperlink in the workbook (text is the URL itself). */
export const LINK_COLUMNS: ReadonlySet<string> = new Set(['Website', 'Google profile link']);
/** Columns written as text so a leading zero survives (NJ ZIPs). */
export const TEXT_COLUMNS: ReadonlySet<string> = new Set(['ZIP']);
