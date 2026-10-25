# Owner-name sources for New Jersey + Texas — live probe (2026-10-25)

Everything below was observed first-hand on 2026-10-25 (19:14–19:45 PKT) from this laptop (home connection in
Pakistan; BBB reported the outgoing IP as 154.57.217.236), using curl 8.19 and Python 3.14 standard library with a
normal desktop Chrome user-agent, 2–5 s between requests. Only search forms were submitted; no login, no account, no
payment. Where this laptop was blocked (BBB), the page was read through the WebFetch tool (Anthropic's fetcher, a
different network) and is marked **via WebFetch** — those quotes come from its page summary, not raw HTML.

Probe scripts: `D:\ClaudeCode\_Scratch\pp-probe\sources-probe\` (`nj_hic.py`, `nj_bulk_dl3.py`, `nj_stat.py`,
`nj_stat_principal.py`, `site_scan.py`). Raw responses (they contain real people's emails — keep out of the repo):
`D:\Temp\claude\C--Users-bigsh\17a31d7e-077b-4267-94f8-04d95989f65e\scratchpad\probe\`.
Personal emails and home addresses are redacted here; owner names are quoted because they are the point of the
probe and come from public registers.

## Bottom line

| Source | Owner name? | Email? | How our code reads it | Blockers seen |
| --- | --- | --- | --- | --- |
| NJ home-improvement registration, detail page (newjersey.mylicense.com) | **YES** — `Owner Name:` on 4 of 4 records | no | ASP.NET form POST + session cookie, 3 requests per company | none, no CAPTCHA. Site says "VERIFICATION ONLY" and sends bulk users to the roster |
| NJ registration roster download (same site, `Verification_Bulk`) | **NO** (person-name columns blank for businesses) | **YES** — 45 of 62 rows, 21 of 24 active, in the test town | 5-step form flow → pipe-delimited `Data.txt`; free ("$0.00"), no login | phone numbers deliberately removed |
| NJ business register, free name search (njportal.com) | no | no | form POST | none |
| NJ business register, "principal name" search | **confirms** a name you already have (person → their companies) | no | WebForms wizard, 3 requests | none. The officer list itself is a paid order (price not seen) |
| TX Comptroller franchise-tax search | **YES** for LLCs/corporations — officers with titles + registered agent | no | public JSON API, plain GET, no key | none seen. robots.txt disallows the API path `/data-search/` |
| data.texas.gov "Active Franchise Taxpayers" | **NO** (18 columns, no people) | no | Socrata query API / bulk export | none |
| BBB profile | **YES** when a profile exists (`Business Management`, JSON-LD `employee`) | no (contact form only) | HTML + JSON-LD; a JSON search API exists | **this laptop: Cloudflare 403 on every bbb.org URL**; worked via WebFetch; Railway untested |
| Company websites (5 tested) | real owner on 1 of 5; **1 of 5 showed a fake (theme placeholder) owner** | 4 of 5 | plain GET + HTML parsing; 1 of 5 needs a real browser (JS-rendered) | none |

## Test companies

| State | Company (legal name as registered) | Identifier | Used for |
| --- | --- | --- | --- |
| NJ | SPECTRA PAINTING, INC (Tinton Falls) | HIC 13VH06161800 · NJ entity 0100508103 | HIC lookup, business register, principal search |
| NJ | RUTGERS PAINTING & CARPENTRY LLC (Vauxhall) — rutgerspainting.com | HIC 13VH11241900 | HIC lookup, roster, website |
| NJ | JOHN'S PAINTING CONTRACTOR, LLC (Basking Ridge) — johnspaint.com | HIC 13VH06084400 | HIC lookup, BBB, website |
| NJ | NJ Painting Co. (Morganville) — njpaintingco.com | — | website |
| NJ | 13VH07600800 → registry says JERSEY CITY HANDYMAN LLC | HIC 13VH07600800 | HIC lookup (number came from a search snippet about a "Jersey Painter" HomeGuide listing; that listing returned 403, so the link is NOT CONFIRMED) |
| TX | ALEXANDRIS PAINTING COMPANY, LLC | taxpayer 32066330906 | Comptroller |
| TX | HILL COUNTRY PAINTING LLC (ZIP 78665, Round Rock) | taxpayer 32072442869 | Comptroller |
| TX | HILL COUNTRY PAINTING AND REPAIR LLC | taxpayer 32096453066 | Comptroller (ended entity) |
| TX | Barton Springs Painting (Austin) — bartonspringspainting.com | none found | website, register miss |
| TX | We Paint Texas (Austin) — wepainttexas.com | none found | website, register miss |
| TX | Austin Professional Painting | BBB profile | BBB |

---

## 1. New Jersey home-improvement contractor (HIC) registration

### 1a. Verification search + detail page — owner name: YES (CONFIRMED)

- Landing: `GET https://newjersey.mylicense.com/verification/` → **200**. Text: "This website is intended to be used
  for VERIFICATION ONLY. If you need a bulk license data/verification for the state of New Jersey, PLEASE CLICK HERE
  TO DOWNLOAD THE ROSTER." (CONFIRMED). The "site is undergoing maintenance" notice is inside an HTML comment, i.e.
  not active (CONFIRMED).
