/**
 * R5 phrase tables for the residential classifier. Every pattern has a stable id so evidence rows
 * and golden tests can refer to it. Text is matched case-insensitively after NFKC and whitespace
 * normalisation; "and" / "&" are written as (?:and|&) here.
 */
export interface PhraseDef {
  id: string;
  re: RegExp;
}

const AND = String.raw`(?:and|&|\/)`;
const PAINT = String.raw`paint(?:ing|ers?)`;

export const RESIDENTIAL_PHRASES: readonly PhraseDef[] = [
  { id: 'res:interior-painting', re: new RegExp(String.raw`\binterior(?:\s*${AND}\s*exterior)?\s+(?:(?:house|home)\s+)?${PAINT}\b`, 'gi') },
  { id: 'res:exterior-painting', re: new RegExp(String.raw`\b(?:interior\s*${AND}\s*)?exterior\s+(?:(?:house|home)\s+)?${PAINT}\b`, 'gi') },
  { id: 'res:house-painting', re: new RegExp(String.raw`\b(?:house|home)\s+${PAINT}\b`, 'gi') },
  { id: 'res:cabinet-painting', re: /\bcabinet\s+(?:paint(?:ing|ers?)|refinish(?:ing|ers?)?|resurfacing)\b/gi },
  { id: 'res:deck-staining', re: new RegExp(String.raw`\bdeck\s+(?:(?:${AND})\s+fence\s+)?stain(?:ing)?\b`, 'gi') },
  { id: 'res:fence-staining', re: /\bfence\s+stain(?:ing)?\b/gi },
  { id: 'res:homeowners', re: /\bhome\s?owners?\b(?!\s+associations?)/gi },
  { id: 'res:your-home', re: /\byour\s+home\b/gi },
  { id: 'res:residential-painting', re: /\bresidential\s+(?:paint(?:ing|ers?)|projects?|clients?|customers?|work|services?|repaint(?:ing)?)\b/gi },
];

export const COMMERCIAL_PHRASES: readonly PhraseDef[] = [
  { id: 'com:commercial-painting', re: /\bcommercial\s+paint(?:ing|ers?)\b/gi },
  { id: 'com:commercial-projects', re: /\bcommercial\s+(?:projects?|work|jobs?|contractors?|repaint(?:ing)?)\b/gi },
  { id: 'com:commercial-clients', re: /\bcommercial\s+(?:clients?|customers?|properties|buildings?|services?|interiors?|exteriors?)\b/gi },
  { id: 'com:industrial', re: /\bindustrial\b/gi },
  { id: 'com:warehouse', re: /\bwarehouses?\b/gi },
  { id: 'com:office-buildings', re: /\boffice\s+(?:buildings?|spaces?|complexes|parks?)\b/gi },
  { id: 'com:retail-spaces', re: /\bretail\s+(?:spaces?|stores?|centers?|shops?|properties)\b/gi },
  { id: 'com:tenant-improvement', re: /\btenant\s+improvements?\b/gi },
  { id: 'com:property-management', re: /\bproperty\s+(?:management|managers?)\b/gi },
  { id: 'com:hoa', re: /\bhoas?\b|\bhome\s?owners?\s+associations?\b/gi },
  { id: 'com:multi-family', re: /\bmulti[-\s]?family\b/gi },
  { id: 'com:apartments', re: /\bapartment\s+(?:complexes?|buildings?|communities)\b/gi },
  { id: 'com:new-construction', re: /\bnew\s+construction\b/gi },
  { id: 'com:general-contractors', re: /\bgeneral\s+contractors\b/gi },
];

/** "residential and commercial" in any order: both a commercial and a residential signal. */
const JOIN = String.raw`(?:\s*,\s*(?:and\s+|&\s*)?|\s*${AND}\s*)`;
export const COMBINED_PHRASE: PhraseDef = {
  id: 'residential-and-commercial',
  re: new RegExp(String.raw`\bresidential${JOIN}commercial\b|\bcommercial${JOIN}residential\b`, 'gi'),
};

/**
 * Service targets that only count when at least two distinct ones sit in the same line
 * ("offices, restaurants, schools and churches"): alone each is too ambiguous.
 */
export const TARGET_PHRASES: readonly PhraseDef[] = [
  { id: 'com:facilities', re: /\bfacilities\b/gi },
  { id: 'com:restaurants', re: /\brestaurants\b/gi },
  { id: 'com:schools', re: /\bschools\b/gi },
  { id: 'com:churches', re: /\bchurches\b/gi },
  { id: 'com:hotels', re: /\bhotels\b/gi },
  { id: 'com:hospitals', re: /\bhospitals\b/gi },
];

export const NEGATION_PHRASES: readonly PhraseDef[] = [
  { id: 'neg:no-commercial-work', re: /\b(?:we|i)\s+(?:do\s+not|don['’]t|no\s+longer)\s+(?:do|offer|provide|take\s+on)\s+(?:any\s+)?commercial/gi },
  { id: 'neg:residential-only', re: /\bresidential\s+only\b/gi },
  { id: 'neg:exclusively-residential', re: /\bexclusively\s+residential\b/gi },
  { id: 'neg:only-residential', re: /\bonly\s+(?:do\s+)?residential\b/gi },
  { id: 'neg:no-commercial', re: /\bno\s+commercial\b/gi },
];

/** A menu item or heading that is just "Commercial" / "Residential" (a service page of that name). */
export const TITLE_COMMERCIAL = /^commercial(?:\s+(?:paint(?:ing|ers?)|services?|work))?$/i;
export const TITLE_RESIDENTIAL = /^residential(?:\s+(?:paint(?:ing|ers?)|services?|work))?$/i;

/** Words in the company name that point to commercial work (D-25). */
export const NAME_WORDS: readonly PhraseDef[] = [
  { id: 'com:name-commercial', re: /\bcommercial\b/i },
  { id: 'com:name-industrial', re: /\bindustrial\b/i },
  { id: 'com:name-coatings', re: /\bcoatings?\b/i },
  { id: 'com:name-epoxy', re: /\bepoxy\b/i },
  { id: 'com:name-contracting-group', re: /\bcontracting\s+group\b/i },
];

export const CATEGORY_COMMERCIAL = /commercial/i;
export const CATEGORY_RESIDENTIAL = /house\s+painter|residential/i;

/** Pages whose address or heading says "this is a services page". */
export const SERVICE_PAGE = /services?|what[-\s]we[-\s]do|our[-\s]work|interior|exterior|residential|painting/i;

/** Weak supporting signal: an active New Jersey home-improvement registration. */
export const NJ_HIC_SIGNAL_ID = 'res:nj-hic-active';
export const NJ_HIC_SOURCE_URL = 'https://newjersey.mylicense.com/verification/';

export const MIN_VISIBLE_CHARS = 300;
