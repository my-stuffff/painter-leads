import { personNameKey } from '@pp/core';

const CORPORATE_WORDS = ['CORPORATION', 'AGENTS', 'REGISTERED', 'SERVICES', 'INC', 'LLC', 'CORP', 'COMPANY'];

/**
 * A registered agent that is a paid agent service, not a person ("UNITED STATES CORPORATION AGENTS, INC.",
 * "REGISTERED AGENTS INC"). Such an agent is never an owner.
 */
export function isCorporateAgent(name: string | null | undefined): boolean {
  const words = (name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.some((w) => CORPORATE_WORDS.includes(w));
}

/**
 * A person registered agent counts only when the same person is also an officer ("DIMITRI ALEXANDRIS" agent
 * and "DIMITRI C ALEXANDRIS" president): then the officer row already carries the owner, the agent adds nothing.
 */
export function agentIsAlsoOfficer(agent: string | null | undefined, officers: { name: string }[]): boolean {
  if (!agent || isCorporateAgent(agent)) return false;
  const key = personNameKey(agent);
  return key.length > 0 && officers.some((o) => personNameKey(o.name) === key);
}