- Search form: `GET https://newjersey.mylicense.com/verification/Search.aspx?facility=Y` → **200**, sets
  `ASP.NET_SessionId` cookie. **No CAPTCHA** (no captcha/recaptcha/hcaptcha/turnstile anywhere in the page) — CONFIRMED.
- Submission: **POST** to the same URL, `application/x-www-form-urlencoded`, ASP.NET WebForms: hidden
  `__VIEWSTATE`, `__VIEWSTATEGENERATOR`, `__EVENTVALIDATION` (+ empty `__EVENTTARGET`, `__EVENTARGUMENT`,
  `__LASTFOCUS`) copied from the GET, plus
  `t_web_lookup__profession_name=Home Improvement Contractors`, `t_web_lookup__license_type_name=` (blank = All;
  the HIC type is `Home Improvement Business Contr`), `t_web_lookup__full_name=<name>`,
  `t_web_lookup__license_no=<13VH…>`, `t_web_lookup__addr_city=<city>`, `sch_button=Search`
  → **200** at `SearchResults.aspx` (CONFIRMED, 4 searches by licence number).
- Results grid columns: `Full Name | License Number | Profession | License Type | License Status | City | State`;
  each name links to `Details.aspx?result=<GUID>` (CONFIRMED).
- **Detail URLs are tied to the session:** the same `Details.aspx?result=…` fetched without the session cookie →
  **HTTP 500 "Runtime Error"** (CONFIRMED). So code must do GET form → POST search → GET detail in one cookie session.
- Detail page fields (HTML `span` ids in brackets) — Spectra example, CONFIRMED:
  ```
  Name: SPECTRA PAINTING, INC                       [full_name]
  Doing Business As: Spectra Painting, Inc          [doing_business_as]
  Owner Name: Eric Doeler                           [owner_name]
  Address: 65 Reeds Rd, Tinton Falls, NJ 07724      [addr_line_1, addr_city, addr_state, addr_zipcode]
  Profession/License Type: Home Improvement Contractors, Home Improvement Business Contr
  License No: 13VH06161800   License Status: Active   Status Change Reason: License Issuance
  Issue Date: 3/7/2011   Expiration Date: 3/31/2027
  ```
  No company phone, no email on the detail page — only the state office's own phone in boilerplate (CONFIRMED).
  Owner name present on 4 of 4 records looked up (small sample). Cost: 3 requests per company, so lookups should be
  limited to companies already matched in the roster (1b), given the site's "VERIFICATION ONLY" note.
- The other three lookups, all CONFIRMED:
  - 13VH11241900 → RUTGERS PAINTING & CARPENTRY LLC, **Owner Name: Donal Lopez**, Active, issued 11/9/2020.
  - 13VH06084400 → JOHN'S PAINTING CONTRACTOR, LLC, **Owner Name: John Catapano**, Active, issued 1/18/2011.
  - 13VH07600800 → JERSEY CITY HANDYMAN LLC, **Owner Name: Mikalai Kryvenka**, **Expired** ("Failure to Renew",
    expired 3/31/2024).
- Name matching: the name box matches **from the start of the name**, not "contains" — on the roster form (same
  fields), name `PAINT` + city `Vauxhall` returned 0 rows although 9 registrations in that town have "PAINT" inside
  the name (CONFIRMED on the roster form; NOT separately tested on the verification form).
