# Phase 3 — Lane B (front end) report

Branch `pf-ui`, 2026-10-28. Everything lives in `apps/web/index.html`, `apps/web/vite.config.ts`,
`apps/web/public/favicon.svg`, `apps/web/src/client/**` and one script change in `apps/web/package.json`
(`dev:mock` → `vite --mode mock`; the old `VITE_MOCK=1 vite` form does not run under pnpm on Windows).
No dependency added. `apps/web/src/shared/api.ts` untouched.

## Screens

| Route | What it does |
| --- | --- |
| `/sign-in` | Email + password, show/hide password, inline error, logo → home. Already signed in → goes straight on. `?next=` brings the user back to the page they asked for (same-app paths only). |
| `/` Home | Greeting; "Leads to date" with one proportional bar for the three lists and their counts; Running now (live rows with progress); Recent searches (lead counts per list); side panel with running / waiting-in-line counts and each worker (online dot, what it is doing). New search button (hidden for viewers). |
| `/searches/new` | One page, four sections + a summary. **States**: CA / TX / NJ cards with the real outline from us-atlas `states-10m.json` (FIPS 06/48/34, conic-conformal projection fitted per state), cities as dots sized by population, the biggest named (labels placed where they overlap nothing); click card = pick state, click dot = pick city. **Cities**: grouped by state, biggest first, population (3.88M / 145k), ZIP count, teal "Data from Oct 27" badge when the last run is younger than the reuse window; quick picks All / Top 5 / Top 10 / None (per state); find box (`/` focuses it). **Requirements**: lowest Google rating (stepper + slider 4.0–5.0 by 0.1), reviews from/to, reuse window (Search again / 7 / 30 / 90 days, segmented), search terms as chips (Enter/comma adds, Backspace removes, Reset to defaults). **Name** (placeholder shows the automatic name). **Summary** (sticky panel on desktop, bar at the bottom on phones): cities, ZIP codes, Google searches (ZIPs to scrape × terms), reused cities, rough time (1.5 min per ZIP that must be scraped). Start is disabled with the reason shown until there is ≥ 1 city, ≥ 1 term and a valid review range. Start → `POST /api/jobs` → job page with `replace`. Viewers see "Viewers can't start searches". |
| `/searches/:id` | Header: name, status pill, states + city count, who, started, time left / finished. Big progress panel with the **paint-roller bar** (roller turns while running), "N of M cities done", the city running now, the settings used. Leads section and Cities section — leads first once the lists exist, cities first while it runs. **Cities**: table (phone: cards) with status pill, step, searches done/total + bar, listings read done/total + bar, companies, painters, tries, and the message (amber when waiting, red when failed; "trying again at 2:01 PM" from `notBefore`). **Leads**: tabs Painting companies / Check first / Likely fits with counts; filters state, city, No owner, No email, text search (`/` focuses); sortable table with sticky header, fixed column widths, 50 per page (phone: cards + a sort select); row → side drawer. **Drawer**: Call / Email / Website / Google buttons, why it's not in the main list (likely fits), owner (name, title, where found + confidence), contact, Google, location, checks, dates, and the **Sources** list from `/api/companies/:id/sources` (field, value, linked source, read date, confidence). Blanks read "Not found" / "—". **Actions** (operators + admins only): Cancel search (confirm dialog), Retry failed cities, Rebuild lists; Download menu (XLSX, CSV all, CSV per list) as plain links. Polls every 5 s while queued / running / export building, then stops. |
| `/searches` | All searches: status filter (segmented, counts, URL `?status=` with replace), desktop table (name, states, status, progress, lead counts, started), phone cards. |
| `/users` | Admin only (nav item hidden for others; page says so if opened). List with role select, Active / Turned off, last sign-in, Reset password (dialog, "Make one" generates a 14-char password), Turn off / Turn on. Add user dialog (name, email, role select, temporary password). Your own row can't change role or be turned off. |
| `*` | Not found page with Back + Go home. |

Shell: navy left rail on desktop (logo → home, New search, Home / Searches / Users, live "2 workers online, 2 busy", user menu with theme switch Light / System / Dark and Sign out); phones and tablets (< 1024 px) get a navy top bar with logo + menu sheet. Light and dark themes from CSS variables (`styles.css`, `@theme`), system by default, saved per browser. Ubuntu for headings, Inter for text, tabular figures everywhere; checked a rendered "0" in both faces at 3× — plain, no slash. Skeletons for loading, toasts for actions, empty states with the next action, focus rings, Esc closes dialogs/drawer, reduced motion respected.

