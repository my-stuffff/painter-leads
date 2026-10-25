---
phase: 01-pilot
plan: 04
subsystem: sites
tags: [websites, crawler, emails, owner-names, residential-classifier, rules]

requires: [01-01]
provides:
  - packages/sites - company-website crawler (robots, 1 rps, disk cache, Chromium render fallback) and the rule tables that read it
  - stages site-enrich, site-finalize, classify and golden replayers emails / owners / residential
  - data/first-names.txt (5,163 names, Census 1990) with data/PROVENANCE.md
affects: [01-03-registries (reads nj_hic_number evidence), 01-05-pipeline, 01-06-pilot-run]

actuals:
  tokens: unmeasured
  tasks: 3
  commits: 3

key-decisions:
  - "Email text scan runs per text node, not on the joined page text: a label in one element ('Email us') must never glue onto the address in the next element (wepainttexas rendered page gave a made-up 'usinfo@wepainttexas.com' before this)"
  - "Page-wrapper classes (body, html, main) never mark text as footer / menu / review: a theme class like footer-sticky on <body> made the whole Barton Springs site 'footer-only'"
  - "Footer hits are 'weak', everything else 'strong'; residential_only needs >= 2 distinct STRONG residential ids, so weak footer phrases and the NJ HIC registration only ever support"
  - "How much of a site was read (pages, characters, services page) travels on the website residential_signal rows as attrs.crawl, so classify decides from evidence alone (no pseudo-signal row, no re-crawl)"

requirements-completed: [ENR-01, ENR-02, ENR-07, QUAL-02, ENR-06]

completed: 2026-10-25
---

# Phase 1 Plan 04: Websites Summary

**Websites now turn into email, owner, 13VH and residential-signal evidence through three stages the pipeline can call; the five probe sites replay offline with the expected results and all 318 repo tests pass.**

## Commits

| Task | Commit | What |
| --- | --- | --- |
| 1 Tracer | 0d9f9a1 | crawler (links, visible text, render fallback), email extract / filters / MX / rank, evidence rows, `pp sites crawl`, five probe-site fixtures |
| 2 Owners | e720290 | owner statements + validation, filler detector, template-name rejection, 13VH scan, first-name list, `pp sites names build` |
| 3 Classifier + stages | 53e5d1e | residential tables / signals / classifier, `site-enrich` / `site-finalize` / `classify`, replayers, `pp sites enrich` / `classify` |

## Probe-site results (fixtures, offline)

| Site | Emails accepted | Rejected (reason) | Owners accepted | 13VH | Residential label |
| --- | --- | --- | --- | --- | --- |
| johnspaint.com | johnspaint@hotmail.com | office@johnspaintingnj.com (off-domain, not free-mail) | none | 13VH06084400 | residential_and_commercial |
| njpaintingco.com | info@njpaintingco.com (mailto + text + JSON-LD) | none | none | none | residential_and_commercial |
| bartonspringspainting.com | info@bartonspringspainting.com (text only) | none | Jeff London (Founder), Breanna Rene (Owner), medium | none | residential_and_commercial |
| rutgerspainting.com | none | none | none ("Brennan Price" stored rejected: filler page; "Donald" needs_review, reviewer mention) | none | residential_only |
| wepainttexas.com (rendered) | info@wepainttexas.com (JSON-LD, text, mailto) | name@example.com, jane@email.com, you@example.com, nombre@ejemplo.com (placeholder domain); sstoo@gmail.com, u-jussi@suomi24.fi (bundle address not on the site domain) | none | none | residential_and_commercial |

The johnspaint off-domain address is the D-17 case the pilot counts: the company really uses `johnspaintingnj.com`; D-17 as written rejects it. The residential labels are what the rules say today, not hand-checked truth (01-06 measures that).

## First-name list

5,163 names (Census 1990 male 1,219 + female 4,275, folded, de-duplicated), sha256 of both source files in `data/PROVENANCE.md`. SSA union is pending (D-37): `pp sites names build --ssa-dir <folder of yobYYYY.txt>` adds names with a total count >= 50 over 1930-2005. "Brennan" is not in the Census list, so the Rutgers placeholder would fail the name check even without the filler detector.

## Contract as built (differences from the plan's interface text)

- All `@pp/core` names used exist as stated. The fetcher's `sha256` is the request key, so `page_sha256` on evidence is the cache key (or the render key), not a body hash; `selectBest` drops rows below `minConfidence` (default medium), so low-confidence owner / needs_review rows are stored and never selected.
- `FetchResult` carries only `content-type` on a cache hit, so the non-HTML check runs on whatever headers exist.
- A page rendered once cannot be found again by URL through the fetcher cache alone (the key includes the HTML). `crawlSite` looks the rendered copy up in the `pages` table (`url`, `rendered`) when a `db` is given; without a database an offline re-run reports such a page as render-failed.
- `@pp/sites` cannot import `drizzle-orm` (not a dependency), so SQL goes through `db.$client.query` (raw SQL); no core change, no new package.

## Deviations from the plan

1. **[Bug, fixed in Task 1]** text emails were scanned on the joined page text; see key decisions (`usinfo@...`). Regression test in `emails.test.ts`.
2. **[Bug, fixed in Task 3]** footer / menu / review detection from classes on `<body>`; regression test in `crawl.test.ts`.
3. Additions beyond the plan text, all inside `packages/sites`: `owned (and operated) by NAME` and `NAME (Owner)` owner patterns; more social hosts in the never-crawl list (x.com, twitter.com, linkedin.com, youtube.com, tiktok.com, pinterest.com, and google.com except sites.google.com); `--max-internal`, `--no-bundles`, `--offline` options on `pp sites crawl`; `sites enrich` runs `site-finalize` when no `--company-id` is given; `renderPage` and `enrichCompanies` helpers; a `visibleChars` input on `classifyResidential`.
4. Re-running `site-enrich` for a company replaces its earlier rows from this package's extractors (emails, owners, licence, residential) instead of adding duplicates, so the offline fix loop is repeatable.
5. `skeleton.test.ts` was replaced by real tests.
6. `wepainttexas.com` without `www` returned HTTP 404 on 2026-10-25; the fixture was captured from `https://www.wepainttexas.com/`.

## Open for the orchestrator / 01-06

- **Company-name rule is literal.** D-18 rejects a name when any word is a company-name word, so "John Smith" is rejected on a "Smith Painting" site (family-named firms are common). It costs recall, never accuracy; the golden set should show how many true owners it loses before anyone relaxes it.
- Texas Comptroller switch untouched (stays off in config); nothing in this package reads it.
- `pp doctor` prints `modules: core,maps,registries,sites,pipeline`; it does not list stages, so "non-empty stages" is proven by `replay.test.ts` (package wiring) instead.
- Live requests made (all through the fetcher, probe sites only): five capture crawls (home + up to 3 pages, wepainttexas with one render and one bundle), the two Census name files, and one smoke run of `pp sites enrich` over njpaintingco, johnspaint and rutgerspainting that fetched their remaining internal pages and same-site bundles at 1 request/second.