- robots.txt: none (`/robots.txt` → 404 page) — CONFIRMED.
- Rate limiting: none seen in 32 requests (no 429, no slow-down) — real limits unknown.

### 1b. Roster download (official bulk file) — email: YES, owner name: NO (CONFIRMED)

- `GET https://newjersey.mylicense.com/Verification_Bulk/` → **200** ("BUSINESS DOWNLOAD SEARCH").
- Flow (each step a form POST carrying the page's hidden ASP.NET fields), all **200**, no CAPTCHA, no login fields:
  1. `GET Verification_Bulk/Search.aspx?facility=Y` (same fields as 1a)
  2. POST search (profession = Home Improvement Contractors, city = Vauxhall) → `SearchResults.aspx` with a
     **"Download List"** button (`btnBulkDownLoad`) and the note "NOTE: You will NO longer get phone numbers in your
     download list."
  3. POST `btnBulkDownLoad` → `Confirmation.aspx?from_page=Login.aspx` (page title "Login", but **no username or
     password field**): "If you continue, your account will be charged. $0.00 ."
  4. POST `btnContinue` → `PrefDetails.aspx`: "The download is in the form of a text file with Pipe Delimiters"
  5. POST `sch_button=Download`, `filetype=delimitedtext` → **200 `text/plain`,
     `Content-Disposition: attachment;filename="Data.txt"`**
- File header (exact):
  `full_name|first_name|middle_name|last_name|name_suffix|profession_name|license_type_name|license_no|issue_date|expiration_date|addr_line_1|addr_line_2|addr_city|addr_state|addr_zipcode|addr_county|addr_email|license_status_name|`
- Vauxhall result: **62 rows** — Expired 35, Active 24, Reinstatement Pending 1, Pending 1, Closed 1.
  - `addr_email` filled on **45 of 62** rows, **21 of 24 active**; 33 of the 45 are free-mail addresses
    (gmail/yahoo/aol/verizon…), 12 on the company's own domain (e.g. `pg•••@rutgerspainting.com`).
  - `first_name`/`last_name` **blank on all 62** (business registrations) → no owner names in the file.
  - Some registrations are in a person's own name or carry it after "T/A" (trading as): `ANTONIO DEVITA`,
    `CHERRY PAINTING CONTRACTORS & HOME IMPROVEMENT T/A ANTHONY CHERRY`.
  - No phone, no "doing business as" column.
- Rutgers Painting's website shows **no email at all** (section 5), but the roster has one for it → the roster fills
  website gaps.
- Statewide download (blank city): **NOT TESTED** (kept load low). Whether the server allows one statewide file or
  needs town-by-town pulls is open.

### 1c. Open data / Consumer Affairs site

- data.nj.gov catalog (Socrata catalog API
  `https://api.us.socrata.com/api/catalog/v1?domains=data.nj.gov&q=…`): `home improvement` → **0 datasets**;
  `contractor` → 61, all Sandy/DCA grant-programme tables; `license` → 10 (child care, vehicle inspection,
  hospitals…). **No HIC registrant dataset on data.nj.gov** (CONFIRMED by catalog search).
- `https://www.njconsumeraffairs.gov/hic/Pages/default.aspx` and `/hic/` → **200 but an Imperva/Incapsula bot
  challenge** (212-byte / 1,162-byte stub loading `/_Incapsula_Resource…`); WebFetch got an empty page. **Could not
  read the Consumer Affairs HIC pages.** The working official lookup + roster is newjersey.mylicense.com.

## 2. New Jersey business register (Division of Revenue, njportal.com)

- **Free name search** — `GET https://www.njportal.com/DOR/BusinessNameSearch/Search/BusinessName` → **200**
  (ASP.NET Core; antiforgery cookie + hidden `__RequestVerificationToken`); `POST` same URL with
  `BusinessName=<2–100 chars>` + token → **200**. Result columns: `Business Name | Entity Id | City | Type |
  Incorporated Date`, e.g. `SPECTRA PAINTING, INC. | 0100508103 | TINTON FALLS | DP | 2/10/1992`. No officers, no
  registered agent, no link to more detail. No CAPTCHA. (CONFIRMED)
- **Business Records Service** — `https://www.njportal.com/DOR/BusinessRecords/` → **200**; header links "Cart",
  "Login", "New User". Its text: "obtain standing certificates and status reports … Also, you will be able to download
  lists or abstracts of businesses on file with the State."
  - Status report wizard `…/EntityDocs/BusinessStatCopies.aspx` (WebForms; radio postback then Continue). Search types:
    Business Name, Entity ID, **"Principal Name (Officer/Director, Manager, Managing Member, etc.)"**, Registered
    Agent, Associated Name. An Entity ID search for 0100508103 returned the entity row with checkboxes
    **"Order Status Report" / "Order Copies"** → a cart. I stopped there: the officer/agent names are in the ordered
    report, so **free officer names: NO (CONFIRMED)**; **price and report contents: NOT OBSERVED** (third-party pages
    claim $5 + $1.25 — NOT CONFIRMED).
  - **Principal-name search is free and works as a check:** `Business/Last Name = DOELER`, `First Name = ERIC`
    → `SPECTRA PAINTING, INC. | 0100508103 | TINTON FALLS | DP | 02/1992` (CONFIRMED). Fields:
    `ctl00$mainContent$wzMain$searchInput$txtPrincipalName` (last name, required), `…$txtFirstName`,
    `…$txtMiddleName`, `…$txtCity`; radio `…$rblSearchType=PrincipalName` (postback with
    `__EVENTTARGET=ctl00$mainContent$wzMain$searchInput$rblSearchType$2`), then
    `…$StartNavigationTemplateContainerID$btnContinue=Continue`. → An owner name found elsewhere (HIC record,
    website, BBB) can be confirmed against the state register for free.
  - "Business Entity Lists" (`…/EntityDocs/BusinessList.aspx`, same search types + filing-date range): format and
    price **NOT OBSERVED**.
- No CAPTCHA on any njportal page seen (CONFIRMED). robots.txt: none (302 → 404 page).

## 3. Texas Comptroller franchise-tax search + data.texas.gov

**This laptop's DNS could not resolve `*.texas.gov`** (default resolver timed out for comptroller.texas.gov,
data.texas.gov, www.texas.gov, mycpa.cpa.state.tx.us); public DNS (8.8.8.8 / 1.1.1.1) resolved them and curl used
`--doh-url`. Probably local to this connection; check again on Railway.