**Back rule**: every screen but Home has a Back button that goes exactly one step (`navigate(-1)` when react-router's history index > 0, else the parent route with `replace`). Tab, filter, sort and page changes use `replace` (no history entries). The open lead is `?lead=<id>` pushed as one step, so the phone's back gesture closes the drawer; the drawer's ✕ does the same. Redirects (401 → sign-in, sign-in → next, start → job page) use `replace`.

## Mock mode

`corepack pnpm --filter @pp/web dev:mock` (or `vite --mode mock`). `vite.config.ts` defines `import.meta.env.VITE_MOCK` as `'1'` in mock mode and `'0'` otherwise; `main.tsx` does `if (import.meta.env.VITE_MOCK === '1') await import('./mock/server')`, so the production build drops the mock entirely (checked: no mock strings in `dist/client/assets/*.js`). The mock swaps the transport in `api.ts`, adds 120–320 ms latency and answers every contract endpoint from in-memory data (`mock/data.ts`, `mock/server.ts`):
- the 24 cities with lat/lng and a mix of recent / old / no last runs; 5 users (Maya Collins admin);
- 8 searches: queued (held, "no free worker"), two running (one with Dallas **waiting** on Google with a retry time), done with ~60 and ~150 leads, a done one with a failed city, cancelled, failed;
- a tick-based simulation: each request advances running cities (searching → reading listings → checking websites → finishing), starts the next city (reusing fresh ones instantly), finishes the job, builds the export (~6 s) and generates leads — a new search started in the UI runs to a finished lead list in under a minute for small cities;
- cancel / retry / rebuild / users CRUD behave per the contract; downloads build a CSV in the browser (the XLSX link gives the same rows as CSV — there is no workbook builder client-side).
Sign in with any email; password `wrong` shows the error; an email containing `viewer` (or `operator`) signs in with that role.

## API calls used

| Method | Path | Where / when |
| --- | --- | --- |
| POST | `/api/auth/login` | sign-in (401 shows the server's message inline; never triggers the 401 redirect) |
| POST | `/api/auth/logout` | user menu → Sign out |
| GET | `/api/auth/me` | app shell (cached 5 min); sign-in page (skip if already signed in) |
| GET | `/api/catalog` | New search |
| GET | `/api/overview` | rail worker line + Home, every 10 s |
| GET | `/api/jobs` | Home, Searches — every 5 s while any search is live, else 30 s |
| POST | `/api/jobs` | Start search (`areaIds` biggest first, `name` omitted when blank) |
| GET | `/api/jobs/:id` | job page, every 5 s while queued / running / export building |
| POST | `/api/jobs/:id/cancel` · `/retry` · `/rebuild-export` | job actions (result written straight into the job cache) |
| GET | `/api/jobs/:id/leads` | only when `exportStatus === 'ready'`; cache key includes `exportBuiltAt`, so a rebuild refetches |
| GET | `/api/jobs/:id/export.xlsx` · `/api/jobs/:id/export.csv?list=all\|painting\|check\|likely` | plain `<a download>` links |
| GET | `/api/companies/:id/sources` | lead drawer |
| GET / POST / PATCH | `/api/users` · `/api/users/:id` | Users page (role, disabled, password) |

Any 401 except from login → `/sign-in?next=<current path>` (replace) and the query cache is cleared. A non-JSON answer (HTML page, gateway error) is treated as an error, not as data.

## Verified

- `corepack pnpm --filter @pp/web typecheck` — passes. `corepack pnpm --filter @pp/web build` — passes (`dist/client`: index 448 kB / 137 kB gzip, New search chunk 158 kB incl. map data, Users 9 kB). `corepack pnpm exec eslint apps/web/src/client` — clean (one justified `eslint-disable` for `fetch` in the browser client: the repo rule is about Node's undici).
- Production bundle smoke test with `vite preview` and no API behind it: no page errors, the shell shows the error state with Try again.
- Real Chromium (playwright-core) against mock mode, screenshots at 1440×900 and 390×844, light and dark for Home + Job (+ New search dark), all looked at and fixed (table widths, map label collisions, phone state cards, select widths/chevron, segmented overflow, roller head). Saved in `D:\Temp\claude\pf-ui-shots\` (`desk-light-*`, `desk-dark-*`, `phone-light-*`, `phone-dark-*`, `live-*`, `zero-*`).
- Click-through, all passing: signed-out deep link → sign-in with `next` → back to that page; logo → home; New search → pick NJ → All → Start → job page; Back from the new job goes Home (form replaced); open a done search, switch tabs, type in search, open a lead (`?lead=`), browser Back closes the lead and stays on the job, Back button then goes Home in one step; drawer ✕ closes; sign out → sign-in; viewer sees no New search, no Users, no Cancel. Also: add user (generated password), role change toast, cancel dialog → queued cities Cancelled, Retry failed cities → city running again, CSV download, `/` focuses lead search, sort by company A–Z, a fresh search running to a finished lead list with live progress. No page errors in any run.

## Known gaps

- Only checked against the mock; the real server (lane D) is not exercised yet. First thing to check after merge: login cookie, 401 JSON on `/api/*`, SPA fallback (any non-`/api` path → `index.html`), CSV/XLSX `Content-Disposition: attachment`.
- All leads of a search load at once and page client-side (50 per page). Fine for thousands; tens of thousands would want server paging.
- Rough time on New search adds up 1.5 min per ZIP for every city to scrape; it doesn't divide by workers or states running in parallel, so it errs long.
- Phone: the map city names are hidden (too small at 136 px); the Searches status filter scrolls sideways.
- Password length (≥ 8) and "can't change your own role / turn yourself off" are client rules only — the server must enforce them too. Role-based hiding is cosmetic; the server must refuse viewers.
- `apps/web/dist/` is not in the root `.gitignore` (outside this lane) — please add `apps/web/dist`.
- Not tested: Safari / iOS, very long names in the drawer title beyond wrapping.

## Contract changes I'd want (none needed to ship)

1. `JobSummary.currentCity: string | null` — the city running now, so Home / Searches rows can say "Now: San Antonio, TX" without loading each job.
2. `WorkerInfo.jobId: number | null` (next to `doing`) so a worker's line can link to its search.
3. `ApiError.code?: string` (e.g. `bad_password`, `disabled`, `forbidden`) so messages don't depend on text.
4. Optional: `GET /api/jobs/:id/leads?list=&page=` with totals, if searches start returning tens of thousands of rows.
