---
phase: 01-pilot
plan: 02
subsystem: scraping
tags: [google-maps, playwright, scraping, resume, block-detection, fixtures]

requires:
  - phase: 01-pilot/01
    provides: core launcher, evidence store, stage contracts, schema, geo data
provides:
  - packages/maps - own headless-Chromium Maps scraper (card + place parsers, block / limited-view detection)
  - discover and detail stages (resumable, throttled, daily-capped, every navigation in request_log)
  - five commands - pp maps smoke | discover | detail | status | datacentre-test
  - replayers.mapsCard for the golden suite
affects: [01-05-pipeline, 01-06-pilot-run]

actuals:
  tokens: unmeasured
  tasks: 3
  commits: 3

key-files:
  created: [packages/maps/**]
  modified: [packages/maps/package.json]

key-decisions:
  - "Query form: zip_text (see Query form decision)"
  - "Limited view is decided by structure only; the live pages carry the words 'limited view' on every complete page"
  - "A place opened by its CID link keeps that URL (no coordinates, no place id): coordinates stay the card's"

requirements-completed: [DISC-02, DISC-03, DISC-04]

completed: 2026-10-26
---

# Phase 1 Plan 02: Google Maps scraper Summary

**`packages/maps` reads Maps with our own headless Chromium, stores every value with its source, stops on a block without losing work, and resumes from the last unfinished search. All 110 tests in this package (14 files) are offline; three live smoke searches proved the selectors.**

## Commits

| Task | Commit | What |
| --- | --- | --- |
| 1 Tracer | 26aac77 | the whole package (drivers, parsers, blocks, persist, discover, detail, throttle, cap, status, smoke, datacentre, replay, commands), live fixtures, card/url/discover tests |
| 2 Place pages | e6a044f | place parser tests, limited-view and block fixtures, detail.db tests |
| 3 Queue | b0fa2bd | resume, cap, throttle, datacentre, replay, smoke-budget and status tests |

Deviation: the source for Tasks 2 and 3 (detail, throttle, cap, commands, datacentre, replay) was written in the Task 1 pass
because `index.ts` registers all of it; Tasks 2 and 3 added their tests, fixtures and the fixes the tests found.

## Query form decision

Smoke budget used: **3 of 3 searches, 4 of 6 place pages** (`D:\ClaudeCode\Painter-Promotions\pp-data\maps\smoke-budget.json`, worker `maps`).

| Smoke | Query | Landed URL | Cards | Cards with coordinates in area or neighbour ring | In Edison/Austin ZCTAs | In the target ZIP |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `house painter 08817`, **zip_text** | `https://www.google.com/maps/search/house%20painter%2008817/?hl=en&gl=us` (no redirect) | 116 (end text not seen) | 55 / 116 = **47%** | 31 (27%) | 16 |
| 2 | `house painter` at 08817 centroid, **viewport** | `https://www.google.com/maps/search/house%20painter/@40.514655,-74.393104,13z?hl=en&gl=us` | 77 (end text not seen) | 43 / 77 = **56%** | 14 (18%) | 4 |
| 3 | `house painter 78701`, zip_text (Austin) | `https://www.google.com/maps/search/house%20painter%2078701/?hl=en&gl=us` | 120 (cap), end text seen | 100 / 119 = **84%** | 84 (71%) | 14 |

"Area or neighbour ring" = the card's `!3d/!4d` point falls inside `data/geo/pilot-zcta.geojson` (area ZCTAs + neighbour ring).
**Decision: `zip_text`** (`QUERY_FORM` in `src/query.ts`). Neither Edison form reached the plan's 60% bar, so smoke 2 ran as the
plan says; zip_text returned 1.5x the cards, 2.2x the cards inside Edison's ZCTAs and 4x the cards in the target ZIP. Austin
(smoke 3) is clearly local (84%). Edison is a small township inside a dense corridor, so a ZIP search always returns neighbours;
the pipeline's address-ZIP check ("outside pilot area") is what keeps them out, not the query.

## What the live smoke taught us (all handled in code, listed in test/fixtures/README.md)

- **Website link** is `a[aria-label*="website" i]` inside the card (94 of 116 cards in smoke 1).
- **A place opened by its CID link** (`https://www.google.com/maps?cid=…&hl=en&gl=us`, what `detail` opens) stays on that URL:
  no `!19s` place id, no `!3d/!4d`. The place parser reports coordinates as "not read" and the card's are kept.
- **The hours row has no `data-item-id`.** The open/closed line is read from the place panel text (`Open · Closes 6 PM`,
  `Open 24 hours`). No permanently-closed place was seen live: that marker (a whole line "Permanently closed") is
  unverified against a real page. The card's own status line is the first source.
- **End-of-list text** is inside the feed element. Edison smokes 1 and 2 stopped at 116 and 77 cards without it; smoke 3 got
  to the end. The loop now needs 4 empty scrolls (was 2) and waits a further 1.5-2.5 s before counting a scroll empty; this was
  only proven on Austin. **If Edison searches keep ending early in the pilot, raise `maps.maxScrolls` (30) in pp.config.json**
  and watch `end_reached` in `pp maps status`.
- A card with no `!3d/!4d` in its link exists (a service-area business, "House Painting By Elvis"): coordinates NULL, `not_on_card`.
- The live results page shows "You're seeing a limited view of Google Maps. See more" on **every** complete page; this is why
  text matching would be wrong (confirmed, not just researched).

## Contract as built (differences from the interfaces block)

- Nothing in `@pp/core` was touched. `ctx.fetcher` is unused by maps; `ctx.evidence.recordMany` is used, but only for rows the
  listing does not already hold (same field, extractor and value), so a re-read never duplicates evidence.
- `searches` rows are consumed as the plan says; `url` is used when set, else built from term / ZIP / centre.
- `runs.status` becomes `blocked` for a block signal and `stopped` for `daily_cap`; `runs.stopped_reason` is `"<signal>: <detail>"`
  and `runs.finished_at` is the time of the stop (the detail stage's back-off reads it). The discover back-off reads the blocked
  `searches.finished_at`.
- `listings.detail_status = 'blocked'` is used for the place page that hit a block and is retried after the back-off.
- Added `drizzle-orm 0.45.4` to `packages/maps/package.json` (already installed for core; the query operators are not re-exported
  by core). **`pnpm-lock.yaml` was not touched**, so the lockfile needs `pnpm install` at merge or `--frozen-lockfile` will fail.

## Deviations and judgement calls

1. **Plan contradiction on "No reviews":** the card line "No reviews" would store review count 0 (task text) but the acceptance
   test wants that card's rating and review count NULL with `not_on_card`. I followed the acceptance criterion (NULL), kept the
   fact in `ParsedCard.noReviewsText` and `card_raw`; flipping to a captured 0 is one line in `parse/card.ts`.
2. A limited-view place page does **not** erase a rating or review count the card really showed (a not-captured result never
   overwrites a captured value); it only sets `limited_view` where the value was missing. Retried up to 3 times.
3. Extra stop: three searches in a row with no results list and no place panel stop the run with signal `unusual_traffic`
   (an unknown interstitial would otherwise be hammered at the daily cap). A single such page is `failed`, not retried.
4. HTTP 403 or 429 on a navigation is treated as a block (`http_403`).
5. Exit codes: a block or limited-view streak exits 3 (`EXIT_BLOCKED`); `daily_cap` is a clean stop and exits 0 (the stop is
   printed and in `runs.stopped_reason`); `datacentre-test` exits 0 even when it hit a block (the JSON says so).
6. `request_log.outcome` has no value for "unexpected page"; a search page with no feed/panel is logged `http_error`.
7. `failed` searches are not retried automatically (the plan's resume list is pending / running / blocked only).

## Verification

Real output is in REPORT.md. Summary: `pnpm lint`, `pnpm -r typecheck`, `check-guards.mjs` exit 0; `pnpm vitest run` 32 files / 289
tests pass (unit + db + golden, network guard on, no test launches Chromium); `pp maps --help` lists smoke, discover, detail,
status, datacentre-test; `pp doctor` prints `modules: core,maps,registries,sites,pipeline`. A mutation check (making `is_new`
always true) fails the resume test as it should.

## Not done / for the orchestrator

- `pp maps discover` / `detail` were never run live end to end (the smoke budget is spent); the commands are covered through the
  stages with FixtureDriver and by the "refuses without PP_LIVE=1" tests.
- The datacentre test is untouched live by design (01-06 runs it on the laptop and on Railway).
- Lockfile update (see above); possible `maps.maxScrolls` raise.
