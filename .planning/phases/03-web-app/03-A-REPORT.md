# Lane A — Jobs engine (`packages/jobs`), report

Branch `pf-jobs`, commits b8d3769 → c5cceee (plus this report). Built 2026-10-28.

## Before deploy (needs lane D: files outside lane A)

1. **`ops/worker/Dockerfile` needs one line** before `RUN pnpm install --frozen-lockfile`:
   `COPY packages/jobs/package.json packages/jobs/`. Without it the image installs, but `packages/jobs` gets no
   `node_modules` (no exceljs, no `@pp/*` links), so `pp` fails to start. Checked by repeating the image's install
   steps in a scratch folder: with the line, `packages/jobs/node_modules` has exceljs + @pp/core/maps/pipeline;
   without it, it is missing. (A missing `apps/web/package.json` does not break the worker install.)
2. **Worker id per replica.** `run.sh` uses `--id "${RAILWAY_SERVICE_NAME:-$(hostname)}"` as asked. If one Railway
   service runs more than one replica, they share that id, and a restarting replica puts the other replica's
   running city back in the queue. Two separate services (pp-worker-1, pp-worker-2) are fine.
3. The web's **retry** must set the job back to `queued`/`running` (claims only take cities of queued/running
   jobs); its **rebuild** sets `export_status = 'none'` (picked up on the next worker pass, not only when idle).

## What was built

