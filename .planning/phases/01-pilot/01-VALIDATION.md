---
phase: 1
slug: pilot
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-10-25
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: `01-RESEARCH.md` § Validation
> Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (root `vitest.config.ts` with projects `unit`, `db`, `golden`) |
| **Config file** | none — Wave 0 (plan 01-01) installs |
| **Quick run command** | `corepack pnpm vitest run --project unit` |
| **Full suite command** | `corepack pnpm -r typecheck && corepack pnpm vitest run` (unit + db + golden) |
| **Estimated runtime** | ~30 s unit; ~120 s full |

Network guard: a vitest setup file makes all HTTP fail closed (undici `MockAgent` + `disableNetConnect()`) and forbids
launching Chromium unless `PP_LIVE=1` — tests and CI never touch Google or any live site. DB tests use one database per
worker: `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/painter_leads_test_<slug>`.

---

## Sampling Rate

- **After every task commit:** quick run for the affected package (`corepack pnpm vitest run --project unit packages/<pkg>`)
- **After every plan wave:** full suite command (typecheck + unit + db + golden)
- **Before `/gsd-verify-work`:** full suite green on GitHub Actions AND `01-PILOT-REPORT.md` accuracy table meets the
  ≥98% bar (point estimate with Wilson 95% interval shown)
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

Filled by the planner per task (see each PLAN.md `<verify>`). Requirement → test map:

| Requirement | Behaviour | Test Type | Automated Command | File Exists | Status |
|-------------|-----------|-----------|-------------------|-------------|--------|
| DISC-02 | card + place-page parsers extract every field from saved fixtures; ids/coords from URL | unit | `vitest run --project unit packages/maps` | ❌ W0 | ⬜ pending |
| DISC-03 | `/sorry/`, captcha, unusual-traffic, limited-view fixtures → right status; missing count stored NULL not 0 | unit | same | ❌ W0 | ⬜ pending |
| DISC-04 | queue resumes after a kill; done searches skipped; daily cap enforced | db | `vitest run --project db packages/maps` | ❌ W0 | ⬜ pending |
| QUAL-01 | category table → keep / not-a-painter with deciding category | unit | `vitest run --project unit packages/pipeline` | ❌ W0 | ⬜ pending |
| QUAL-02 | residential rules on fixture pages incl. negations and "residential and commercial" | unit + golden | `vitest run --project golden` | ❌ W0 | ⬜ pending |
| QUAL-03 | qualification returns every reason; NULL rating → "not captured" reason | unit | `vitest run --project unit packages/pipeline` | ❌ W0 | ⬜ pending |
| QUAL-04 | thresholds changed in config change results with no code change; invalid config rejected | unit | `vitest run --project unit packages/core` | ❌ W0 | ⬜ pending |
| ENR-01 / ENR-07 | email extractor on probed sites, cfemail, `[at]`, bundle placeholders rejected, null-MX rejected | unit | `vitest run --project unit packages/sites` | ❌ W0 | ⬜ pending |
| ENR-02 | owner statements accepted; filler-page names rejected; template names rejected | unit + golden | same | ❌ W0 | ⬜ pending |
| ENR-03 | CSLB phone/name/ZIP match ladder; name reorder; truncated personnel file refused | unit | `vitest run --project unit packages/registries` | ❌ W0 | ⬜ pending |
| ENR-04 | NJ roster parse; NJ form flow replay keeps session; `span#owner_name`; TX SoQL builder; officers vs corporate agent | unit | same | ❌ W0 | ⬜ pending |
| ENR-05 | BBB JSON-LD `employee[]` parse; 403 → `blocked` | unit | same | ❌ W0 | ⬜ pending |
| ENR-06 | every evidence row has provenance (DB NOT NULL); agreement → high; registry conflict rejects website claim | db | `vitest run --project db packages/core` | ❌ W0 | ⬜ pending |
| REC-01 | merge ladder incl. franchise and shared-host guards; evidence preserved | unit + db | `vitest run packages/pipeline` | ❌ W0 | ⬜ pending |
| REP-01 / 02 / 03 | workbook from a seeded DB: 6 tabs, exact headers, text ZIPs, hyperlinks, Sources rows; CSV BOM + formula-injection guard | db | `vitest run --project db packages/pipeline` | ❌ W0 | ⬜ pending |
| ACC-01 | seeded stratified sampler reproducible; compare script scores correct / wrong / missed / drift with Wilson CI | unit | `vitest run --project unit packages/pipeline` | ❌ W0 | ⬜ pending |
| ACC-02 | golden replay equals truth; a deliberately broken rule makes it FAIL (prove fail and pass) | golden | `vitest run --project golden` | ❌ (populated in 01-06) | ⬜ pending |
| ACC-03 | fill-rate query per state (owner / email / phone / website, overall + qualified) | db | `vitest run --project db` | ❌ W0 | ⬜ pending |
| OPS-01 | CI green on GitHub Actions with a Postgres service | CI | `gh run list --repo my-stuffff/painter-leads` | ❌ (repo not created) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `vitest.config.ts` (projects unit / db / golden), `test/setup-network-guard.ts`, `test/global-setup-db.ts`
- [ ] `.github/workflows/ci.yml` with a `postgres:18` service, pnpm store cache, no browsers
- [ ] `fixtures/` layout + README (golden set populated in 01-06)
- [ ] Probe websites re-captured into fixtures through the real fetcher (no client PII, no raw NJ roster files)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Live pilot run on Edison / Austin / San Diego | DISC-02..04, ENR-*, REP-* | live Google + live sites; never in CI | orchestrator runs `pp pilot …` per city, records counts and block log in `01-PILOT-REPORT.md` |
| Blind truth collection for 50 companies per state | ACC-01 | needs a checker reading live sources independently of the system | checker gets only `sample.csv` (id, name, Google link), fills `truth.csv`; then `pp accuracy compare` |
| Datacentre scrape test | roadmap SC-5 | needs the owner's new Railway account | small scripted search batch from a Railway service; attempted vs blocked/limited recorded |
| Owner opens the workbooks | REP-01 | human judgement of the deliverable | human-verify checkpoint at the end of 01-06 |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
