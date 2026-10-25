import { describe, expect, it } from 'vitest';
import { RobotsDisallowedError } from '@pp/core';
import { agentIsAlsoOfficer, isCorporateAgent } from '../src/tx/agents';
import { fetchTxOfficers, officerDisplay, parseComptrollerDetail, TxPayloadError } from '../src/tx/comptroller';
import { fixture, makeFetcher, testConfig } from './helpers';

const HOST = 'https://comptroller.texas.gov';
const JSON_HEADERS = { headers: { 'content-type': 'application/json' } };
const enabled = () => testConfig({ tx_comptroller: { enabled: true } });

describe('Comptroller adapter while the switch is OFF (the default)', () => {
  it("returns 'disabled' and the mock agent records ZERO requests to comptroller.texas.gov", async () => {
    const config = testConfig(); // testConfig starts tx_comptroller at its code default, off
    expect(config.sources.tx_comptroller.enabled).toBe(false);
    const { fetcher, calls } = makeFetcher(config);
    const r = await fetchTxOfficers(fetcher, config, '32066330906');
    expect(r.status).toBe('disabled');
    expect(r.officers).toEqual([]);
    expect(calls().filter((c) => c.includes('comptroller.texas.gov'))).toEqual([]);
    expect(calls()).toEqual([]);
  });
});

describe('Comptroller adapter with the switch on (test config only)', () => {
  it('reads Alexandris Painting: Dimitri Alexandris, title PRESIDENT, DIRECTOR kept as a second title, also the agent', async () => {
    const config = enabled();
    const { fetcher, agent } = makeFetcher(config);
    agent.get(HOST).intercept({ path: '/data-search/franchise-tax/32066330906', method: 'GET' }).reply(200, fixture('tx', 'comptroller-alexandris.json'), JSON_HEADERS);
    const r = await fetchTxOfficers(fetcher, config, '32066330906');
    expect(r.status).toBe('ok');
    expect(r.name).toBe('ALEXANDRIS PAINTING COMPANY, LLC');
    expect(r.sosStatus).toBe('ACTIVE');
    expect(r.officers).toHaveLength(1);
    expect(r.officers[0]).toMatchObject({ display: 'Dimitri Alexandris', title: 'PRESIDENT', titles: ['PRESIDENT', 'DIRECTOR'], alsoRegisteredAgent: true, activeYear: '2024' });
    expect(r.sourceUrl).toBe(`${HOST}/data-search/franchise-tax/32066330906`);
  });

  it('reads Hill Country Painting: three officers, the corporate registered agent is ignored', async () => {
    const json = JSON.parse(fixture('tx', 'comptroller-hill-country.json'));
    const r = parseComptrollerDetail(json, '32072442869');
    expect(r.officers.map((o) => o.display)).toEqual(['Forrest Jensen', 'Josh Cross', 'Justin Carter']);
    expect(r.officers.every((o) => o.titles.includes('DIRECTOR') && o.titles.includes('MEMBER'))).toBe(true);
    expect(r.registeredAgent).toBe('UNITED STATES CORPORATION AGENTS, INC.');
    expect(r.registeredAgentIsService).toBe(true);
    expect(r.officers.some((o) => o.alsoRegisteredAgent)).toBe(false);
    expect(r.officers.some((o) => /AGENTS/i.test(o.display))).toBe(false);
  });

  it('an ended entity with no officers and a person agent who is not an officer gives no owner', () => {
    const json = JSON.parse(fixture('tx', 'comptroller-hill-country-repair.json'));
    const r = parseComptrollerDetail(json, '32096453066');
    expect(r.officers).toEqual([]);
    expect(r.registeredAgent).toBe('ROSA EDIS REYES MARROQUIN');
    expect(r.registeredAgentIsService).toBe(false);
  });

  it('with robots.txt respected (the real file disallows /data-search/) nothing is fetched from the API path', async () => {
    const config = testConfig({ tx_comptroller: { enabled: true, robots: 'respect' } });
    const { fetcher, agent, calls } = makeFetcher(config);
    agent.get(HOST).intercept({ path: '/robots.txt', method: 'GET' }).reply(200, fixture('tx', 'comptroller-robots.txt'), { headers: { 'content-type': 'text/plain' } });
    await expect(fetchTxOfficers(fetcher, config, '32066330906')).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(calls().filter((c) => c.includes('/data-search/'))).toEqual([]);
  });

  it('a bad taxpayer id, an HTTP error and a non-JSON answer are errors', async () => {
    const config = enabled();
    const { fetcher, agent } = makeFetcher(config);
    await expect(fetchTxOfficers(fetcher, config, 'abc')).rejects.toBeInstanceOf(TxPayloadError);
    agent.get(HOST).intercept({ path: '/data-search/franchise-tax/32066330906', method: 'GET' }).reply(500, 'oops');
    await expect(fetchTxOfficers(fetcher, config, '32066330906')).rejects.toThrow(/HTTP 500/);
    agent.get(HOST).intercept({ path: '/data-search/franchise-tax/32066330907', method: 'GET' }).reply(200, '<html>nope</html>');
    await expect(fetchTxOfficers(fetcher, config, '32066330907')).rejects.toThrow(/not JSON/);
    expect(() => parseComptrollerDetail({ success: false }, '1')).toThrow(TxPayloadError);
    expect(() => parseComptrollerDetail({ success: true, data: { officerInfo: 'x' } }, '1')).toThrow(/not a list/);
  });
});

describe('registered agents', () => {
  it('corporate agent services are recognised; people are not', () => {
    for (const name of ['UNITED STATES CORPORATION AGENTS, INC.', 'REGISTERED AGENTS INC', 'CT CORPORATION SYSTEM', 'LEGALZOOM.COM LLC', 'NORTHWEST REGISTERED AGENT SERVICES']) {
      expect(isCorporateAgent(name), name).toBe(true);
    }
    for (const name of ['DIMITRI ALEXANDRIS', 'ROSA EDIS REYES MARROQUIN', null, '']) expect(isCorporateAgent(name as string)).toBe(false);
  });

  it('a person agent counts only when the same person is also an officer (middle initial ignored)', () => {
    const officers = [{ name: 'DIMITRI C ALEXANDRIS' }];
    expect(agentIsAlsoOfficer('DIMITRI ALEXANDRIS', officers)).toBe(true);
    expect(agentIsAlsoOfficer('ROSA REYES', officers)).toBe(false);
    expect(agentIsAlsoOfficer('UNITED STATES CORPORATION AGENTS, INC.', officers)).toBe(false);
    expect(agentIsAlsoOfficer(null, officers)).toBe(false);
  });

  it('officer names become First Last without middle names or initials', () => {
    expect(officerDisplay('DIMITRI C ALEXANDRIS')).toBe('Dimitri Alexandris');
    expect(officerDisplay('MARY ANN O\'BRIEN')).toBe("Mary O'Brien");
    expect(officerDisplay('JOHN SMITH JR')).toBe('John Smith');
    expect(officerDisplay('MADONNA')).toBe('Madonna');
  });
});
