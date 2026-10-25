import { isSourceEnabled, personNameKey, titleCaseName, type Fetcher, type PpConfig } from '@pp/core';
import { agentIsAlsoOfficer, isCorporateAgent } from './agents';

export const COMPTROLLER_URL = 'https://comptroller.texas.gov/data-search/franchise-tax';

export class TxPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TxPayloadError';
  }
}

export interface TxOfficer {
  /** "First Last" as shown in the report (middle names and initials dropped). */
  display: string;
  /** The name as the register gives it (FIRST MIDDLE LAST). */
  raw: string;
  /** Every title the person holds, in the register's order ("PRESIDENT", "DIRECTOR"). */
  titles: string[];
  /** The title shown in the evidence: the most owner-like one. */
  title: string;
  /** This officer is also the registered agent (a person, not an agent service). */
  alsoRegisteredAgent: boolean;
  activeYear: string | null;
}

export interface TxOfficerResult {
  /** 'disabled' = the tx_comptroller switch is off: NO request was made. */
  status: 'disabled' | 'ok';
  taxpayerId: string;
  name: string | null;
  sosStatus: string | null;
  registeredAgent: string | null;
  /** The registered agent is a paid agent service (never an owner). */
  registeredAgentIsService: boolean;
  officers: TxOfficer[];
  sourceUrl: string | null;
}

const TITLE_ORDER = ['PRESIDENT', 'CEO', 'CHIEF EXECUTIVE', 'OWNER', 'MANAGER', 'MANAGING', 'MEMBER', 'VICE', 'DIRECTOR', 'SECRETARY', 'TREASURER'];

function titleRank(t: string): number {
  const i = TITLE_ORDER.findIndex((w) => t.toUpperCase().includes(w));
  return i < 0 ? TITLE_ORDER.length : i;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

/** "DIMITRI C ALEXANDRIS" -> "Dimitri Alexandris" (first and last word only). */
export function officerDisplay(raw: string): string {
  const tokens = raw
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !/^(JR|SR|II|III|IV)$/i.test(t));
  if (tokens.length === 0) return titleCaseName(raw);
  if (tokens.length === 1) return titleCaseName(tokens[0] as string);
  return titleCaseName(`${tokens[0]} ${tokens[tokens.length - 1]}`);
}

/**
 * Validates and reads the Comptroller franchise-tax detail JSON (SOURCES-PROBE §3a): `officerInfo[]` with
 * AGNT_NM / AGNT_TITL_TX / AGNT_ACTV_YR, the registered agent and the SOS status. Officer street addresses
 * are never read. Corporate agent services are ignored; a person agent counts only when also an officer.
 */
export function parseComptrollerDetail(json: unknown, taxpayerId: string): Omit<TxOfficerResult, 'status' | 'sourceUrl'> {
  const root = json as { success?: unknown; data?: unknown } | null;
  if (!root || typeof root !== 'object' || root.success !== true || !root.data || typeof root.data !== 'object') {
    throw new TxPayloadError('Comptroller answer is not {success: true, data: {...}}');
  }
  const data = root.data as Record<string, unknown>;
  const info = data.officerInfo;
  if (info !== undefined && info !== null && !Array.isArray(info)) throw new TxPayloadError('officerInfo is not a list');

  const byPerson = new Map<string, { raw: string; titles: string[]; year: string | null }>();
  for (const item of (info ?? []) as unknown[]) {
    const o = item as Record<string, unknown>;
    const raw = str(o?.AGNT_NM);
    if (!raw) continue;
    const key = personNameKey(raw);
    if (!key) continue;
    const title = str(o.AGNT_TITL_TX);
    const entry = byPerson.get(key) ?? { raw, titles: [], year: str(o.AGNT_ACTV_YR) };
    if (title && !entry.titles.includes(title)) entry.titles.push(title);
    byPerson.set(key, entry);
  }

  const agent = str(data.registeredAgentName);
  const officersRaw = [...byPerson.values()].map((p) => ({ name: p.raw }));
  const officers: TxOfficer[] = [...byPerson.values()].map((p) => ({
    display: officerDisplay(p.raw),
    raw: p.raw,
    titles: p.titles,
    title: [...p.titles].sort((a, b) => titleRank(a) - titleRank(b))[0] ?? 'OFFICER',
    alsoRegisteredAgent: agentIsAlsoOfficer(agent, officersRaw) && personNameKey(agent ?? '') === personNameKey(p.raw),
    activeYear: p.year,
  }));
  return {
    taxpayerId,
    name: str(data.name),
    sosStatus: str(data.sosRegistrationStatus),
    registeredAgent: agent,
    registeredAgentIsService: isCorporateAgent(agent),
    officers,
  };
}

/**
 * Officers and titles of one Texas taxpayer (D-21). The tx_comptroller switch is OFF by default (the
 * Comptroller's robots.txt disallows /data-search/, an owner decision): when it is off this returns
 * 'disabled' BEFORE any request is made. The fetcher enforces robots.txt unless the owner sets robots
 * 'override' together with enabled true.
 */
export async function fetchTxOfficers(
  fetcher: Fetcher,
  config: PpConfig,
  taxpayerId: string,
  opts: { offline?: boolean; runId?: number | null } = {},
): Promise<TxOfficerResult> {
  if (!isSourceEnabled(config, 'tx_comptroller')) {
    return { status: 'disabled', taxpayerId, name: null, sosStatus: null, registeredAgent: null, registeredAgentIsService: false, officers: [], sourceUrl: null };
  }
  if (!/^\d{9,11}$/.test(taxpayerId)) throw new TxPayloadError(`taxpayer id "${taxpayerId}" is not 9-11 digits`);
  const url = `${COMPTROLLER_URL}/${taxpayerId}`;
  const res = await fetcher.get(url, { source: 'tx_comptroller', cache: 'use', offline: opts.offline, runId: opts.runId ?? null });
  if (res.status !== 200) throw new TxPayloadError(`Comptroller answered HTTP ${res.status}`);
  let json: unknown;
  try {
    json = JSON.parse(res.text());
  } catch {
    throw new TxPayloadError('Comptroller answer is not JSON');
  }
  return { status: 'ok', sourceUrl: res.finalUrl, ...parseComptrollerDetail(json, taxpayerId) };
}
