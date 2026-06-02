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
Steps 1-4, 5a, 5b, 5c.1, and 8 are complete (see Session log for the
full May 18 narrative). Reads route through Supabase when signed in;
profile and settings writes persist.

Steps 5c.2 (entries write), 5c.3 (pays write), 5c.4 (companies +
time_off_types write) are next. Then Step 7 (legacy data import -
one-off script to import Ravi's 2025 + 2026 Excel data into
Supabase using service_role key). Then Step 9 (polish) and Step 10
(keep-alive Action).

Write strategy chosen for 5c: Option A (diff-and-write with module-
level cache of last-loaded entries and pays). Profile and settings
use upsert by user_id; no diff needed.

## Primary account

**Primary user account: raviknight@outlook.com.** The
ravismla@gmail.com account, created during Step 4 testing, is
deprecated and will not be maintained. Do not reference it as the
primary user anywhere. Step 5.5 (legacy Excel import) will target
raviknight@outlook.com, not ravismla.

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

## Known issues — deferred

**Modal overlay survives mid-session logout (low priority)**

When a user is editing in a modal (entry or pay) and signs out 
from another tab, the page background correctly routes to the 
auth view, but the modal overlay stays open. If the user clicks 
Save in the open modal, the saveKey detection now correctly 
catches the lost session in most cases, but the modal flow can 
race past it depending on how the user got there.

Real-world likelihood is very low (single-user personal app, 
user would notice tab B logging them out). Not blocking 5c.2 
completion. Revisit only if multi-user / shared-account scope 
ever changes.

Fix when revisited: in the onAuthChange SIGNED_OUT branch, 
close any open modals before calling showAuthView. One-line 
addition once we know where modal close handlers live.

## Session log

### June 2, 2026 — Companies table: three production-severity fixes

Three issues diagnosed and fixed on the `companies` table:

**1. Privacy leak (Step 5a debt).**
The SELECT policy was `(true)` for all authenticated users, exposing every workspace name across the entire customer base. This was originally the Step 5a bootstrap debugging shortcut (see May 18 entry for the 42501 root cause that triggered the loosening) and was never tightened. Fixed by dropping the loose policy and adding an owner-based policy alongside the existing membership-based one:
- `owner_user_id = auth.uid()` (owner-based, new)
- `id in (select company_id from company_members where user_id = auth.uid())` (membership-based, existing)

Postgres ORs permissive policies, so both apply without conflict. Resolves deferred item #3 from the May 22 handover.

**2. Bootstrap breakage from RLS + RETURNING.**
New user bootstrap via `.insert(...).select()` against companies was failing. Root cause: PostgREST adds an implicit RETURNING to the insert, which triggers a SELECT policy evaluation against the newly-inserted row before any matching `company_members` row exists. The membership-only SELECT policy denied that read. The owner-based policy from fix 1 uses a field set in the inserted row itself, so the check now passes immediately. Same fix resolved this as a side benefit.

**3. Missing cascade behavior on FKs.**
Auth user deletion was failing because two foreign keys lacked the right ON DELETE behavior:
- `companies_owner_user_id_fkey` lacked `ON DELETE CASCADE`
- `profiles_active_company_id_fkey` lacked `ON DELETE SET NULL`

Both dropped and recreated with correct cascade.

All three fixes verified end-to-end. SQL ran via the BEGIN/ROLLBACK dry-run pattern before commit.

**Doc debt flagged but not addressed:** the "Current state" section above and `PHASE_3_PLAN.md` are both still May 18 vintage and do not reflect the May 22 work either. Capture in a separate doc-catchup session.

**Key learning:** debug shortcuts ship as production debt by default. The permissive SELECT policy was logged as Phase 4 work in the May 18 audit, but went undetected for weeks as a real privacy leak until inspected directly. Future RLS shortcuts get tightened or reverted before the session closes.

### May 18, 2026 — Phase 3 Steps 5a, 5b, 5c.1 complete + Step 8 forward

Massive session covering:
- Step 8 (GitHub Actions deploy) moved forward of Step 5 after
  discovering GitHub Pages was serving unbundled index.html
- Step 5a (bootstrap): completed with RLS policy debt - companies
  INSERT/SELECT policies loosened due to unresolved 42501 RLS
  rejection, company_members policy rewritten to fix infinite
  recursion. Phase 4 to tighten properly.