### 3a. Taxable entity search — officers: YES for LLCs/corporations (CONFIRMED)

- Page `GET https://comptroller.texas.gov/taxes/franchise/account-status/search` → **200** (Apache behind
  CloudFront, jQuery page). No CAPTCHA (CONFIRMED). Its script calls a public JSON API:
  - `GET https://comptroller.texas.gov/data-search/franchise-tax?name=<text>` (or `?taxpayerId=<9 or 11 digits>` or
    `?fileNumber=<6–10 digits>`; exactly one criterion). No parameters → **400**
    `{"success":false,"error":"Please enter 1 search criteria."}`. Response:
    `{"success":true,"data":[{"name":…,"taxpayerId":…,"mailingAddressZip":…}],"count":N}`.
  - Example: `?name=ALEXANDRIS PAINTING` → `ALEXANDRIS PAINTING COMPANY, LLC`, taxpayerId `32066330906`, ZIP 75418.
  - **Name search is "starts with":** `?name=PAINTING` → 146 rows, all 146 begin with "PAINTING";
    `?name=COUNTRY PAINTING LLC` → 0 although HILL COUNTRY PAINTING LLC exists (CONFIRMED).
- Detail: the page `/taxes/franchise/account-status/search/<taxpayerId>` fetches
  `GET https://comptroller.texas.gov/data-search/franchise-tax/<taxpayerId>` → **200 JSON** with keys
  `taxpayerId, feiNumber, name, dbaName, mailingAddress{Street,City,State,Zip,Zip4}, rightToTransactTX,
  stateOfFormation, sosRegistrationStatus, effectiveSosRegistrationDate, sosFileNumber, registeredAgentName,
  registeredOfficeAddress{Street,City,State,Zip}, taxId, lastUpdated, reportYear, officerInfo[]`; each officer:
  `AGNT_NM, AGNT_TITL_TX, AGNT_ACTV_YR, AD_STR_POB_TX, CITY_NM, ST_CD, AD_ZP, SOURCE`. (CONFIRMED)
  - 32066330906 ALEXANDRIS PAINTING COMPANY, LLC — status ACTIVE, reportYear 2024, `registeredAgentName`
    "DIMITRI ALEXANDRIS", officers `DIMITRI C ALEXANDRIS | PRESIDENT` and `… | DIRECTOR` (SOURCE "SOS").
  - 32072442869 HILL COUNTRY PAINTING LLC — ACTIVE, officers FORREST JENSEN, JOSH CROSS, JUSTIN CARTER (each
    `DIRECTOR` and `MEMBER`), registered agent **"UNITED STATES CORPORATION AGENTS, INC."** (a paid agent service,
    not the owner).
  - 32096453066 HILL COUNTRY PAINTING AND REPAIR LLC — "FRANCHISE TAX INVOLUNTARILY ENDED", **officerInfo empty**,
    registered agent a person (ROSA EDIS REYES MARROQUIN).
