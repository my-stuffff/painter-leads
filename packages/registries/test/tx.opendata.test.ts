import { describe, expect, it } from 'vitest';
import { OfflineCacheMissError } from '@pp/core';
import { buildTxQueryUrl, buildTxWhere, parseTxTaxpayers, queryTxTaxpayers, soqlLiteral, txStatus } from '../src/tx/opendata';
import { distinctiveToken } from '../src/tx/match';
import { TxPayloadError } from '../src/tx/comptroller';
import { fixture, makeFetcher, testConfig } from './helpers';

const HOST = 'https://data.texas.gov';

describe('SoQL builder', () => {
  it('zip 78701 + token "O\'NEIL" gives the where clause with quotes doubled (API field names)', () => {
    expect(buildTxWhere({ zip: '78701', nameToken: "O'NEIL" })).toBe("taxpayer_zip='78701' AND upper(taxpayer_name) like '%O''NEIL%'");
  });

  it('upper-cases the token, strips LIKE wildcards and backslashes, and refuses a bad ZIP or a tiny token', () => {
    expect(buildTxWhere({ zip: '78701-1234', nameToken: 'hill_country%' })).toBe("taxpayer_zip='78701' AND upper(taxpayer_name) like '%HILLCOUNTRY%'");
    expect(soqlLiteral("a'b\\c%d_e")).toBe("a''bcde");
    expect(() => buildTxWhere({ zip: 'abc', nameToken: 'PAINT' })).toThrow(TxPayloadError);
    expect(() => buildTxWhere({ zip: '78701', nameToken: 'A' })).toThrow(/too short/);
  });

  it('the request goes to data.texas.gov (covered by the *.texas.gov DNS override) with $where and $limit', () => {
    const url = new URL(buildTxQueryUrl({ zip: '78701', nameToken: 'PAINT' }));
    expect(url.origin).toBe(HOST);
    expect(url.pathname).toBe('/resource/9cir-efmm.json');
    expect(url.searchParams.get('$where')).toBe("taxpayer_zip='78701' AND upper(taxpayer_name) like '%PAINT%'");
    expect(url.searchParams.get('$limit')).toBe('50');
    const overrides = testConfig().fetch.dnsOverrides;
    expect(Object.keys(overrides)).toContain('*.texas.gov');
    expect(url.hostname.endsWith('.texas.gov')).toBe(true);
  });
});

describe('queryTxTaxpayers', () => {
  const json = fixture('tx', 'opendata-78665-hill-country.json');

  it('reads and validates the rows; a second identical query is served from the cache', async () => {
    const { fetcher, agent, calls } = makeFetcher();
    const q = { zip: '78665', nameToken: 'HILL COUNTRY' };
    const path = buildTxQueryUrl(q).replace(HOST, '');
    agent.get(HOST).intercept({ path, method: 'GET' }).reply(200, json, { headers: { 'content-type': 'application/json' } });
    const first = await queryTxTaxpayers(fetcher, q);
    expect(first.rows).toHaveLength(5);
    const painting = first.rows.find((r) => r.taxpayer_name === 'HILL COUNTRY PAINTING LLC');
    expect(painting).toMatchObject({ taxpayer_number: '32072442869', taxpayer_zip: '78665', taxpayer_city: 'ROUND ROCK' });
    await queryTxTaxpayers(fetcher, q);
    expect(calls()).toHaveLength(1);
  });

  it('offline replays only what is cached', async () => {
    const { fetcher } = makeFetcher();
    await expect(queryTxTaxpayers(fetcher, { zip: '78665', nameToken: 'ZZZZ' }, { offline: true })).rejects.toBeInstanceOf(OfflineCacheMissError);
  });

  it('refuses a payload that is not a list of taxpayer rows', async () => {
    expect(() => parseTxTaxpayers({ error: true })).toThrow(TxPayloadError);
    expect(() => parseTxTaxpayers([{ taxpayer_name: 'NO NUMBER LLC' }])).toThrow(/valid number or name/);
    expect(() => parseTxTaxpayers([{ taxpayer_number: '123', taxpayer_name: 'SHORT NUMBER' }])).toThrow();
    expect(parseTxTaxpayers([])).toEqual([]);
  });

  it('an HTTP error is an error, not "no entity"', async () => {
    const { fetcher, agent } = makeFetcher();
    const q = { zip: '78701', nameToken: 'PAINT' };
    agent.get(HOST).intercept({ path: buildTxQueryUrl(q).replace(HOST, ''), method: 'GET' }).reply(503, 'busy');
    await expect(queryTxTaxpayers(fetcher, q)).rejects.toThrow(/HTTP 503/);
  });
});

describe('status and search word', () => {
  it('Active only when the right to transact is A', () => {
    expect(txStatus({ sos_status_code: 'A', right_to_transact_business_code: 'A' })).toBe('Active');
    expect(txStatus({ sos_status_code: 'F', right_to_transact_business_code: 'N' })).toContain('Not active');
  });

  it('picks the longest word that is not a generic trade word', () => {
    expect(distinctiveToken('Hill Country Painting LLC')).toBe('COUNTRY');
    expect(distinctiveToken('Barton Springs Painting')).toBe('SPRINGS');
    expect(distinctiveToken('A1 Painting')).toBeNull();
    expect(distinctiveToken("O'Neil Painters Inc")).toBe('ONEIL');
  });
});
