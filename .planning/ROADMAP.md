# Roadmap: Painter Promotions — Lead Finder

## Overview

Three phases. Phase 1 builds the whole data engine in its final shape: our own Google Maps scraper, rules-based
qualification, owner/email enrichment from free public sources, one record per company with evidence behind every
value, and the Excel/CSV report. It proves that engine on one metro per state (New Jersey, Texas, California) with
measured fill rates, a blind 98% accuracy check, a golden test set, and a measured answer on whether Google tolerates
scraping from a datacentre. Phase 2 scales the same engine to whole states, with coverage planning, repeat-run updates
and hand-checked delivery of the three state workbooks. Phase 3 puts it behind a signed-in web app on the new paid
Railway account, so the Partnerships Manager can start runs, watch them, browse results with their sources and
download lists themselves.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Pilot** - Full data engine proven on one metro per state (NJ, TX, CA): Excel/CSV out, real fill rates, blind accuracy check, golden test set, datacentre scrape test
- [ ] **Phase 2: Full State Runs** - Statewide coverage for NJ, TX and CA with repeat-run updates; three hand-checked state workbooks delivered
- [ ] **Phase 3: Web App on Railway** - Signed-in app with Admin/Operator/Viewer roles to start runs, watch progress, browse results with sources and download, live on the new Railway account

## Phase Details

### Phase 1: Pilot
**Goal**: For one metro area in each of New Jersey, Texas and California, the Operator gets a correct, source-traced
list of residential-only painters (owner, phone, email, website, rating, number of ratings), and the project knows its
real fill rates, its measured accuracy, and whether Google allows scraping from a datacentre.
**Depends on**: Nothing (first phase)
**Requirements**: DISC-02, DISC-03, DISC-04, QUAL-01, QUAL-02, QUAL-03, QUAL-04, ENR-01, ENR-02, ENR-03, ENR-04, ENR-05, ENR-06, ENR-07, REC-01, REP-01, REP-02, REP-03, ACC-01, ACC-02, ACC-03, OPS-01
**Success Criteria** (what must be TRUE):
  1. Operator runs the pilot for one metro per state from one command and gets, per state, an Excel workbook (Master
     list, Qualified, By city, Contact completeness, Summary) plus the same lists as CSV; each company appears once,
     every company not qualified shows its exact reason (not a painter / also commercial / unclear / rating / review
     count, with thresholds read from one settings file), and every filled cell carries its source link and capture
     date.
  2. A fill-rate report per state shows the measured share of companies with an owner name, email, phone and website,
     plus the share of findable values the system missed.
  3. A blind hand-check of 50 random companies per state against the live sources finds at least 98% of filled values
     correct; every miss is written down with its cause, fixed, and re-checked.
  4. The hand-checked companies are saved as a golden set (stored pages + correct answers) that the automated tests
     replay on GitHub Actions in the private `my-stuffff` repo; a code change that lowers accuracy on it fails the
     build.
  5. A measured test answers whether Google Maps scraping works from a datacentre IP (searches attempted vs blocked or
     limited, Railway vs this PC); a run that hits a block stops, records hidden values as "not captured" (never zero),
     and later resumes without repeating finished searches.
**Plans**: TBD
**Notes**: Built in the final architecture (Postgres, evidence stored per value) that Phase 2 and the app reuse, not
throwaway. Pilot areas are fixed search lists; the general statewide search planner (DISC-01) comes in Phase 2. A
source probe early in the phase sets what NJ HIC, Texas Comptroller and BBB actually expose (ENR-04/05 coverage).

### Phase 2: Full State Runs
**Goal**: The Partnerships Manager receives complete, hand-checked lead workbooks for the whole of New Jersey, Texas
and California, and re-running a state keeps those lists current without duplicates.
**Depends on**: Phase 1
**Requirements**: DISC-01, DISC-05, REC-02
**Success Criteria** (what must be TRUE):
  1. Operator names a state (or an area within it) and the system plans searches covering every city/ZIP area of it,
     not just the top 120 results one search shows.
  2. After each run the Operator sees a coverage summary: searches done, listings found, new vs already known
     companies.
  3. Full runs for New Jersey, Texas and California complete, and each state's workbook is delivered only after its
     blind hand-check passes (at least 98% of filled values correct).
  4. Re-running a state updates ratings and review counts on existing companies, marks newly found companies as new
     and companies no longer listed as gone, and creates no duplicate records.
**Plans**: TBD
**Notes**: The delivery hand-check reuses the ACC-01 process built in Phase 1. Statewide runs take days of throttled
run time; Phase 3 building can overlap them.

### Phase 3: Web App on Railway
**Goal**: The Partnerships Manager and Account Executive sign in to a web app on the new paid Railway account and run,
watch, browse and download state lead lists themselves, each seeing only what their role allows.
**Depends on**: Phase 1 (engine, scraper-location answer); Phase 2 (statewide planner behind "start a run for a state")
**Requirements**: APP-01, APP-02, APP-03, APP-04, OPS-02
**Success Criteria** (what must be TRUE):
  1. Users sign in; an Admin adds users and gives each the Admin, Operator or Viewer role. Operators can start runs and
     download, Viewers can only see results and download, and only Admins manage users.
  2. Operator starts a run for a state in the app and watches its progress: searches done, companies found, enriched,
     qualified.
  3. Users browse results with filters (qualified only, city, missing email, missing owner) and open any company to
     see the source link and capture date behind each value.
  4. Users download the Excel and CSV reports for a state or run from the app.
  5. The app runs on the new paid Railway account (web + worker + Postgres), and scraping runs where the pilot's
     datacentre test decided: on Railway, or on this PC as an agent feeding the Railway app.
**Plans**: TBD
**UI hint**: yes
**Notes**: Screens' look approved via sketch before building.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 (Phase 3 building may overlap Phase 2's long state runs)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Pilot | 0/TBD | Not started | - |
| 2. Full State Runs | 0/TBD | Not started | - |
| 3. Web App on Railway | 0/TBD | Not started | - |
