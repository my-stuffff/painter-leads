# Maps rate probe

How hard can Google Maps be pushed from a Railway (datacentre) IP before it blocks or degrades? Locally we cap at
150 searches + 900 place pages a day with 4-8 s pauses because everything runs from one office IP. This probe
finds the real limit from a server.

`pp probe maps-rate` prints the server's public IP and country, then ramps: step A at the local pace with one
browser page, each later step halves the pause, and the last steps double the pages (default 6 steps, ending at
4 pages). A step stops at the first block page (sorry / captcha / unusual traffic / HTTP 403), on 5 limited-view
place pages in a row (the pipeline's own rule) or on 5 errors in a row; the ramp ends there. It then waits and
retries one request every 15 minutes (up to 4 times) to see how long the block lasts. Classification is the
pipeline's own code (`detectBlock`, `parsePlace`, `scrollFeedToEnd`), not a copy.

Input: `ops/probe/queries.json`, 300 searches like "house painter in Austin, TX" across 300 large US cities
(Census city names only; regenerate with `node scripts/probe/make-queries.mjs`). No database, no client data. Place
mode first harvests place links from a few of its own searches. To use fixed place links instead, point
`PROBE_INPUT` at a JSON file `{"queries": [...], "places": ["https://www.google.com/maps?cid=..."]}`.

## Deploy

Railway must be the owner's NEW Painter Promotions account. This laptop's Railway CLI is logged into the Naseeha
account, so never run `railway link` here, and set the new account's token on the one command:

1. In the new account: create a project (or use the existing one) with an environment `staging` and an empty
   service `pp-probe`. Region: a US one (an EU region gets Google's consent wall, which shows as `empty`).
   Give it at least 2 GB RAM (4 GB if `CONCURRENCY` is 8 or more).
2. Set the service variables below (all optional).
3. From this worktree:

```
RAILWAY_TOKEN=<new account project token> railway up --service pp-probe --environment staging --ci
```

`railway.json` points the build at `ops/probe/Dockerfile` (Playwright 1.63.0 image, same as the repo's
playwright-core pin) and sets restart to NEVER. The container runs the probe once, prints
`{"type":"exit","code":N}` and then sleeps, so the logs stay put and Google is not hit again. **Remove the service
when done**; it keeps running (and billing) while it sleeps.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PROBE_MODE` | `search` | `search` (results lists) or `place` (place pages) |
| `PAUSE_MS` | config: search 10000-20000, place 4000-8000 | step A pause range, e.g. `4000-8000` |
| `CONCURRENCY` | `4` | pages in parallel at the last step |
| `STEPS` | `6` | ramp steps (pause halves each step) |
| `STEP_REQUESTS` | `25` | requests per step |
| `MAX_REQUESTS` | `200` | hard cap for the whole run (place-mode harvest included; recovery checks are extra) |
| `SCROLLS` | `30` (config `maps.maxScrolls`) | feed scrolls per search, as the pipeline does; `0` = first screen only (lighter) |
| `LIMITED_STREAK` | `5` (config) | limited-view place pages in a row that stop a step |
| `ERROR_STREAK` | `5` | errors / unreadable pages in a row that stop a step |
| `HARVEST_SEARCHES` | `10` | place mode: most searches spent collecting place links |
| `RECOVERY_CHECKS` | `4` | after a stop: how many single-request checks (0 = none) |
| `RECOVERY_MINUTES` | `15` | wait before each check |
| `RAMP` | - | full override, e.g. `[{"pauseMs":[500,1000],"concurrency":8,"requests":50}]` |
| `PROBE_INPUT` | `ops/probe/queries.json` | another input file |

Suggested order: (1) defaults (search); (2) `PROBE_MODE=place`; (3) if neither blocked, push harder:
`CONCURRENCY=8 STEPS=8 STEP_REQUESTS=50 MAX_REQUESTS=600`. Leave a few hours between runs, or the next run starts
on a still-blocked IP. A redeploy usually keeps the same outbound IP; the `egress` line shows which one was used.

Check the settings without sending anything: `corepack pnpm pp probe maps-rate --dry-run`.

## Read the results

`railway logs --service pp-probe --environment staging` (same token). Every line on stdout is JSON:

- `{"type":"start",...}` the settings and the ramp; `{"type":"egress","ip":...,"country":...,"org":...}` the
  server's public IP (from ipinfo.io, falling back to api.ipify.org).
- `{"type":"request","t","step","kind","outcome","ms","status","worker","seq","cards"?,"detail"?}` one per request.
  `outcome`: `ok`, `limited_view` (place page with no review count), `sorry`, `captcha`, `unusual_traffic`,
  `http_403` (the four blocks), `empty` (a page that was neither results, place nor block, e.g. a consent wall or
  a list with no cards), `error` (timeout / crash).
- `{"type":"step",...}` one per step: `requests`, `okPct`, `limitedPct`, `blocked` and `blockedBy`, `avgMs`,
  `effectivePerHour` (requests divided by the step's wall time, pauses included) and `stoppedBy`
  (`completed`, `budget`, `blocked`, `limited_streak`, `error_streak`).
- `{"type":"recovery","check","minutesAfterStop","outcome"}` after a stop.
- `{"type":"final",...,"verdict":"..."}` the answer in one sentence: the fastest clean step with its hourly rate,
  where it stopped, and whether it recovered.

The number to take away is the fastest clean step's `effectivePerHour` (and its `limitedPct`): that is a pace this
IP sustained for `STEP_REQUESTS` requests. Compare it with the local pace (step A). A block already in step A means
Google treats this datacentre IP worse than the office line.

With `jq`: `railway logs ... | grep '^{' | jq -c 'select(.type=="step") | {step,concurrency,pauseMs,requests,okPct,limitedPct,blocked,effectivePerHour,stoppedBy}'`.