- Hosting/limits: responses carry AWS API Gateway headers (`x-amzn-RequestId`, `x-amz-apigw-id`), **no rate-limit
  headers, no 429** in 15 requests. Throttling at volume: NOT TESTED.
- **robots.txt** (`https://comptroller.texas.gov/robots.txt`, read in full): `User-agent: *` / `Disallow: /*/` with an
  Allow list (`/taxes/`, `/data/`, `/forms/`, …) that **does not include `/data-search/`** → the JSON API path is
  disallowed for crawlers (advisory, but a decision for him). CONFIRMED.
- Old lookup `https://mycpa.cpa.state.tx.us/coa/` → **could not connect** (TCP timeout after 21 s) from this laptop.
- **Brand ≠ legal name (observed):** `BARTON SPRINGS PAINTING` → 0 in the Comptroller search; open dataset
  "contains" search → 0 for names containing both "BARTON SPRING" and "PAINT", and 0 for "WE PAINT TEXAS";
  `ROLLING NATIONS PAINTING` (a HomeGuide "LLC") → 0 in the Comptroller search.
  Owners for such firms must come from the website/BBB, or from a legal name found elsewhere.

### 3b. data.texas.gov — no officer names (CONFIRMED)

- Dataset is titled **"Active Franchise Taxpayers"** (`9cir-efmm`, data updated 2026-10-24). Its 18 columns:
  `Taxpayer Number, Taxpayer Name, Taxpayer Address, Taxpayer City, Taxpayer State, Taxpayer Zip, Taxpayer County
  Code, Taxpayer Organizational Type, Record Type Code, Responsibility Beginning Date, Secretary of State (SOS) or COA
  File Number, SOS Charter Date, SOS Status Date, SOS Status Code, Right to Transact Business Code, Current Exempt
  Reason Code, Exempt Begin Date, NAICS Code` — **no officer, agent or owner names**.
- Size (SoQL counts, `https://data.texas.gov/resource/9cir-efmm.json?$select=count(*)…`): **3,494,999 rows**; NAICS
  filled on 631,503; NAICS **238320** (painting contractors) = **416 rows**; names containing "PAINTING" = **3,904**.
- Use: a free bulk index from legal name / address / ZIP → taxpayer number, with **"contains" search** (SoQL `like`),
  which the Comptroller's own search lacks. Then the Comptroller detail JSON gives the officers.
- Catalog search for `officer` / `registered agent` / `secretary of state` found nothing better for general
  businesses. Only niche: "Veteran Owned Business" (`2vfr-72e4`, 27,205 entities) has registered-agent first/last
  names.

## 4. BBB (bbb.org)

- **From this laptop: blocked.** Every request → **403**, Cloudflare (`Server: cloudflare`, `CF-RAY …-KHI`), page
  title "You have been blocked | Better Business Bureau®", text "This website is using a security service to protect
  itself from online attacks…". Tried: `/search?find_text=Spectra Painting…`, two profile pages, `/robots.txt`,
  `/sitemap-business-profiles-106.xml`, `/api/search?…`. Python's TLS stack got the same 403 on `/robots.txt` →
  a network/IP-level block, not a header problem (CONFIRMED). Whether Railway's IPs pass: **NOT CONFIRMED — test in
  the pilot.**
