<!-- GSD:project-start source:PROJECT.md -->

## Project

**Painter Promotions — Lead Finder**

A system that, for a chosen US state, finds every painting contractor listed on Google Maps, keeps only the ones that
paint homes exclusively, and fills each company with its owner/decision-maker name, phone, email, website, Google rating
and number of ratings — every value traced to the public page it came from. Built for Painter Promotions (a marketing
agency selling Google Local Services Ads / Google Business Profile marketing to US residential painters) so their
Partnerships Manager can prospect without researching companies by hand. First target states: New Jersey, Texas,
California; later any state.

**Core Value:** Every value in the list is correct and provable (source link + capture date) — a blank is acceptable, a wrong or guessed
value is not.

### Constraints

- **No outside services / no AI**: only our own code reading public pages and free official downloads — his rulings.
- **Accuracy**: Findversity-level — no value without a source; hand-checked samples before delivery.
- **Hosting**: a NEW paid Railway account (he creates it); repo private on GitHub org `my-stuffff`.
- **Privacy**: client CRM data never leaves this machine; test fixtures use public business pages only.
- **Politeness / blocking**: Google tolerance is unknown — scraping must be throttled, resumable, and stop on blocks;
  datacentre IPs (Railway) may be treated worse than home IPs and proxies are ruled out.

- **Tech stack**: TypeScript on Node 22, pnpm workspaces, Postgres + Drizzle, Playwright, cheerio, exceljs, vitest —
  matches his other apps so a future web app shares the same kit.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->

## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
