import { describe, expect, it } from 'vitest';
import { isLimitedView } from '../src/blocks';
import type { FixturePage, PlaceSnapshot } from '../src/driver/types';
import { parseAddress, parsePlace } from '../src/parse/place';
import { fakeCard, fakePlace, limitedPlace, readFixture } from './helpers';

const place = (name: string): PlaceSnapshot => (readFixture<Extract<FixturePage, { kind: 'place' }>>(name)).place;

describe('parsePlace on live smoke place pages', () => {
  it('reads phone (E.164 from data-item-id), website, address parts, rating, reviews and category', () => {
    const p = parsePlace(place('smoke-place-1.json'));
    expect(p.loaded).toBe(true);
    expect(p.limitedView).toBe(false);
    expect(p.name).toBe('CertaPro Painters of Edison, NJ');
    expect(p.phone).toEqual({ value: '+17322046020', status: 'captured', snippet: 'Phone: (732) 204-6020' });
    expect(p.website.value).toBe(
      'https://certapro.com/edison/landing-page/residential-gbp/?utm_source=google&utm_medium=organic&utm_campaign=gbp_landing',
    );
    expect(p.address.full.value).toBe('2045 Woodbridge Ave, Edison, NJ 08817');
    expect(p.address.full.snippet).toBe('Address: 2045 Woodbridge Ave, Edison, NJ 08817');
    expect(p.address).toMatchObject({ street: '2045 Woodbridge Ave', city: 'Edison', state: 'NJ', zip: '08817' });
    expect(p.rating).toEqual({ value: 4.6, status: 'captured', snippet: '4.6 stars' });
    expect(p.reviewCount).toEqual({ value: 224, status: 'captured', snippet: '224 reviews' });
    expect(p.categories.value).toEqual(['Painter']);
  });

  it('a place opened by its CID link has no coordinates in its URL: "not read", the card keeps them', () => {
    const p = parsePlace(place('smoke-place-1.json'));
    expect(p.cid).toBe('14758101291504647232');
    expect(p.profileUrl).toBe('https://www.google.com/maps?cid=14758101291504647232');
    expect(p.lat.status).toBe('pending');
    expect(p.lng.status).toBe('pending');
  });

  it('a service-area business (no address button) has NULL address fields with status not_shown', () => {
    const p = parsePlace(place('smoke-place-2.json'));
    expect(p.loaded).toBe(true);
    expect(p.address.full).toEqual({ value: null, status: 'not_shown', snippet: null });
    expect(p.address).toMatchObject({ street: null, city: null, state: null, zip: null });
    expect(p.phone.status).toBe('captured');
  });

  it('still captures lat/lng from the URL when the page URL carries them', () => {
    const snap: PlaceSnapshot = {
      ...place('smoke-place-2.json'),
      url: 'https://www.google.com/maps/place/Five+Star/@40.5,-74.4,17z/data=!3m1!4b1!4m6!3m5!1s0x89c3b5d040cba255:0xcccf4eeecf5e3c40!8m2!3d40.5005798!4d-74.4003904!16s%2Fg%2F11bx5q9htj',
    };
    const p = parsePlace(snap);
    expect(p.address.full.status).toBe('not_shown');
    expect(p.lat).toMatchObject({ value: 40.5005798, status: 'captured' });
    expect(p.lng).toMatchObject({ value: -74.4003904, status: 'captured' });
    expect(p.lat.snippet).toBe('!3d40.5005798');
  });

  it('keeps an address with no street number whole and reads its parts', () => {
    const p = parsePlace(place('smoke-place-4.json'));
    expect(p.address.full.value).toBe('Stelton Rd, Piscataway, NJ 08854');
    expect(p.address).toMatchObject({ street: 'Stelton Rd', city: 'Piscataway', state: 'NJ', zip: '08854' });
    expect(p.permanentlyClosed).toMatchObject({ value: false, status: 'captured', snippet: 'Open 24 hours' });
  });

  it('reads the open/closed line: open is not permanently closed, a permanent closure is', () => {
    const open = parsePlace(place('smoke-place-3.json')).permanentlyClosed;
    expect(open.value).toBe(false);
    // Google writes a narrow no-break space before PM; the stored evidence snippet collapses it to a plain space.
    expect(open.snippet?.replace(/\s/g, ' ')).toBe('Open · Closes 6 PM');
    const gone = parsePlace({ ...place('smoke-place-3.json'), closedText: 'Permanently closed' });
    expect(gone.permanentlyClosed).toMatchObject({ value: true, status: 'captured' });
    const none = parsePlace({ ...place('smoke-place-3.json'), closedText: null });
    expect(none.permanentlyClosed).toEqual({ value: null, status: 'not_shown', snippet: null });
  });
});

