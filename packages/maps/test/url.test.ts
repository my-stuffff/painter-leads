import { describe, expect, it } from 'vitest';
import { parsePlaceUrl, profileLink, withLocale } from '../src/parse/url';
import { buildSearchUrl, buildTextSearchUrl } from '../src/query';

const HREF =
  'https://www.google.com/maps/place/The+Painting+Company+San+Diego/data=!4m7!3m6!1s0x80dbf959fc5c18d3:0x2452b5fb1a89f9b9!8m2!3d33.0172666!4d-116.8460104!16s%2Fg%2F11gmz6jxrj!19sChIJ0xhc_Fn524ARufmJGvu1UiQ';

describe('parsePlaceUrl', () => {
  it('reads place id, CID hex, CID decimal and full-precision coordinates', () => {
    const p = parsePlaceUrl(HREF);
    expect(p.placeId).toBe('ChIJ0xhc_Fn524ARufmJGvu1UiQ');
    expect(p.cidHex).toBe('0x80dbf959fc5c18d3:0x2452b5fb1a89f9b9');
    expect(p.cid).toBe(BigInt('0x2452b5fb1a89f9b9').toString());
    expect(p.cid).toBe('2617354423542348217');
    expect(p.lat).toBe(33.0172666);
    expect(p.lng).toBe(-116.8460104);
    expect(p.latText).toBe('33.0172666');
    expect(p.lngText).toBe('-116.8460104');
  });

  it('returns null for pieces the URL does not carry', () => {
    const p = parsePlaceUrl('https://www.google.com/maps/place/Somewhere');
    expect(p).toMatchObject({ placeId: null, cid: null, lat: null, lng: null });
  });

  it('builds the CID profile link, falling back to the href without query', () => {
    expect(profileLink(HREF)).toBe('https://www.google.com/maps?cid=2617354423542348217');
    expect(profileLink('https://www.google.com/maps/place/Somewhere?hl=en#x')).toBe('https://www.google.com/maps/place/Somewhere');
  });

  it('adds hl=en&gl=us to a place link', () => {
    expect(withLocale('https://www.google.com/maps?cid=1')).toBe('https://www.google.com/maps?cid=1&hl=en&gl=us');
  });
});

describe('buildSearchUrl', () => {
  it('zip_text puts the term and ZIP in the path', () => {
    expect(buildSearchUrl({ term: 'house painter', zip: '08817' }, 'zip_text')).toBe(
      'https://www.google.com/maps/search/house%20painter%2008817/?hl=en&gl=us',
    );
  });

  it('viewport puts the centroid and zoom after the term', () => {
    expect(buildSearchUrl({ term: 'house painter', zip: '08817', centerLat: 40.514655, centerLng: -74.393104 }, 'viewport')).toBe(
      'https://www.google.com/maps/search/house%20painter/@40.514655,-74.393104,13z?hl=en&gl=us',
    );
    expect(() => buildSearchUrl({ term: 'x', zip: '1' }, 'viewport')).toThrow(/centerLat/);
  });

  it('encodes a free-text query for the datacentre test', () => {
    expect(buildTextSearchUrl('house painter 78701')).toBe('https://www.google.com/maps/search/house%20painter%2078701/?hl=en&gl=us');
  });
});
