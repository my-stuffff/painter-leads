# Painter Promotions — State Lead Finder: discussion notes (2026-10-25)

## ⭐ LATEST RULING (2026-10-25, later) — supersedes the CSV-input design below

"Forget the 55k CSV, scrape on your own for now": **New Jersey, Texas, California.** Fill for every company at
the very least: **owner/decision-maker name, phone, email, website, Google rating, number of ratings.** Target =
painting contractors doing **residential painting exclusively**. Accuracy "on par with Findversity or more".
Still: no third-party services, no AI (rules only), our own scraper.

### Feasibility (checked 2026-10-25)

- **Phone, website, rating, review count** — read straight off each company's Google Maps listing by our own
  scraper → right for nearly every company (as of the capture date). Proven possible without outside services: the
  free open-source tool gosom/google-maps-scraper (MIT, runs locally) pulls exactly these fields; we write our own or
  reuse it. Risk: Google changes its page and breaks scrapers; Google challenges heavy traffic.
- **Statewide coverage** — Google Maps shows ~120 results per search, so each state is searched city by city /
  ZIP by ZIP (thousands of searches across the three states) → days of careful run time, not hours.
- **Owner name by state:**
  - **California — strong.** The state contractor board (CSLB) gives a FREE statewide download: license master
    (business name, address, phone, classification e.g. C-33 Painting) + personnel file (names and titles per
    license). Match each Google listing to its license by phone/name/address → owner names for most CA painters.
    No emails in it (state law).
  - **New Jersey — medium.** Anyone doing residential (non-commercial) improvement work must register as a Home
    Improvement Contractor (number starts 13VH, must appear on their website/ads); lookup at
    newjersey.mylicense.com — whether it shows owner names is unconfirmed (to probe). Plus websites, BBB.
  - **Texas — weakest.** No state painter license. Owners from the company website, BBB, and the Comptroller's
    free per-company "Taxable Entity Search" (officers/directors for LLCs/corporations). One-person outfits with no
    website often have no owner name published anywhere.
- **Email** — only where published: the company's website (contact/about/footer), Facebook/BBB pages. Never guessed.
  Some rows will honestly be "not found".