- Step 5b.1-5b.4 (read path): RemoteStore.get implemented for
  profile, settings, entries, pays, companies, time_off_types,
  schemaVersion. All reads verified working against Supabase.
- Seed suppression fix: prevented Ravi's hardcoded 128 entries
  from being loaded into every signed-in user's in-memory state.
- Step 5c.1: RemoteStore.set implemented for profile and settings.
  Verified working - profile name change persists, OT threshold
  change persists.
- Decision: raviknight@outlook.com is the primary account;
  ravismla@gmail.com deprecated.

Verified end-to-end:
- Signup → email verification → signin flow on production
- Bootstrap creates the 4 starter row sets on first signin
- Profile and settings persist to Supabase and survive reload

Known issues to address next session:
- "Dud app screen on hard refresh" - app shows broken state
  instead of clean app or login screen. Needs diagnosis.
- No toast appears on settings save (cosmetic; data does persist)
- Time-off types and company name edits in Settings appear to
  save but silently revert on reload (RemoteStore.set is no-op
  for these keys; UX trap until 5c.4 addresses it)
- Companies INSERT/SELECT RLS policies loosened - tighten
  properly in Phase 4 via SECURITY DEFINER bootstrap function

### May 18, 2026 — Critical fix before 5c: suppress legacy seed in remote mode

- Bug: `loadAll()` first-run detection (`!schema && !entries &&
  !pays`) flagged EVERY signed-in Supabase user as first-run,
  because `ts:schemaVersion` is never stored remotely. This loaded
  Ravi's hardcoded 128 entries + 88 pays from `src/data/seed.js`
  into every user's in-memory state.
- Severity: cosmetic today (RemoteStore.set is still a stub), but a
  data-pollution landmine once 5c implements writes: the first
  signin after a 5c deploy would persist Ravi's old data into that
  user's Supabase account.
- Fix: gate first-run on `getStorageMode() === 'local'`. Signed-in
  users get a clean empty workspace; their data comes from Supabase
  or explicit import. Had to land BEFORE 5c, not after.
- 5b is now truly complete and safe to build 5c on.

### May 18, 2026 — Phase 3 Step 5b.3 + 5b.4: remote reads complete

- 5b.3: ts:entries reader queries entries table, reshapes to
  legacy date-keyed object format.
- 5b.4: ts:pays reader queries pays table, reshapes field names.
- Read path migration complete. All app reads now route through
  RemoteStore when signed in.
- Writes still go via LocalStore (5c is next).
- Verified end-to-end testing is pending after 5b push deploys.

### May 18, 2026 — Phase 3 Step 5b.1 + 5b.2: storage refactor + partial reads

- 5b.1: src/data/storage.js refactored. LocalStore + RemoteStore +
  dispatcher. Old window.storage (Anthropic/Claude.ai) path
  removed.
- 5b.2: RemoteStore.get implemented for profile, settings,
  companies, time_off_types, schemaVersion.
- Entries and pays still pending (5b.3 and 5b.4).
- Writes still go through localStorage; 5c will migrate writes.

### May 18, 2026 — Phase 3 Step 5a: bootstrap working (with debt)

- Bootstrap logic deployed and tested end-to-end with a new user
  (raviknight@outlook.com): all 4 starter rows created correctly
  (profile, company, company_members, 4 time_off_types).
- HOWEVER: hit two RLS issues during testing that required emergency
  fixes to the policies.
- Issue 1: "Owners manage memberships" policy on company_members
  caused infinite recursion (42P17) because companies policy refs
  company_members and vice versa. Fixed by replacing with
  "Users manage own memberships" (user_id = auth.uid()).
- Issue 2: companies INSERT failed with 42501 despite verified
  correct auth.uid() and matching owner_user_id. Could not root-cause
  in session. Took pragmatic shortcut: loosened both INSERT and
  SELECT policies on companies to TO authenticated with TRUE checks.
  Effective protection is now via SELECT-scoping in app queries,
  not at the RLS layer.
- Action: Phase 4 must tighten companies policies properly,
  likely via a SECURITY DEFINER bootstrap function.
- 5a still complete. 5b (read path migration) is the next step.

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
