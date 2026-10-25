import { registrableDomain, type CompanyRef, type Db, type RegistryMatchInput, type StateCode } from '@pp/core';

/**
 * The stage input for every company of a run: the merged company, its primary listing's address, phone
 * and website, the company-published emails already found, and the 13VH numbers read from its website.
 */
export async function loadRunInputs(db: Db, runId: number): Promise<RegistryMatchInput[]> {
  const res = await db.$client.query(
    `SELECT c.id, c.display_name, c.state AS company_state, l.city, l.zip, l.street, l.website_url, l.phone_e164,
            COALESCE(l.categories, '{}') AS categories, l.state AS listing_state
       FROM companies c
       LEFT JOIN listings l ON l.id = c.primary_listing_id
      WHERE c.run_id = $1
      ORDER BY c.id`,
    [runId],
  );
  const out: RegistryMatchInput[] = [];
  for (const r of res.rows) {
    const state = (r.company_state ?? r.listing_state) as StateCode | null;
    if (state !== 'NJ' && state !== 'TX' && state !== 'CA') continue;
    const company: CompanyRef = {
      companyId: r.id,
      name: r.display_name,
      state,
      city: r.city ?? null,
      zip: r.zip ?? null,
      street: r.street ?? null,
      websiteUrl: r.website_url ?? null,
      phoneE164: r.phone_e164 ?? null,
      categories: r.categories ?? [],
    };
    const ev = await db.$client.query(
      `SELECT field, value FROM evidence
        WHERE company_id = $1 AND field IN ('email', 'nj_hic_number') AND status = 'accepted'
        ORDER BY id`,
      [r.id],
    );
    const emails = ev.rows.filter((e: { field: string }) => e.field === 'email').map((e: { value: string }) => e.value);
    const licenceNumbers = ev.rows
      .filter((e: { field: string }) => e.field === 'nj_hic_number')
      .map((e: { value: string }) => e.value);
    const dom = company.websiteUrl ? registrableDomain(company.websiteUrl) : null;
    out.push({
      company,
      emails,
      licenceNumbers,
      websiteDomain: dom && !dom.sharedHost ? dom.domain : null,
    });
  }
  return out;
}