- `pp worker [--id <name>] [--once] [--fake-stages]` (packages/jobs/src/commands.ts, worker.ts). Registers in
  `workers`, puts back its own `running` cities (restart), heartbeats every 30 s (workers.last_seen_at and the
  city's heartbeat_at). Each pass: sweep cities of cancelled jobs → build exports that are due → claim one city →
  run it → record the outcome → build the job's export if all its cities are finished. Idles 10 s when there is
  nothing to claim. A city error never stops the loop. SIGTERM / SIGINT: claim nothing new, hand a running city back
  to the queue (attempt not counted; its run is resumed by the next claim), exit 0.
- Claim (queue.ts `claimNext`): one transaction, `pg_advisory_xact_lock(4242)` first; job id then position; queued,
  or waiting past not_before, or running with heartbeat older than 10 min; skips a state with another running city
  whose heartbeat is younger than 10 min (across all jobs); only cities of queued/running jobs. Sets running,
  worker_id, heartbeat_at, attempts+1, started_at once, clears not_before/message; job → running + started_at.
- Run a city (city.ts `runCity`), config = base config with `search.terms` = the job's terms (thresholds stay base):
  - the city's own run already done → done (worker died after finishing, before recording);
  - reuseDays > 0 and a done run of the area finished within reuseDays → `reused`, "Used data from YYYY-MM-DD";
  - else resume the city's own unfinished run, else the newest unfinished run of the area, else plan a new one
    (planSearches first, run_id saved on the city at once), then `runPilot(env, areaId, {runId})`;
  - blocked → one detail pass with `retryLimited: true` (the stage behind `maps detail --retry-limited`), runPilot
    again; still blocked → `waiting` 30 min, "Google is limiting views — trying again at HH:MM UTC"; on the 6th
    blocked claim the run is finished with what it has (runPilot with discover/detail that find nothing left, so
    merge → filter → area → enrich → qualify → report run as usual) → `done`, "Finished with N listings Google
    kept hidden; M searches not done";
  - daily cap → `waiting` until next midnight UTC, "Daily limit reached — continuing at 00:00 UTC";
  - thrown error → `waiting` 5 min "Error: … — trying again at HH:MM UTC"; on the 3rd claim `failed`
    "Stopped after 3 tries: …";
  - claimed more than 10 times without ending (the worker kept dying mid-city, e.g. memory) → `failed` (added: without
    it a city that kills the worker would loop forever);
  - a blocked / capped city of a cancelled job → `cancelled` instead of waiting.
- Finishing a job (finish.ts): when every city is done/reused/failed/cancelled, the export is built
  (export_status building → ready, or failed + export_error); job → done (failed when no city is done/reused, with
  error "No city finished"; a cancelled job stays cancelled); finished_at set. Only one worker builds a given export
  (atomic `UPDATE … SET export_status='building' WHERE export_status <> 'building' …`).
- `pp jobs export <jobId>`: rebuild now, whatever the export status (refused while a build is running). If cities
  are still open it builds from the finished ones and leaves the job status alone.
- Export (export.ts `buildExport`): per done/reused city in position order `buildReportData` (the run's own master
  list, every cell exactly as the 28 Oct workbook shows it), judged with the job's thresholds; three lists
  (painting / check / likely, rules exactly as specified, whyNot in plain words); dedupe by Google profile link
  (company id when there is none), first city wins; each list sorted by State, Search city, Company.
  XLSX: Summary (name, rule line, states, cities included, cities left out, terms, built time, counts per list, per
  state, painting-list fill counts) + 'Painting companies' / 'Check first' / 'Likely fits' (Search city +
  QUALIFIED_COLUMNS; Likely fits has 'Why not in main list' first); bold frozen header, widths, autofilter,
  Website and Google profile link as hyperlinks (http/https only), ZIP as text, formula guard on every text cell.
  CSV: BOM, CRLF, all quoted, `List, Why not in main list, Search city, …QUALIFIED_COLUMNS`. rows = `LeadRow[]`,
  summary = `ExportSummary`. Stored in `job_exports` (upsert).
- `ops/worker/run.sh`: `PP_MODE=worker` → after migrate `exec pnpm --silent pp worker --id …`; PP_JOB unchanged.
- `@pp/pipeline` index: exports only (envFromCommand/PilotEnv, RunOptions/RunOutcome, loaders, toEvidence,
  decideArea, policyFor/selectLatest, computeFacts, buildReportData + ReportCompany, csvText/BOM, safeHyperlink,
  LINK_COLUMNS/TEXT_COLUMNS). No judgement code changed anywhere.

## One deliberate change from the brief: in-area is judged per run at export time

`companies.in_area` is one flag per company, rewritten by the area step of whichever run reached the company last.
A company on a city border (e.g. Redhill Painting, ZIP 94124 San Francisco, also found by the Oakland searches) is
"outside pilot area" in the SF report once Oakland has run. So a plain `buildReportData` per run silently drops
border companies, and the result depends on run order. The export therefore re-applies the same `decideArea` rule
`assignArea` uses, with the run's own area and the same inputs (latest accepted ZIP, else listing ZIP / pin), and
re-qualifies (computeFacts + qualify, job thresholds) only the companies whose answer differs. Nothing is written.
(run-area.ts: `inAreaForRun`, `judgeAgainstRunArea`.)

## Real-data check (production, read-only, runs 10–33, default settings)

Read-only connection (`default_transaction_read_only=on`, confirmed), no DB writes; files in
`D:\Temp\claude\pf-jobs-check\` (check.xlsx, check.csv, check-rows.json; full diff in diff-vs-delivery.txt).

| | Painting | Check first | Likely fits |
|---|---|---|---|
| 28 Oct delivery | 52 | 37 | 878 |
| Plain buildReportData per run (brief as written) | 50 | 37 | 863 |
| As built (in-area per run) | **53** | **40** | **969** |

- As built is a strict superset of the delivery: every one of the 52 / 37 / 878 delivered leads is there, and all
  20,218 compared cells (every column, incl. Why not in main list) are identical.
- The 1 + 3 + 91 extra leads are companies the delivery lost to the shared in_area flag (probed: Redhill Painting
  SF/Oakland, Arroyo Painting Fresno/Bakersfield, Premium Exterior Painting LA/Anaheim — ZIP inside the searched
  city, flag written by the neighbouring city's run).
- The plain method's 17 missing leads are the same effect after the delivery: runs 26–33 re-ran at 04:3x UTC and
  rewrote the flag (e.g. Dallas Varsity Painting, Dallas run 14 and Plano run 29).
- Build time for 24 cities over the public proxy: 405 s (most of it network); on Railway's private network it
  should be well under that. Owner decision worth flagging: the 28 Oct workbook undercounted by these 95.

## Exported API (`@pp/jobs`) for the server lane

Queue / state (queue.ts):
- `claimNext(db, workerId): Promise<ClaimedArea | null>`; `registerWorker(db, workerId, note?): Promise<number>`
- `heartbeat(db, workerId, jobAreaId | null)`; `setAreaRun(db, workerId, jobAreaId, runId)`
- `finishArea(db, workerId, jobAreaId, AreaOutcome): Promise<boolean>` (false = no longer ours)
- `releaseArea(db, workerId, jobAreaId)`; `sweepCancelled(db): Promise<number>`; `jobStatus(db, jobId)`
- `jobsReadyToFinish(db): Promise<number[]>`; `takeExportBuild(db, jobId): Promise<boolean>`
- constants `CLAIM_LOCK_KEY = 4242`, `STALE_MINUTES = 10`, `TERMINAL_AREA_STATUSES`
Export (export.ts / finish.ts):
- `buildExport(db, baseConfig, ExportInput): Promise<BuiltExport>` — `{ xlsx: Buffer, csv: Buffer, rows: LeadRow[], summary: ExportSummary }`
- `loadExportInput(db, jobId)`, `saveJobExport(db, jobId, built)`, `finishJob(db, base, jobId, log?)`,
  `finishReadyJobs(db, base, log?)`, `rebuildJobExport(db, base, jobId, log?): Promise<FinishResult>`
- `EXPORT_HEADERS` (csv / painting / check / likely header arrays), `ruleLine(settings)`, `summarise(...)`
- CSV per list for `GET /api/jobs/:id/export.csv?list=…`: the stored CSV has every list with `List` as the first
  column (labels from `LEAD_LIST_LABEL`), so the server can filter lines by that column, or rebuild from `rows`.
City / worker: `runCity(env, workerId, ClaimedArea, CityDeps?)`, `freshDoneRun`, `nextUtcMidnight`,
`class Worker { run(); step(); stop() }`. Lists: `pickList`, `dedupe`, `dedupeKey`, `compareRows`.
Settings: `readSettings(raw)`, `pipelineConfig(base, s)`, `exportConfig(base, s)`.

Progress: no helper added (lane D owns the progress SQL). What the worker writes that the server can read:
job_areas.status / message / not_before / attempts / run_id (set as soon as the run is known), heartbeat_at
(running cities, every 30 s), workers.last_seen_at + workers.job_area_id (null when idle).

## Tests

- `corepack pnpm --filter @pp/jobs typecheck` clean; `corepack pnpm exec eslint packages/jobs apps/cli` clean;
  `@pp/cli` typecheck clean; existing unit tests of apps/cli + packages/pipeline: 179 passed.
- Unit (`--project unit packages/jobs`): **10 passed** — list split (painting name/category, check, likely, every
  other reason out), whyNot text, dedupe first-wins + id fallback, sort order, settings defaults, configs change
  only terms / thresholds and leave the base untouched, rule line, summary counts.
- DB (`--project db packages/jobs`, own DB `painter_leads_test_pfjobs` via TEST_DATABASE_URL so other lanes'
  tests don't collide): **27 passed** — claim order + job running; one running city per state across jobs; three
  concurrent claims get three different cities; stale (11 min) reclaim and 9 min not; old worker can't record a
  taken-over city; restart reset; waiting before/after not_before; release on stop; cancel (no claims, sweep,
  running city finishes, job stays cancelled); all-failed job → failed, not picked again; reuse newest fresh run;
  no reuse when older / reuseDays 0; plan + run_id saved + terms reach the pipeline, thresholds don't; resume newest
  unfinished; block → one retry-limited pass → through; still blocked → 30 min wait; 6th block → finished with
  what it has; daily cap → midnight UTC; error → 5 min, failed on 3rd; >10 claims → failed; cancelled job's blocked
  city → cancelled; worker loop end to end (fake stages: city done, job done, export ready, 3 painting leads);
  rebuild via export_status 'none'; export LeadRow shape, thresholds at export only (companies.qualified
  untouched), dedupe across cities, per-run in-area, workbook tabs/headers/frozen/bold/hyperlink, CSV BOM/header/List.
- Proved red: removing the one-city-per-state clause failed 2 queue tests; skipping the per-run in-area step failed
  the in-area export test; both restored (byte-identical) and green.
- CLI smoke on the local test DB: `pp worker --once --fake-stages --id cli-smoke` took a queued Edison job to
  done / export ready; `pp jobs export 1` rebuilt it.

## Not verified

- SIGTERM on Railway: `exec pnpm … pp worker` → pnpm → tsx → node. Signal forwarding through pnpm was not tested
  (Windows has no SIGTERM). If it does not arrive, Railway kills the process; the restart reset (same worker id)
  or the 10-minute stale reclaim picks the city up again, so nothing is lost, only delayed.
- Live Google paths (block, limited views, daily cap) were tested with stand-in stages only. Note the maps stages'
  own 60-minute block back-off: right after a hard block the retry-limited pass and the second runPilot return at
  once; the 30-minute waits mean every other retry is a quick no-op until the back-off has passed.
- A worker that dies during an export build leaves export_status 'building' (no timestamp to detect it); the web
  can set it to 'none' to rebuild.
- A city finished "with what it has" after 6 blocks is a done run, so later jobs within reuseDays reuse it as is.

## Contract notes

- `LeadRow.state` is the searched city's state (always a `StateCode`); the files' State column shows the address
  state, which can differ (a company searched in NJ with a PA address). byState counts use the searched state.
- `PackageModule['name']` in @pp/core is a closed union without 'jobs'; the module casts it (only `pp doctor`
  prints the name). Adding 'jobs' to the union would remove the cast.
- `AreaProgress.qualified` is "the run's own count" per the contract; with per-run in-area at export time the
  export's counts can be higher than companies.qualified suggests.