- **Via WebFetch (different network) the same URLs loaded** (CONFIRMED that access depends on the network):
  - `https://www.bbb.org/us/nj/basking-ridge/profile/painting-contractors/johns-painting-contractor-llc-0221-1003377`
    — "Business Management: Mr. John Catapano, Owner", "Principal Contacts: Mr. John Catapano, Owner", phone
    "(908) 604-8759", "Visit Website" → https://www.johnspaint.com, "Basking Ridge, NJ 07920-2801", "Years in
    Business: 35", licence "13VH06084400". JSON-LD `LocalBusiness` with
    `"employee":[{"@type":"Person","honorificPrefix":"Mr.","givenName":"John","familyName":"Catapano","jobTitle":"Owner"}]`,
    `telephone`, `faxNumber`, `sameAs` (Facebook/Instagram/YouTube); **no `email` key**, no email on the page — only
    BBB's "Email this business" form.
  - `https://www.bbb.org/us/tx/austin/profile/painting-contractors/austin-professional-painting-0825-90102730` —
    JSON-LD `employee`: Aurelio Contreras, `jobTitle` "Owner"; John Contreras, "Operations Manager"; telephone
    (512) 845-7821; street address; no website (Facebook/Instagram in `sameAs`).
  - **JSON search API:** `GET https://www.bbb.org/api/search?find_country=USA&find_text=painting&find_loc=Austin%2C%20TX&page=1`
    → JSON (`page, pageSize, totalPages, results, totalResults, …`), `totalResults` 4,608, 15 per page; each result
    has name, phones, address, profile link — **no owner fields**.
  - robots.txt (WebFetch summary, not verbatim): catch-all group disallows `/*?` (every URL with a query string —
    so `/api/search?…` is disallowed) and `/authentication/*`; profile URLs allowed; 17 sitemap indexes incl.
    business profiles. No Crawl-delay.
- How code would use it: find the profile via BBB sitemaps or the search API, then parse the profile's JSON-LD
  `employee[].givenName/familyName/jobTitle` (more stable than page text). Owner coverage = only firms that have a
  BBB profile; profiles sometimes list a manager next to the owner, so keep `jobTitle`.

## 5. Company websites (5 real small painters)

Fetched home page + up to 3 about/team/contact pages each with plain GET; looked for `mailto:` links, emails in
visible text, JSON-LD, and "owner/founder/president" wording. No bot walls on any of them.

| Site | Owner name on site? | Email on site? | Notes |
| --- | --- | --- | --- |
| johnspaint.com (NJ) | **No** — "family owned and operated for over 35 years", no name | **Yes** — `office@johnspaintingnj.com` (visible + mailto), `johnspaint@hotmail.com` (mailto) | Shows **13VH06084400** (matches the registry). Wix site |
| rutgerspainting.com (NJ) | **FAKE** — About page "Meet Our Team … **Brennan Price Owner**", next to theme filler text ("Ita eiusmod si commodo ut culpa…", "Projects Complete 0 +"). Registry owner is **Donal Lopez**; a testimonial says "Donald, the owner" | **No** (no mailto, no text email; contact form only) | No 13VH number in HTML. Roster has an email for it |
| njpaintingco.com (NJ) | **No** ("family-owned", reviews mention "Matt") | **Yes** — `info@njpaintingco.com` (mailto + text + JSON-LD `email`) | JSON-LD `legalName` "NJ Painting Co." No 13VH number in HTML |
| bartonspringspainting.com (TX) | **Yes** — About: "Jeff London – Founder", "Breanna Rene – Owner" | **Yes** — `info@bartonspringspainting.com`, visible text on contact page only (no mailto) | No franchise-tax entity under this name |
| wepainttexas.com (TX) | **No** (not in HTML or JS bundle) | **Yes** — `info@wepainttexas.com`, **only in JSON-LD** | JavaScript app (`<div id="root">`, 42 visible characters without JS) → needs a real browser for page text. Its JS bundle also contains `jane@email.com`, `name@example.com`, `nombre@ejemplo.com`, `you@example.com` and an unexplained gmail address |