- **Where the scraper runs** — Google is harsher on data-centre traffic (Railway) than on a home connection, and
  proxies are an outside service (ruled out). The pilot tests Railway; fallback = the scraper runs on this PC and
  sends results to the Railway app (same pattern as Findversity's PC sync agent).
- **"Residential exclusively" (rules only)** — decided from Google category, company name, website service pages
  ("interior/exterior house painting, cabinets, homeowners" vs "commercial, industrial, HOA, property management,
  multi-family, new construction") and, where there's no website, what reviewers describe. Default: qualified list =
  residential only; companies that also advertise commercial work stay in the master list marked
  "excluded: also commercial". Unclear ones marked "unclear", not dropped.
- **Accuracy bar (Findversity-level):** every filled value stores its source link + capture date; owner names need
  a source that ties the person to THIS company (licence record, "owner/founder" on its site); two sources agreeing =
  high confidence; before delivery a random 50 rows per state are hand-checked against the live sources, target ≥98%
  of filled values correct; nothing guessed.

### Recommended next step

Pilot first: one metro per state (~300 companies total), full pipeline, hand-check, report real fill rates
(owner %, email %) and accuracy, and test whether Railway can scrape. Then the full three-state run.

Sources: CSLB data portal https://web.cslb.ca.gov/Onlineservices/DataPortal/ContractorList ·
NJ HIC rules https://www.njoag.gov/?p=83046 · gosom scraper https://ossinsight.io/analyze/gosom/google-maps-scraper ·
Texas franchise-tax data https://catalog.data.gov/dataset/active-franchise-tax-permit-holders

---


Status: DISCUSSING. Nothing built. No accounts touched. Waits the sample CSV + open answers, then GSD plan, then his word.

## His rulings (2026-10-25)

1. **Input = a CSV the client provides** with the companies' details. The system does NOT go find companies on
   Google Maps itself; it filters the CSV down to the target list.
2. **Owner names + emails: free sources only, but extremely accurate, real effort.**
3. **No data or third-party services at all** — no Apify/Outscraper, no paid email finders. The system does every
   step itself, end to end.
4. **GitHub owner: `my-stuffff`.** Hosting: a new paid Railway account.
5. **Missing rating/review count** (rare — the CSV almost always has them): the system ALERTS the user listing the
   rows; only on the user's go-ahead does it open those companies' Google Maps pages itself to read them.
6. **No AI.** Owner names and "residential or not" are decided by rules only.
7. **Users:** Partnerships Manager + Account Executive, and an admin can add more people with different access.
   Proposed roles (confirm in plan): **Admin** (everything + manage users) · **Operator** (upload, run, approve
   Maps look-ups, download) · **Viewer** (see results, download only).

## What the product is now

Upload a CSV (and say which state it's for, unless the file already says) →
1. **Read + clean** — map the file's columns, fix phone/ZIP/URL formats, drop exact duplicates.
2. **Match against what we already have** — the same company seen in an earlier upload is updated, not added
   twice; new companies are flagged as new.
3. **Filter to the target** — residential painter, has a Google profile, rating 4.7+, 10–99 reviews. Every row
   kept in the master list with a clear "qualified" / "excluded because …" / "unclear because …".
4. **Find missing owner name, email, phone** — our own crawler reads public pages (below), every value stored
   with where it came from, when, and how sure we are.
5. **Report** — Excel download: Master · Qualified · By city · Contact completeness · Summary (counts found /
   qualified / excluded / missing contact, sources, dates). CSV too.

## Where owner name and email can come from, with no outside services

Our system fetches these public pages itself:
1. **The company's own website** (if the CSV gives it) — contact/about/team pages, `mailto:` links, footer,
   structured data, "owner/founder" wording. Usually the best source for email.
2. **State business registers** — many are free and list owners/officers (e.g. Florida Sunbiz; Texas Comptroller
   franchise-tax lookup lists officers). Each state's site is different, so this is built state by state,
   starting with the states he uses first. Some states charge or use CAPTCHAs — those get marked "not available".
3. **BBB pages** — often name the owner/principal. May have bot protection; tested before relying on it.
4. **The company's Facebook page / Google review owner replies** — only if the link is in the CSV; likely blocked
   at volume, so best-effort.

Not possible under "no outside services": searching the web for a company (Google/Bing block automated searches,
and Bing's search API was retired), and buying email lists. So a company with no website and no register entry
will often end up with no email — the report says so honestly instead of guessing.

**Accuracy rules** (his "extremely accurate"): an email counts only if it's on the company's own pages or its domain
matches the company website; an owner name counts only if a page ties it to this company ("owner", "founder",
"president", registered officer). Two sources agreeing = high confidence. Nothing is guessed (no "first@domain"
pattern guessing presented as found).

**Checking an email really works** — we can check that the domain accepts mail (free, safe). Asking the mail server
whether the mailbox exists is unreliable and can get the server's address blacklisted; recommend not doing it.

## "Residential" is not a field

Decided from the company's categories/description in the CSV and its website wording ("interior", "cabinet
refinishing", "homeowners" vs "industrial", "commercial only"). Rows that can't be decided → "unclear", not dropped.

## What the app looks like (sketch before building — checklist #1)

Sign-in, then three screens:
1. **Upload** — drop CSV, pick state, confirm the column mapping, Start; live progress.
2. **Uploads / runs** — history per state with counts.
3. **Results** — filterable table (qualified only, city, missing email…) + Download Excel / CSV.

## Rough build (his orchestrate fleet)

- Me first: repo on `my-stuffff`, database layout, the shared "company record" shape (one owner of the database).
- Then parallel workers in separate areas: (A) CSV import + cleaning + matching + qualification, (B) the crawler:
  website + register + BBB readers with confidence rules, (C) web screens + Excel export.
- Me last: merge, deploy to Railway (web + background worker + Postgres), run his real CSV end to end.
- Speed checklist: sketch approved first; browser tests in GitHub Actions; light proof (one desktop + one phone
  check) — the high-proof area is the accuracy rules, tested against a hand-checked sample; ~4 plans; worktrees
  deleted on merge.

## The sample CSV he gave (2026-10-25) — what it actually is

File: `C:\Users\bigsh\Downloads\Export_Contacts_All_Oct_2026_2_05_AM.csv` (10 MB). Real people's phones/emails —
stays on this machine, never committed to GitHub; tests use made-up rows.

- It is the client's **CRM contact export** (GoHighLevel: "Contact Id", tag `cohort_in_ghl`), not a fresh list:
  **55,029 contacts**, 9 columns only — Contact Id, First Name, Last Name, Phone, Email, Business Name, Created,
  Last Activity, Tags.
- **Missing everything the target filter needs:** no rating, no review count, no Google profile link, no website,
  no address/city/ZIP, no category.
- Location: only **11,080 rows (20%)** have any state hint, and only inside tags (`forest_lake_mn`,
  `pipeline_primers_painting_florida`…). Every phone is a +1 number, so area code could give a *probable* state.
- Contact depth: phone on 99.8% (all unique — the CRM de-duplicates on phone), email on 12% (6,708; about half
  Gmail/Yahoo-type), owner first name on 2% (1,091).
- Junk to filter: 13 Google notification contacts, 95 domain-privacy emails (`withheldforprivacy.com` etc. — not
  real owner inboxes), internal test contacts.
- **Their tags show where the data came from:** `painter_promotions_outscraper_october10th` (24,718),
  `outscraper_csv`, `pipeline_primers_apify_utah_oct1`, `colorado claude leads non lsa`. So they already buy
  Outscraper/Apify exports — and THOSE files carry rating, reviews, website, address and category.
- The tags also carry sales history worth respecting: `pipeline_primers_painting_disqualified` (4,326),
  `bad_number` (445), `client`/`paid` (33), `agreement_signed` (37), `strategy_call_scheduled` (385),
  cold SMS/email campaign tags, and LSA status (`running_lsas_…`, `notrunning_lsa…`, `lsa_rank_N`).

**What this means for the design:** this file can't be filtered against the target criteria by itself — it would
mean looking up ~55k companies on Google Maps, which one server can't do without being blocked. Proposed:
(a) the **upload** is the raw Outscraper/Apify-style export (has the fields); (b) this **CRM export** is loaded
as "already known" so every new list flags who is already a client, disqualified, a bad number or already
contacted — no one is prospected twice.

## Open questions

1. **Can the client send one raw company export** (the Outscraper/Apify file behind `outscraper_csv`) as the real
   sample? And confirm the CRM export's role = "already known / don't re-prospect" list.
2. ~~Missing rating~~ → ruling 5. ~~AI~~ → ruling 6 (no). ~~Who signs in~~ → ruling 7.

## Rejected (for the record)

Apify / Outscraper / Google's official Places service for finding companies — ruled out by "no third-party
services" (Places also forbids keeping its data). Paid email finders — same.
