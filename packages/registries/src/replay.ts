import { last10, normaliseBusinessName, type GoldenReplayers } from '@pp/core';
import { matchLadder, type LadderCandidate } from './match/ladder';

type Obj = Record<string, unknown>;

const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

/**
 * A golden candidate row (the registry rows saved with one hand-checked company) as a ladder candidate. Accepts the
 * registry_records column names in camelCase or snake_case; names are normalised here when only the legal name is given.
 */
export function toLadderCandidate(raw: unknown, index: number): LadderCandidate {
  const o = (raw ?? {}) as Obj;
  const legal = text(pick(o, 'legalName', 'legal_name', 'full_name', 'name'));
  const n = legal ? normaliseBusinessName(legal) : null;
  const phone = text(pick(o, 'phoneLast10', 'phone_last10', 'phoneE164', 'phone_e164', 'phone'));
  const aliases = pick(o, 'aliases');
  return {
    key: text(pick(o, 'sourceKey', 'source_key', 'licenceNo', 'license_no', 'key')) ?? `candidate-${index}`,
    recordId: typeof pick(o, 'recordId', 'id') === 'number' ? (pick(o, 'recordId', 'id') as number) : index + 1,
    nameNorm: text(pick(o, 'nameNorm', 'name_norm')) ?? n?.norm ?? null,
    nameCore: text(pick(o, 'nameCore', 'name_core')) ?? n?.core ?? null,
    aliasNorms: Array.isArray(aliases) ? aliases.map(String) : (n?.aliases ?? []),
    city: text(pick(o, 'city', 'addr_city')),
    zip: text(pick(o, 'zip', 'addr_zipcode')),
    phoneLast10: phone ? (last10(phone) ?? (/^\d{10}$/.test(phone) ? phone : null)) : null,
    status: text(pick(o, 'status', 'license_status_name')),
    expiresOn: text(pick(o, 'expiresOn', 'expires_on', 'expiration_date')),
  };
}

export const replayers: Partial<GoldenReplayers> = {
  /** The pure ladder over a golden company's registry candidates: the chosen strong match, or the candidates. */
  registryMatch({ company, candidates }) {
    const cands = candidates.map(toLadderCandidate);
    const outcome = matchLadder(
      { name: company.name, city: company.city, zip: company.zip, phoneLast10: company.phoneE164 ? last10(company.phoneE164) : null },
      cands,
    );
    return outcome.records.map((r) => ({ sourceKey: r.key, strength: r.strength }));
  },
};
