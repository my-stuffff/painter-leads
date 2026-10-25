---
phase: 01-pilot
plan: 05
subsystem: pipeline
tags: [pipeline, dedupe, qualification, excel, csv, accuracy, golden-set]

requires: [01-01]
provides:
  - "`pp pilot plan|run|resume|reprocess|report|yields|latest-run`, `pp report verify`, `pp fillrates`, `pp accuracy sample|compare|adjudication-sheet|golden-export`"
  - "packages/pipeline: term-major search planning, stage registry resolution, run orchestration with stop/resume, merge ladder, painter filter, area membership, qualification, six-tab workbook + CSVs with a Sources tab, report verifier, accuracy tools, golden replay harness"
affects: [01-06-pilot-run]

actuals:
  tokens: unmeasured
  tasks: 3
  commits: 3

key-files:
  created: [packages/pipeline/src/**, packages/pipeline/test/**]
  modified: []

requirements-completed: [QUAL-01, QUAL-03, QUAL-04, REC-01, REP-01, REP-02, REP-03, ACC-01, ACC-02, ACC-03]

completed: 2026-10-26
---

# Phase 1 Plan 05: Pipeline Summary

**One command (`pp pilot run <area>`) takes an area from planned searches to the six-tab workbook and two CSVs, every shown value traced on a Sources tab and checked by `pp report verify`; the accuracy tools and the golden replay harness are built and tested. All of it is proven on fakes and seeded data; the real maps / sites / registries stages are not merged in this branch yet.**

## Commits

| Task | Commit | What |
| --- | --- | --- |
| 1 Tracer | cb181e3 | plan, stage resolution, DB-backed fake stages, merge ladder, painter filter, area, enrichment wiring, qualify, workbook + CSVs, run orchestration, commands |
| 2 Rules + report | 61238a9 | Sources tab checks, `report verify`, `pilot reprocess`, offline fetcher wrapper, yields, tests for merge / filter / area / selection / sanitiser / report / verify / yields / resume |
| 3 Accuracy | 22c4f8d | blind sample, truth compare (drift + Wilson), adjudication sheet, fill rates, golden export + replay harness, synthetic golden case, CI golden test |

## Stage wiring state

- `resolveStages({ fake: false })` looks `discover` / `detail` up in `@pp/maps`, `site-enrich` / `site-finalize` / `classify` in `@pp/sites`, `registries-match` in `@pp/registries`, through each package's `packageModule` only. In this worktree those packages are skeletons (empty `stages`), so it throws `stage discover not provided (package maps not merged yet)`; this is tested with injected modules, so the test keeps passing after the other branches merge.
- `merge`, `qualify`, `report` are this package's own stages and are exported as `stages`.
- `--fake-stages` uses a pipeline-local, database-backed stand-in for discover / detail / site-enrich / classify (core's `createFakeStages()` records evidence for listing ids it never inserts, which a real database refuses; its site-finalize and registries-match are reused). merge, qualify and report are always real.
- **Assumptions about what the real stages write** (the first live run in 01-06 is where they get checked): maps writes evidence rows with the plain field names (`company_name`, `category` (one row per category), `rating`, `review_count`, `phone`, `website`, `street`, `address`, `city`, `zip`, `state`, `permanently_closed`) with `listing_id` set and source `google_maps`; sites writes `owner_name` (`attrs.title`) and `email` (`attrs.kind` personal / role / other) on the company; registries writes `nj_hic_number`, `licence_number`, `tx_taxpayer_number` on the company and `companies.registry_status.nj_hic_active`.

## Contract as built (differences and additions)

- The pipeline package has no `drizzle-orm` dependency and none may be added, so it runs plain parameterised SQL through `db.$client` (`src/sql.ts`).
- `ReportInput.outDir` is the **base** folder: files go to `<outDir>/<run-id>/<area-id>.xlsx`, `master.csv`, `qualified.csv`, `yield.csv`, `fillrates.json` and `accuracy/<state>/...`. `config.report.outDir` (`runs`) is resolved against the repo root.
- `pp pilot run` exit codes: 0 done, 3 stopped (a block, or the daily cap), 1 error. A block sets `runs.status` `blocked` (the daily cap sets `stopped`) with `stopped_reason`.
- `pnpm pp ... latest-run` prints only the id, but plain `pnpm pp` adds its own banner lines to stdout: use `corepack pnpm --silent pp pilot latest-run <area>` in scripts.
- `planSearches(db, config, area, phase = 'pilot', runId?)` creates the run when no `runId` is given; with one it only adds missing `(run, zip, term)` rows.

## Decisions made while building (all inside D-xx, none changes a ruling)

1. **Unrecognised category** (`painter_status = 'unknown'`): core has no exclusion reason for it, so it shows as `not a painting contractor` (never qualified, never silently kept). The Summary tab lists each unrecognised category with a count so the pilot can extend the tables. A core reason such as "category not recognised" would be clearer; that is the orchestrator's call.
2. **Phone**: only the Google listing phone is shown (D-23); with no Google phone the cell is blank (other phones stay evidence).
3. **Latest capture wins** for rating, review count, phone, website and the address parts (the place-page value replaces the card value); email ranks personal > role > other before confidence (core `selectBest` cannot rank by `attrs.kind`).
4. A company the area step has not judged (`in_area` NULL) is not "outside"; the run always runs the area step before qualify.
5. Service-area businesses get a derived **city and state** row (source `google_maps`, `attrs.derived = 'pin-in-zcta'`, medium) so By city and State are filled; never a ZIP.
6. `Qualified` in the report is computed from the current `pp.config.json` every time (QUAL-04); `pp pilot report <run>` also stores it.
7. By city "Companies found" counts every Master row (so it adds up to the Master list); Contact completeness is over the Master list and over the qualified rows (stated in the Summary tab).
8. `report verify` does not demand a Sources row for the label `Unclear` (a rule outcome with no signals); every other residential label must have at least one signal row.
9. Accuracy: held-back low-confidence candidates are scored as their own rows (confidence `low`) so each confidence level has its own precision; the "shown (high + medium)" aggregate is separate. A blank truth row is `unchecked` (not scored); `NOT_FINDABLE` is explicit.
10. Registry candidates in golden `registry.json` are `registry_records` rows in camelCase (no `raw`) plus owner names. The matcher answer in `truth.json` is the system's own decision (a regression guard, not hand-verified).

## For 01-06 (golden contract the sibling replayers will be called with)

- `replayers.mapsCard(card_raw)` gets the `card_raw` JSON stored on the listing (`maps-card.json` also keeps `place_raw`).
- `replayers.emails(pages, { websiteUrl })` / `owners(pages, { websiteUrl, companyName, city })` / `residential({ pages, categories, name, njHicActive })` get the saved, slimmed pages (`pages/<sha>.html.gz`, original sha256 and URL in `pages.json`).
- `replayers.registryMatch({ company, candidates })` gets `registry.json` candidates.
- Expected owners / emails are limited to what a page can be asked for: truth owners that the website extractor actually produced (a registry-only owner is not demanded of a page), `NOT_FINDABLE` when the checker found none, and an `ignore` list for website claims that finalisation rejects.
- The golden test reads `<repo>/fixtures/golden`; with no cases it reports one skipped test "golden set is populated in 01-06".

## Deviations from the plan

1. **[Scope]** Several Task 2 files (merge ladder, filter, area, enrich, selection policy, yields) were written in Task 1 because the tracer needs a company to qualify; the Task 2 commit adds their tests and the rest. Atomic per task still holds for the tests and the plan's behaviour lists.
2. **[Acceptance run]** `pp pilot run edison_nj --fake-stages` was run against `painter_leads_test_pipe` instead of the shared `painter_leads`, so fake rows never land in the shared dev database.
3. No new packages, no changes outside `packages/pipeline/**` (checked with `git diff --name-only c1143f8...HEAD`).

## Verification

`corepack pnpm lint`, `corepack pnpm -r typecheck`, `node scripts/check-guards.mjs` all exit 0; `corepack pnpm vitest run`: 41 files passed, 1 skipped (the golden placeholder), 416 tests passed. Real command output is in REPORT.md (not committed).
