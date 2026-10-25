# Maps test fixtures: where every file comes from

Public business listing data only (names, categories, phone numbers and websites that Google Maps shows to any
visitor). No client data, nothing from the owner's Downloads folder. Tests read these files offline; nothing here is
fetched at test time.

| File | Origin | Notes |
| --- | --- | --- |
| `sd-house-painter-cards.json` | **probe copy** | The 82 San Diego cards ("house painter in San Diego, CA") captured by the orchestrator's probe on 2026-10-25 (`D:\ClaudeCode\_Scratch\pp-probe\out\sd\cards.json`). Card snapshot format `{name, href, ratingAria, text}` (no `websiteHref`: the probe did not read it). |
| `smoke-1-search.json` | **live smoke, 2026-10-26** | "house painter 08817", `zip_text` form, headless Chromium through `pp maps smoke`. 116 cards, end of list not seen (see 01-02-SUMMARY "Query form decision"). Includes `websiteHref` on 94 cards. |
| `smoke-2-search.json` | **live smoke, 2026-10-26** | "house painter" at the 08817 centroid, `viewport` form (`/@40.514655,-74.393104,13z`). 77 cards, end of list not seen. |
| `smoke-3-search.json` | **live smoke, 2026-10-26** | "house painter 78701" (Austin), `zip_text`. 120 cards (the cap), end of list seen. |
| `smoke-place-1.json` | **live smoke** | Place page of the first card of smoke 1 (CertaPro Painters of Edison), opened by its `?cid=` profile link + `hl=en&gl=us`. Complete page. |
| `smoke-place-2.json` | **live smoke** | Five Star Painting of Edison & Red Bank: a **service-area business** (no address button, `addressAria` null). |
| `smoke-place-3.json` | **live smoke** | Jersey Pro Painters (smoke 2, first card). Complete page. |
| `smoke-place-4.json` | **live smoke** | Color Chameleon Paint Company (smoke 2): address without a street number ("Stelton Rd, Piscataway, NJ 08854"). |
| `derived-limited-view-place.json` | **derived** from `smoke-place-1.json` | `reviewCountAria` and `ratingAria` set to null and `reviewsTabPresent` false: what a limited-view place page looks like (name heading, no review count, no reviews tab). |
| `derived-normal-page-mentions-limited-view.json` | **derived** from `smoke-place-1.json` | `bodyHasLimitedViewText` forced true on a complete page. (The live pages already carry the words "You're seeing a limited view of Google Maps. See more" at the foot of the results list and `bodyHasLimitedViewText: true` on complete place pages, which is why limited view is decided by structure, never by text.) |
| `synthetic-sorry.json` | **synthetic** (hand-written) | Landing on `https://www.google.com/sorry/index…`, HTTP 429. |
| `synthetic-captcha.json` | **synthetic** | A page with a reCAPTCHA iframe/form and no results. |
| `synthetic-unusual-traffic.json` | **synthetic** | A page that says "unusual traffic" and has neither results feed nor place panel. |

File format: the smoke files are exactly the `FixturePage` shape `FixtureDriver` replays (`kind: "search" | "place" | "other"`).

## What the live smoke taught us (and the code now does)

- A place opened by its CID link keeps the `?cid=…` URL: it carries **no** place id or coordinates. Coordinates come
  from the card (`!3d…!4d…`); the place parser reports the URL coordinates as "not read" and never overwrites the card's.
- The hours row has no `data-item-id`. The open/closed status line is read from the place panel text; `Permanently
  closed` is only recognised as a whole line. **No permanently-closed place was seen live**, so that marker is
  unverified against a real page; the card's own status line is the primary source.
- The end-of-list text ("You've reached the end of the list.") sits inside the feed element.
- Cards without a Website button have `websiteHref: null`; with it, the link is the business site with Google's tracking
  parameters, stored exactly as shown.
