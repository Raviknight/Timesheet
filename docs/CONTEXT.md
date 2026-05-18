# CONTEXT.md

Living document. Updated at the end of every working session so the next
Claude (or future-you) can pick up without re-reading the whole chat history.

## Current state (as of May 18, 2026)

Refactored from a single 1800-line HTML file into a modular ES-module project
that bundles to a single distributable file for production. Same features as
before:

- Multi-segment daily entries (clock out for personal, clock back in later)
- Per-segment break deduction (> 5h on weekdays only)
- Pay period systems: weekly, bi-weekly, semi-monthly, monthly, advanced
  (anchor date + custom cycle length)
- Time-off pools with Taken / Scheduled / Remaining split
- Paycheck tracking with YTD totals
- Companies + role scaffolding (owner/employee/supervisor/admin)
- Cross-device sync via Anthropic `window.storage`, falls back to
  `localStorage` for plain-file use

Seeded with Ravi's 128 daily entries (Dec 29, 2025 → forward) and 88 pay
records from `Time_Sheet_2026.xlsx`.

## What's in flight

**Phase 3 (Supabase migration) is active.** See `docs/PHASE_3_PLAN.md`.
Steps 1-4 complete: project provisioned, schema + policies deployed,
`src/data/supabase.js` integrated and connection-verified (entries row
count 0), and the auth flow UI (signup/signin/signout) is built and
gating app boot. **Step 8 is active**, brought forward out of order:
`.github/workflows/deploy.yml` builds and publishes `dist/` to Pages on
every push to main, fixing the unbundled-root-index.html serving bug found
during Step 4 testing. Awaiting one manual step: switch the Pages source to
"GitHub Actions" in repo settings. **Step 5a is complete:** new users
get their profile, company, membership, and default time-off types
created in Supabase on first sign-in. Step 5b (move entries/pays reads
off `localStorage` onto Supabase) is the next major work.

## Next likely tasks

In rough priority order:

1. **Deploy to GitHub Pages.** README has the steps. Test on Ravi's phone +
   desktop and confirm sync works through Claude.ai mobile.
2. **Add unit tests** for `core/time.js` (segment math) and `core/period.js`
   (period systems). Vitest is the natural pick.
3. **Add a "Today" quick-add button** that pre-fills date and lets Ravi punch
   in/out without opening the full modal.
4. **Export to original Excel format.** Pull `openpyxl` shape into a JS xlsx
   writer (SheetJS) so Ravi can hand the file to his employer.
5. **Multi-tenant scaffolding pass.** Wire `auth/roles.js` capability checks
   into the UI so unauthorized views are hidden. No backend yet, just the
   plumbing.
6. **Backend planning.** Decide between Cloudflare Workers + D1 vs Supabase
   for the eventual multi-tenant version. See `docs/ROADMAP.md`.

## Decisions / open questions

- **Bundler:** esbuild is currently in the build script. Vite would be nicer
  but adds dependencies. Revisit if/when we add TypeScript.
- **TypeScript:** not yet. Add when the project crosses ~30 files or when we
  start the backend.
- **Tests:** Vitest looks like the right choice (works with ESM out of the
  box). Not yet set up.

## Things to NOT do

- Don't introduce React, Vue, or any frontend framework yet. Vanilla JS is
  enough for the current scope and keeps the bundle tiny.
- Don't add Tailwind. The hand-rolled CSS variables in `assets/styles.css`
  work in light + dark mode and total < 200 lines.
- Don't reach for a state management library. The single `state` object in
  `app.js` is fine for this size.

## Session log

### May 18, 2026 — Phase 3 Step 5a complete: bootstrap logic added
- New users on first sign-in get profile, company, membership, and
  default time-off types created in Supabase. localStorage still
  backs entries/pays (5b/5c to follow).
- `src/data/bootstrap.js` added: `getExistingProfile`,
  `bootstrapNewUser`, `ensureBootstrapped`. Inserts in RLS dependency
  order (company → company_members → profile → time_off_types).
- `bootApp()` in `src/app.js` now calls `ensureBootstrapped()` after
  session check, before the existing `loadAll()` path.

### May 18, 2026 — Step 8 brought forward: GitHub Actions deploy
- Discovered during Step 4 testing that GitHub Pages was serving
  index.html from project root (with unbundled module imports),
  not the bundled dist/timesheet.html. Errored with
  "Failed to resolve module specifier '@supabase/supabase-js'".
- Fix: moved Step 8 ahead of Step 5. Created
  .github/workflows/deploy.yml that builds on push and publishes
  dist/ to Pages.
- Removed dist/ from git tracking; the workflow rebuilds on every
  push.
- Pages source must be switched from "Deploy from a branch" to
  "GitHub Actions" in the repo settings (manual step for Ravi).

### May 18, 2026 — Phase 3 Step 4: auth flow UI complete
- 4a: src/auth/session.js with five auth helpers
- 4b: src/ui/auth.js login/signup screen + auth view markup + styles
- 4c: app boot gates on session, sign out button, onAuthChange listener
- Manual deploy of dist/ to GitHub Pages (Step 8 will automate)
- Known: bundle is 854 KB unminified; minification deferred to later

### May 18, 2026 — Phase 3 Step 3: Supabase client integrated
- Step 3 complete. `src/data/supabase.js` created with project URL and anon
  key, connection verified by querying entries table (row count 0). Temp
  test removed.

### May 18, 2026 — Phase 3 kickoff: Supabase locked in
- Confirmed Supabase as backend with keep-alive Action to prevent inactivity
  pause. Scope reduced to personal-use-first (SaaS scaffolding stays in code,
  polish steps deferred).
- Backend chosen over Turso/D1: minimum code, single service, project already
  provisioned (`kijumyxoiacvqlqqwqon`)
- Added Step 10 to PHASE_3_PLAN.md: keep-alive GitHub Action pinging Supabase
  every 3 days against the free-tier 7-day inactivity pause
- Deferred until first non-Ravi user: demo seed (Step 6), password-reset UI,
  most Step 9 polish
- Wrote `supabase/schema.sql` + `supabase/policies.sql`; Step 1 complete, next
  session runs them (Step 2)

### May 18, 2026 — Refactor to multi-file structure
- Split single-file `timesheet.html` into ES modules under `src/`
- Added esbuild build script that produces `dist/timesheet.html` (single
  distributable file)
- Wrote `CLAUDE.md`, `CONTEXT.md`, `README.md`, `docs/DECISIONS.md`,
  `docs/ROADMAP.md`, `docs/EXCEL_LOGIC.md`
- Kept all previous functionality intact, including the 128-entry + 88-pay
  first-run seed

### Earlier sessions (summarized)
1. Built initial single-file HTML app from `Time_Sheet_2026.xlsx`. Five
   sheets analyzed: Data, Source, Dashboard, Sheet1, Calculator.
2. Added multi-segment entries (clock out for personal then back in), with
   the rule that break is deducted per segment, not per day.
3. Rebuilt pay-period config from "anchor date only" to a system selector
   (weekly / bi-weekly / semi-monthly / monthly / advanced).
4. Split time-off balance display into Taken / Scheduled / Remaining so
   future-dated PTO doesn't make it look like the pool is used up.
5. Reordered tabs: Pay Period is now the landing view.
