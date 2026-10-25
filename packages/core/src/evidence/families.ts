import type { SourceType } from '../types';

/**
 * Independence families (D-22). Two evidence rows corroborate each other only when
 * their families differ: two pages of one website are one family.
 */
export const SOURCE_FAMILY: Record<SourceType, string> = {
  google_maps: 'google',
  website: 'website',
  cslb_master: 'cslb',
  cslb_personnel: 'cslb',
  cslb_lookup: 'cslb',
  nj_hic_roster: 'nj_hic',
  nj_hic_detail: 'nj_hic',
  nj_principal_search: 'nj_business_register',
  tx_open_data: 'tx_state',
  tx_comptroller: 'tx_state',
  bbb: 'bbb',
};

/** Official registers: an owner named here outranks a website claim (D-18). */
export const REGISTRY_SOURCE_TYPES: readonly SourceType[] = [
  'cslb_master',
  'cslb_personnel',
  'cslb_lookup',
  'nj_hic_detail',
  'nj_principal_search',
  'tx_open_data',
  'tx_comptroller',
];
