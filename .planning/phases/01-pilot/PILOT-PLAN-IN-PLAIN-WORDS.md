# Pilot plan — in plain words (2026-10-25)

**What the pilot proves:** in one city per state — Edison NJ, Austin TX, San Diego CA — our own system finds the
painting companies on Google Maps, keeps the home-only painters, fills owner name / phone / email / website / rating /
number of ratings from public pages, and hands back an Excel file. Then we check 50 companies per state by hand
(without looking at the system's answers first) to measure how often it is right. Target: 98% of filled values correct.

**Size:** about 135 Google searches (Edison's 3 ZIP codes, 12 ZIP codes each in Austin and San Diego, 5 search phrases
each). Under a day of careful scraping. Expect a few hundred companies per city.

**Where owner names and emails come from (all free, no outside services, no AI):**
- California: the state contractor board's free download (owner/officer names for licensed painters).
- New Jersey: the state's home-improvement registration (shows "Owner Name"; its download also has emails).
- Texas: the state tax office's company lookup (officers of LLCs/companies) — **needs your OK, see below**.
- Every state: the company's own website. BBB only where it lets us in (it blocks this laptop).
- Nothing guessed. A blank stays blank. Every filled cell keeps its source link and date.

**How it gets built (your usual fleet):**
1. One worker builds the base: database, settings file, page fetcher, shared rules (about half a day).
2. Four workers in parallel: Google Maps scraper · state registers · website reader · merging + Excel report.
3. I run the three cities, a separate checker does the blind hand-check, fixes go to fresh workers, the checked
   companies become automatic tests, and you get the workbooks + a one-page pilot report to open.

**The Excel file** (please glance — this is the "look"): tabs Qualified · Master list · By city · Contact completeness
· Summary · Sources. Qualified columns: Company · Owner · Owner title · Owner source · Owner confidence · Phone · Email ·
Email source · Website · Google rating · Google reviews · Google link · Category · Address · City · ZIP · State ·
Licence/registration no. · Residential status · First seen · Last checked.

**What I need from you:**
1. **"Go"** — this also approves the code libraries in the base plan (all mainstream, I checked each one's source and
   that none runs install scripts).
2. **Texas:** the state's lookup asks automated tools not to use it (a polite request, not a legal block). It is the
   only free source of Texas owner names. My recommendation: use it gently — one lookup every few seconds, only for
   companies we already matched. Yes or no?
3. **Railway:** create the new paid account when you can and give me access. Not needed to start. It lets us test
   whether Google allows scraping from a server, read BBB, and download two files this laptop can't get (a names list
   and California's officer-names file). Without it, those carry to the web-app stage.

**Honest limits:** with 50 companies per state, the accuracy numbers per state are a good sign, not proof — the
report shows the margin of error. Owner names and emails will be missing wherever no public page shows them.

Technical plans: `01-01-PLAN.md` … `01-06-PLAN.md` in this folder.