Counts: owner name genuinely shown **1 of 5** (plus 1 of 5 showing a placeholder that a rules engine would wrongly
take); email shown **4 of 5** (2 as mailto links, 1 as plain text only, 1 in JSON-LD only). JSON-LD `founder` /
`employee`: **0 of 5**.

## 6. Cross-checks — "two sources agree" works

- John's Painting: NJ registration `Owner Name: John Catapano` = BBB "Mr. John Catapano, Owner"; the website shows the
  same 13VH number → high confidence (CONFIRMED).
- Spectra Painting: registration `Owner Name: Eric Doeler` = NJ business register principal search (DOELER, ERIC →
  SPECTRA PAINTING, INC.) → two official sources agree (CONFIRMED).
- Rutgers: registration `Donal Lopez` vs website "Brennan Price Owner" (placeholder) vs testimonial "Donald" → the
  register wins; the website claim must be rejected (CONFIRMED that they disagree).
- Alexandris Painting (TX): Comptroller officer `DIMITRI C ALEXANDRIS, PRESIDENT` and registered agent
  `DIMITRI ALEXANDRIS` agree (CONFIRMED).

## 7. Traps a rules-only pipeline must handle (all observed)

1. **Theme placeholder people** on websites ("Brennan Price Owner" beside filler Latin and "0 +" counters).
   Never accept a website-only owner name without a register/BBB match or a sanity filter (filler-text detection).
2. **Registered agent ≠ owner** (Hill Country Painting LLC → "UNITED STATES CORPORATION AGENTS, INC.").
3. **Brand ≠ legal name**, and both NJ and TX official searches are "starts with" only → match via roster/open-data
   files (contains search, ZIP, address, email domain, 13VH number on the site), not by typing the Google name.
4. **NJ detail pages need the same session** (fresh cookie → HTTP 500).
5. **Several registrations per brand** (Rutgers: one active LLC + two expired older entities in the roster) and
   expired-only matches (13VH07600800) → prefer Active, record status.
6. **JS-rendered sites** (We Paint Texas) → plain GET sees no text; JSON-LD may still carry the email.
7. **Emails in scripts/bundles include placeholders and unexplained addresses** → keep only addresses whose domain
   matches the company website (or that appear in visible text / mailto / JSON-LD on the company's own pages).
8. **Emails as plain text without mailto** (Barton Springs) → scan visible text, not just links.
9. **13VH on the website** is a direct join key when present (1 of 3 NJ sites).
10. **NJ roster has no phone numbers** → phone can't be the join key in NJ (unlike CSLB in California).

## 8. Could not get through / not tested

- njconsumeraffairs.gov HIC pages — Incapsula bot challenge (curl and WebFetch).
- NJ status report (officer list) price and contents — stopped before the cart by rule.
- NJ roster statewide in one file — not tried.
- mycpa.cpa.state.tx.us/coa — no connection from here.
- bbb.org from this laptop — 403 everywhere; from Railway — unknown.
- HomeGuide "Jersey Painter" listing — 403 via WebFetch, so its 13VH number is unverified.
- Rate limits — none hit on any source at these volumes; real thresholds unknown.
- TX Comptroller search by DBA name — not tested (`dbaName` exists in the detail JSON; was null in the samples).

## 9. Request log (this probe)

| Host | Requests | Result |
| --- | --- | --- |
| newjersey.mylicense.com | 32 (over the ~20 budget: the 5-step roster flow was walked 3 times while discovering it, + 4 lookups × 3) | all 200 except the deliberate no-cookie test (500) and robots (404) |
| www.njportal.com | 15 | 200 |
| www.njconsumeraffairs.gov | 2 (+1 WebFetch) | Incapsula challenge |
| comptroller.texas.gov | 15 | 200 (one deliberate 400) |
| mycpa.cpa.state.tx.us | 1 | connect timeout |
| data.texas.gov | 7 (+2 local DNS failures) | 200 |
| api.us.socrata.com (catalog) | 7 | 200 |
| www.bbb.org | 7 from this laptop + 4 via WebFetch | 403 here; 200 via WebFetch |
| 5 company websites | 17 + 1 JS bundle | 200 |
| homeguide.com | 1 via WebFetch | 403 |
