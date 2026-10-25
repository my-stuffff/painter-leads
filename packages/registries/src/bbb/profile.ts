import * as cheerio from 'cheerio';

export interface BbbPerson {
  /** givenName + familyName, honorific dropped ("John Catapano"). */
  name: string;
  givenName: string | null;
  familyName: string | null;
  jobTitle: string | null;
  from: 'json-ld' | 'business-management';
}

export interface BbbProfile {
  url: string;
  name: string | null;
  telephone: string | null;
  street: string | null;
  city: string | null;
  region: string | null;
  zip: string | null;
  website: string | null;
  people: BbbPerson[];
  /** Where the people came from: the JSON-LD employee list, the "Business Management:" line, or nowhere. */
  peopleSource: 'json-ld' | 'business-management' | 'none';
}

const asArray = <T>(v: T | T[] | null | undefined): T[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

function flatten(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const n of node) flatten(n, out);
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    out.push(o);
    if (o['@graph']) flatten(o['@graph'], out);
  }
}

function isBusiness(o: Record<string, unknown>): boolean {
  const types = asArray(o['@type'] as string | string[] | undefined).map(String);
  return types.some((t) => /LocalBusiness|Business|Organization|Contractor|Painter/i.test(t));
}

const PREFIX = /^(?:mr|mrs|ms|miss|mx|dr)\.?\s+/i;

/** `Business Management: Mr. John Catapano, Owner` -> [{ John Catapano, Owner }]. */
export function parseManagementLine(text: string): BbbPerson[] {
  const m = /Business Management:\s*(.{0,240}?)(?=\s(?:Principal Contacts?|Customer Contact|Business Category|Contact Information|Business Started|Years in Business|Type of Entity|Accredited)\b|$)/i.exec(
    text,
  );
  if (!m) return [];
  const people: BbbPerson[] = [];
  for (const chunk of (m[1] as string).split(/;|\s{2,}/)) {
    const c = chunk.replace(PREFIX, '').trim();
    const mm = /^([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){1,3}),\s*([A-Za-z][A-Za-z /&-]{1,40})$/.exec(c);
    if (!mm) continue;
    const words = (mm[1] as string).split(/\s+/);
    people.push({
      name: mm[1] as string,
      givenName: words[0] ?? null,
      familyName: words[words.length - 1] ?? null,
      jobTitle: (mm[2] as string).trim(),
      from: 'business-management',
    });
  }
  return people;
}

/** Reads a BBB business profile: JSON-LD LocalBusiness (name, phone, address, website, employee[]), else the text line. */
export function parseBbbProfile(html: string, url: string): BbbProfile {
  const $ = cheerio.load(html);
  const nodes: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      flatten(JSON.parse($(el).contents().text()), nodes);
    } catch {
      /* a broken JSON-LD block is skipped */
    }
  });
  const biz = nodes.find((o) => isBusiness(o) && (o.employee !== undefined || o.telephone !== undefined || o.name !== undefined));
  const address = (biz?.address ?? null) as Record<string, unknown> | null;

  const people: BbbPerson[] = [];
  for (const e of asArray(biz?.employee as unknown)) {
    const o = e as Record<string, unknown>;
    const given = str(o.givenName);
    const family = str(o.familyName);
    const full = given && family ? `${given} ${family}` : (str(o.name)?.replace(PREFIX, '') ?? null);
    if (!full) continue;
    people.push({ name: full, givenName: given, familyName: family, jobTitle: str(o.jobTitle), from: 'json-ld' });
  }

  let peopleSource: BbbProfile['peopleSource'] = people.length > 0 ? 'json-ld' : 'none';
  if (people.length === 0) {
    $('script, style').remove();
    const fromText = parseManagementLine($('body').text().replace(/\s+/g, ' '));
    if (fromText.length > 0) {
      people.push(...fromText);
      peopleSource = 'business-management';
    }
  }

  const sameAs = asArray(biz?.sameAs as string | string[] | undefined).map(String);
  const visitLink = $('a')
    .filter((_, a) => /visit website/i.test($(a).text()))
    .first()
    .attr('href');
  const ldUrl = str(biz?.url);
  const website =
    (visitLink && !/bbb.org/i.test(visitLink) ? visitLink : null) ??
    (ldUrl && !/bbb.org/i.test(ldUrl) ? ldUrl : null) ??
    sameAs.find((u) => !/facebook|instagram|youtube|twitter|linkedin|bbb.org/i.test(u)) ??
    null;
  return {
    url,
    name: str(biz?.name),
    telephone: str(biz?.telephone),
    street: str(address?.streetAddress),
    city: str(address?.addressLocality),
    region: str(address?.addressRegion),
    zip: str(address?.postalCode),
    website,
    people,
    peopleSource,
  };
}
