# Phase 3 — Lead platform (web app + job queue + workers), built 2026-10-28

Owner's ask (2026-10-28 ~13:00 PKT): "a platform that does it all and gives a csv end to end by itself with the same
level of data accuracy … design language: painterpromotions.com colours, but far better … plan thoroughly and build it
all in the next 4h". Deadline ≈ 17:00 PKT. Branch `platform` (from `railway-worker` 60e2538), worktree `wt\pf`.

## What the owner gets

A signed-in web app on Railway. Pick states (CA, TX, NJ) and optionally cities (biggest first, census population),
set the requirements (rating, review range, search terms, reuse window), press Start. Workers on Railway scrape,
qualify and judge with the exact engine used for the 28 Oct delivery, retry and resume on their own, then build the
export. The app shows live progress per city, the results in three lists (Painting companies / Check first / Likely
fits) with the source behind every value, and downloads the XLSX + CSV. No step needs Claude.

## Scope decisions (and why)

1. **States = CA, TX, NJ only (v1).** `StateCode`, the runs check constraint and the owner-name registries (CSLB, TX
   Comptroller, NJ HIC) are built for these three. Other states need their own owner sources; flagged, not built.
2. **Cities = every Census place (and NJ township) with population ≥ 50,000** in the three states, biggest first,
   searched on every ZIP whose land is ≥ 20 % inside the city (same rule as the 24 cities). Existing 24 area ids kept.
3. **Same engine, no new judgement code.** Workers call `runPilot` / `pilot resume` / `maps detail --retry-limited`
   exactly as on 28 Oct. The only new rules are the three-list split already used in the delivered workbook:
   - painting = qualified AND name matches /paint|coat|finish|color|colour|brush|stain|wall|drywall/i AND Google
     category is Painter/Painting; check = qualified otherwise;
   - likely = not qualified AND every exclusion reason ∈ {also commercial, residential status unclear}.
   Thresholds per job are applied with the existing pure `qualify(facts, config)` at export time (nothing written
   back to `companies`), so two jobs with different thresholds never disturb each other.
4. **Reuse.** A city with a finished run younger than `reuseDays` (default 30) is not scraped again; its run feeds
   the export. The 24 cities scraped 27–28 Oct are therefore instant.
5. **One running city per state at a time** (merge re-points shared listings across runs of a state; two concurrent
   merges in one state could race). Two workers ⇒ two states in parallel. Claims serialised by an advisory lock.
6. **Exports stored in Postgres** (`job_exports`: xlsx, csv, rows JSON, summary) so the web service never needs the
   workers' disks.
7. **Auth:** email + password (scrypt), sessions table, httpOnly cookie; roles admin / operator / viewer (APP-01).
   First admin from env `ADMIN_EMAIL` / `ADMIN_PASSWORD` on first start.

## Data model (done before the fleet starts — `0001_platform.sql`)

users, sessions, jobs, job_areas (status queued|running|waiting|done|reused|failed|cancelled, run_id, attempts,
worker_id, heartbeat_at, not_before, message), job_exports, workers. Contract types: `apps/web/src/shared/api.ts`.

## Work split (disjoint surfaces → independent merges)

| Lane | Who | Owns (only these paths) |
|---|---|---|
| A Jobs engine | agent | `packages/jobs/**`, `apps/cli/src/pp.ts` (register module), `apps/cli/package.json` (dep), `ops/worker/run.sh` |
| B Front end | agent | `apps/web/src/client/**`, `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/public/**` |
| C City catalog | agent | `packages/core/src/geo/**`, `packages/core/src/commands/geo.ts`, `packages/core/test/geo*`, `data/geo/**`, `data/PROVENANCE.md` |
| D Server + deploy | orchestrator | `apps/web/src/server/**`, `apps/web/tsconfig.json`, `ops/web/**`, Railway |

Shared, frozen while the lanes run: `apps/web/src/shared/api.ts`, `packages/core/src/db/schema.ts`, migrations,
lockfile (no lane adds a dependency without telling the orchestrator).