describe('parseAddress', () => {
  it('reduces ZIP+4 to five digits and keeps the full text as shown', () => {
    const a = parseAddress('Address: 12357 Riata Trace Pkwy, Austin, TX 78727-3333 ');
    expect(a.zip).toBe('78727');
    expect(a.full.value).toBe('12357 Riata Trace Pkwy, Austin, TX 78727-3333');
    expect(a).toMatchObject({ street: '12357 Riata Trace Pkwy', city: 'Austin', state: 'TX' });
  });

  it('keeps a city-only address (no street) and leaves the street NULL', () => {
    expect(parseAddress('Address: San Diego, CA 92104')).toMatchObject({ street: null, city: 'San Diego', state: 'CA', zip: '92104' });
  });

  it('keeps accents as shown, composed', () => {
    const a = parseAddress('Address: 5 Calle José, San Juan, PR 00901');
    expect(a.full.value).toBe('5 Calle José, San Juan, PR 00901');
  });

  it('keeps text it cannot split, with the parts left empty, and treats a missing button as not_shown', () => {
    expect(parseAddress('Address: Somewhere odd')).toMatchObject({ street: null, city: null, state: null, zip: null, full: { status: 'captured' } });
    expect(parseAddress(null).full.status).toBe('not_shown');
    expect(parseAddress('   ').full.status).toBe('not_shown');
  });
});

describe('limited view is decided by structure', () => {
  it('a place with a heading but no review-count label and no reviews tab is limited: rating and reviews NULL', () => {
    const snap = place('derived-limited-view-place.json');
    const fx = readFixture<Extract<FixturePage, { kind: 'place' }>>('derived-limited-view-place.json');
    expect(fx.place.reviewCountAria).toBeNull();
    const p = parsePlace(fx.place);
    expect(snap.h1).toBeTruthy();
    expect(isLimitedView(fx.place)).toBe(true);
    expect(p.limitedView).toBe(true);
    expect(p.rating).toEqual({ value: null, status: 'limited_view', snippet: null });
    expect(p.reviewCount).toEqual({ value: null, status: 'limited_view', snippet: null });
    // The rest of the page is still read.
    expect(p.phone.status).toBe('captured');
    expect(p.address.full.status).toBe('captured');
  });

  it('a complete page whose body text contains "limited view" is NOT limited', () => {
    const fx = readFixture<Extract<FixturePage, { kind: 'place' }>>('derived-normal-page-mentions-limited-view.json');
    expect(fx.place.bodyHasLimitedViewText).toBe(true);
    const p = parsePlace(fx.place);
    expect(isLimitedView(fx.place)).toBe(false);
    expect(p.limitedView).toBe(false);
    expect(p.rating.status).toBe('captured');
    expect(p.reviewCount.status).toBe('captured');
  });

  it('is only limited when all three structure tests fail together', () => {
    const complete = fakePlace(1);
    expect(isLimitedView(complete)).toBe(false);
    expect(isLimitedView({ ...complete, reviewCountAria: null })).toBe(false); // reviews tab still there
    expect(isLimitedView({ ...complete, reviewCountAria: null, reviewsTabPresent: false })).toBe(true);
    expect(isLimitedView({ ...complete, reviewsTabPresent: false })).toBe(false); // count still there
    expect(isLimitedView({ ...limitedPlace(1), h1: null })).toBe(false); // nothing loaded: not limited, not a place
  });

  it('a page that did not load (no heading) is not loaded and captures nothing as 0', () => {
    const p = parsePlace({ ...limitedPlace(2), h1: null });
    expect(p.loaded).toBe(false);
    expect(p.rating.value).toBeNull();
    expect(p.reviewCount.value).toBeNull();
    expect(p.address.full.status).toBe('parse_failed');
  });

  it('a card and a place for the same business agree on the CID', () => {
    const card = fakeCard(7);
    expect(parsePlace({ ...fakePlace(7), url: card.href }).cid).toMatch(/^\d+$/);
  });
});