### A — Jobs engine (`packages/jobs`)
- `pp worker [--id <name>]`: registers in `workers`, heartbeats every 30 s, loops: claim → run city → repeat; idles
  10 s when nothing to do. Never exits on a city error (records it); exits only on SIGTERM.
- Claim (under `pg_advisory_xact_lock`): oldest job first, position order; status queued, or waiting with
  not_before ≤ now, or running with heartbeat older than 10 min (crashed worker); skip a state that has a live
  running city.
- Run a city: reuse a fresh done run (status reused) · else resume the newest unfinished run of the area · else
  plan a new one; config = base config with the job's terms and thresholds. On a block / limited-view stop: one
  `--retry-limited` detail pass, then waiting with not_before = now + 30 min (attempt ≤ 6, then the run is finished
  with what it has: values Google hid stay "not captured"); daily cap: waiting until next UTC midnight. Error: failed
  after 3 attempts, message in plain words.
- Job status: running once a city starts; when every city is terminal → build export → done (or failed when no city
  succeeded). Cancel: queued cities → cancelled; a running city finishes.
- Export builder: per run `buildReportData` + `computeFacts` + `qualify` with the job config; three lists; dedupe by
  Google profile link (first city wins); XLSX tabs Summary / Painting companies / Check first / Likely fits (same
  columns as the 28 Oct workbook + List, Why not in main list); CSV = all lists with a List column; rows JSON =
  `LeadRow[]`; summary = `ExportSummary`. Rebuild on request (`export_status = 'none'`).
- Tests: claim + state lock + stale reclaim + reuse (db tests), list split + thresholds (unit), export columns.

### B — Front end (`apps/web/src/client`)
React 19 + Vite 8 + Tailwind 4 + TanStack Query + React Router; d3-geo + us-atlas map. Mock mode (`VITE_MOCK=1`)
from the contract so it is built and checked without the server. Screens: Sign in · Home (live overview, recent
jobs) · New search (states on a real map, cities biggest first with population and ZIP count, requirements, review
with ZIP/search counts and a rough time) · Job (live per-city progress, three lists, filters, lead drawer with
sources, downloads, cancel / retry / rebuild) · All searches · Users (admin). Brand: Painter Promotions blue #286b9e,
navy #01395E, amber #fbbf24, teal #59AFA1; Ubuntu headings, Inter text, tabular plain-zero numbers; light + dark;
phone + desktop. Standing UI rules: Back = exactly one step, logo → home; no explanatory filler text; dropdowns for
known sets; plain words.

### C — City catalog
`pp geo build` also writes `data/geo/catalog.json` ({builtAt, sources, minPopulation, popYear, cities:[{areaId,
state, name, censusName, kind, geoid, population, popYear, lat, lng, zipCount}]}) for CA/TX/NJ places (and NJ county
subdivisions) with population ≥ 50,000 (Census Vintage 2024 sub-county estimates), and adds a whole-city area for each
to `pilot-areas.json` + its ZCTA polygons to `pilot-zcta.geojson`. Existing area ids and the 3 pilot areas stay
byte-identical. Tests for the selection and the id mapping.

### D — Server + deploy
Hono on Node serving `/api/*` (contract) and the built client. Progress SQL per run (searches, place pages,
companies, painters, qualified, stage). Railway: new service `pp-web` (public domain), workers switched to
`PP_MODE=worker` with restart ON_FAILURE.

## Speed checklist (feedback-plan-build-speed-checklist)
1 look: no separate sketch round — the owner set a 4 h build and named the brand; first look is the live app.
2 browser tests: one desktop + one phone pass in a real browser at the end (not a matrix).
3 proof by risk: the money risk is data accuracy → engine untouched; new risk = list split + thresholds + claims
  → unit/db tests on those. 4 fewer bigger plans: 4 lanes. 5 worktrees deleted after merge.
7 machine: lanes are code-only; heavy work runs on Railway.

## Known limits (said up front)
- Google hides ratings/review counts on part of the listings ("limited view"); those companies cannot qualify and are
  counted, never guessed. Review counts can't be re-checked when not signed in.
- A city takes very roughly 1–2 minutes per ZIP per worker; Los Angeles (116 ZIPs) ≈ 3 h.
- Two workers, 8 GB each (Hobby plan cap).
