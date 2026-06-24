# CONTEXT.md

Living document. Updated at the end of every working session so the next
Claude (or future-you) can pick up without re-reading the whole chat history.

## Current state (as of June 17, 2026)

Modular ES-module project that bundles to a single distributable file for
production. Core features:

- Multi-segment daily entries (clock out for personal, clock back in later)
- Per-segment break deduction (> 5h on weekdays only)
- Time-off pools with Taken / Scheduled / Remaining split
- Paycheck tracking with YTD totals
- Cross-device sync via Supabase, falls back to `localStorage` for plain-file
  use

**Pay periods and overtime are now per-company, not per-user.** Each company
carries its own pay-period config plus an OT threshold and OT period. The
landing Dashboard reads the active company and windows OT accordingly:

- Pay period systems: weekly, bi-weekly, semi-monthly, monthly, advanced
  (anchor date + custom cycle length), selected per company.
- Companies have a full lifecycle: add, activate/deactivate, and a guarded
  delete (you cannot delete the last/active company out from under the app).
- Overtime is per-company: `ot_threshold` (default 40) and `ot_period`
  (weekly / biweekly / semimonthly / monthly). The Dashboard splits Regular
  vs OT on worked hours only, over the active company's OT window. OT is no
  longer on the user-level Hours card.

**OT windowing model (and its boundary).** OT is measured over the active
company's `otPeriod` window:

- weekly: one window per split week
- biweekly: consecutive split weeks paired into 2-week blocks (a leftover
  single week is its own block)
- semimonthly: half-month windows split at `semiSecondDay` (default 16)
- monthly: calendar month

Only actually worked hours count toward the threshold (`computeHoursWorked`);
Holiday and PTO/Sick do not push the worked total over OT. The split is
accurate when `otPeriod` is equal to or shorter than the pay frequency. A
window longer than the pay period under-counts OT, because the Dashboard only
sees entries inside the current pay period. There is no OT-period option for
semimonthly-as-pay or for the advanced cycle, by design.

**One-click clock in/out (3e.9).** The Pay Period landing has a Clock card
(per selected company tab). Clock in stamps the current time as a new OPEN
segment (clockOut null) on today's entry, creating the entry if needed; clock
out stamps the current time as that segment's end. Only one open clock is
allowed across all companies: while one is open the card shows "Clocked in
since HH:MM" and offers only Clock out. Open segments are excluded from every
total by construction (`computeSegmentHours` returns 0 for a missing clockOut);
proven by `scripts/test-clock.mjs`. The entry stays fully editable in the
normal modal. Midnight edge: a segment stores only "HH:MM" with no date, so a
clock-out on a later day splits into start-day 23:59 plus a fresh 00:00 -> now
segment on today (rounding recovers the boundary minute). Persistence rides the
existing per-company entry write path.

Tooling: a graphify knowledge graph now lives in `graphify-out/`, with CLI
routing rules in `CLAUDE.md` and a post-commit refresh to keep it current.

License: PolyForm Noncommercial (source-available).

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

### Immediate next (Phase 3e)

1. **3e.5: drop the dead settings JSON fields.** Remove the now-unused
   user-level pay-period fields (`system`, `startDow`, `biweeklyRef`, `semi1`,
   `semi2`, `monthlyStart`, `anchorDate`, `cycleDays`) plus the orphaned
   `otThreshold`, all superseded by the per-company config. Ship a migration
   so existing stored settings are cleaned up on load.
2. **3e.7: per-company Standard Day and time-off behind per-company tabs.**
   Decision recorded: use tabs, one per active company, so each company's
   Standard Day and time-off types are edited in isolation.

### Longer deferred backlog

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

### June 20, 2026: bootstrap fix + 0.5b storage cutover + half-day PTO

Owed-from-handover entries, captured retroactively on 2026-06-24.

- **Bootstrap clobber fix (commit 55977c5, fast-forward merged to main).**
  Profile upsert was unconditionally writing `active_company_id` even when
  falling back to `DEFAULT_PROFILE`; `bootApp` now self-heals when
  `active_company_id` is null but companies exist. Root cause was two
  writers (bootstrap's insert and the ungated upsert in
  `RemoteStore.set('ts:profile')`); the upsert wrote null over the
  bootstrap value whenever a swallowed profile-read error caused
  `state.profile.companyId` to fall back. Two defenses landed:
    - `RemoteStore.set('ts:profile')` only includes `active_company_id`
      in the upsert payload when `value.companyId` is non-null.
    - `bootApp` calls `healActiveCompanyId(userId)` after `loadAll`; if
      `state.profile.companyId` is null and `state.companies` is
      non-empty, it writes the lowest company id directly via
      `profiles.update().eq('user_id', userId)`, bypassing the gated
      upsert path. In-memory `state.profile.companyId` is synced.
  Pattern lesson: when one writer is authoritative (sets a field
  correctly) and another is permissive (writes whatever's in state), a
  stale state read can clobber the authoritative value. Fix is to gate
  the permissive writer to only include the field when it has a real
  value, and add a heal path on boot for victims already in the bad
  state.

- **0.5b storage cutover (commit b30ccaa).** Per-employee fields
  (`breakMinutes`, `stdSeg1Start/End`, `stdSeg2Start/End`, `startDate`)
  routed through `company_members` via Path B (overlay at storage-read
  time). `companyRowToAppShape(row, memberOverlay = null)` prefers
  overlay values when present, fell back to row columns (the fallback
  was transitional and dropped in today's 0.5c). Both companies SELECT
  paths fetched member rows via a new `getMembersForCompanies(ids)`
  helper and overlaid during `.map`. Write split: `COMPANY_UPDATE_FIELDS`
  lost the six fields; new `MEMBER_UPDATE_FIELDS` + `diffMemberForUpdate`
  routed them to `company_members`. Removed `seedPerCompanyBreakAndStandardDay`
  from app.js plus its call site; stopped `migrateCompanies` defaulting
  the five break/std keys.

- **Half-day PTO engine + schema (commit bb317a6).** Added
  `entries.hours_override numeric(5,2) NULL` column. Single engine
  branch in `core/time.js computeHoursPaid`: when `entry.hoursOverride
  != null`, the time-off hours are the override (not `type.hoursPerDay`)
  AND the override is additive to worked segments (a worked half-day
  still earns its time-off portion). Null override is byte-identical to
  prior behavior. `core/coverage.js` switched pool draws from
  `computeHoursPaid` to `computeHoursBenefit` (paid minus worked) so
  worked hours never deplete the balance; backward-identical for
  whole-day entries where benefit equals paid. 3 new test cases in
  `test-coverage.mjs`. `SCHEMA_VERSION` bumped 3 to 4.

- **Half-day PTO UI + fractional days (commit 6f05bbb).** Entry modal
  gained a `Duration` select (Full day / Half day) in a new third
  `.grow` next to the time-off code dropdown. Single shared
  `computeHoursOverride()` helper used by both live preview and save (no
  drift possible). Pool card's `available` and `used` figures now use a
  `formatDays()` helper that renders integers cleanly and one decimal
  when fractional (10.5 days available, 84 h). `pool`, `reserved`,
  `earned`, `carried` stay floored. The days x hours-per-day
  reconciliation invariant is preserved (hours derived from displayed
  day figure). This intentionally relaxes the chunk-B "all pool-card
  day figures floor" convention.

- **Juan's data migration (data event, no code commit).** Six 2026
  paper calendars (Jan-Jun) transcribed to CSV, end times verified.
  170 days total. Generated and committed via single SQL block in
  Supabase: 128 INSERTs covering worked days and time-off entries
  Juan hadn't logged; 2 UPDATEs converting existing full-day PTO
  entries (Jan 26, Apr 28) to half-day shape (segments +
  `hours_override = 4`); 12 skipped via
  `ON CONFLICT (user_id, company_id, date) DO NOTHING`; 28 Sundays + 3
  blank Saturdays not imported. `breakTaken` set per A.1 rule (true
  for Mon-Fri segments strictly over 5h gross). Post-commit total in
  range: 142 entries. Then `company_members.hire_date` set so PTO
  cycles had an anchor and prior-cycle carryover could compute; the
  dashboard now shows `pool: 25 days (200 h) = 20 this year + 5
  carried` and `15 days available, 5 used`. Five workspace companies
  renamed to "Ferry Machine" (singular, matching Juan's correctly
  named one) via single SQL UPDATE.

### June 24, 2026: paycheck estimator v5

Personal-planning paycheck estimator. Independent of the rest of the app: a
button on the Paychecks view opens a modal that turns a hypothetical gross
into a take-home breakdown. Hourly rate is never stored.

- **Chunk 1 (commit 278e9b6).** Pure engine + tests. `src/core/tax.js` holds
  2026 federal brackets, FICA constants, and a 12-state table covering PA, MA,
  NH, DE, RI, VT (full brackets for all statuses), NJ/CT/VT (single brackets
  only; MFJ/HoH on user-rate pending direct PDF parse), and NY/MD/DC/VA
  (user-rate for all statuses, pending bracket data). State payroll add-ons:
  NJ FLI, NY SDI/PFL, CT/MA PFML, RI TDI. Locals: NYC, Yonkers, Philadelphia,
  Wilmington, PA EIT, MD county. `src/core/estimator.js` orchestrates per-
  paycheck inputs via annualize → bracket → divide-back. Pre-tax 401(k)
  reduces federal + state, NOT FICA; Section 125 reduces all three. Tests in
  `scripts/test-tax.mjs` (~33 cases) and `scripts/test-estimator.mjs`
  (10 end-to-end). Tests not run locally (Node missing on the clone PC);
  hand-traced against implementation. Citations live in
  `.tax-research-2026.md` (gitignored).
- **Chunk 2 (commit 323d992).** Schema + storage. Two new tables with
  user-scoped RLS:
    - `estimator_settings` (1-to-1 per user): state, filing_status,
      pay_periods_per_year, locality jsonb, deductions jsonb,
      state_effective_rate.
    - `estimate_history` (append-only): inputs and result jsonb snapshots,
      optional member_id context, optional note, indexed by
      `(user_id, created_at desc)`.
  SCHEMA_VERSION bumped 4 → 5. `src/data/storage.js` got four dedicated
  functions outside the Store dispatcher (history is append-only, doesn't fit
  get/set): `getEstimatorSettings`, `saveEstimatorSettings`,
  `appendEstimateHistory`, `loadEstimateHistory`, `deleteEstimateHistory`.
  SQL run against `kijumyxoiacvqlqqwqon` after BEGIN/ROLLBACK dry-run
  verified the policies and tables would exist.
- **Chunk 3 (this commit).** UI + docs. `src/modals/estimateModal.js` renders
  the modal: pay frequency, gross, state, filing, locality (state-conditional
  inputs), state-effective-rate fallback when in user-rate mode, deductions
  table with add/remove, live result breakdown (per-paycheck + annual),
  history panel with save/delete. Save defaults persists the template (never
  the gross). Estimate button added to the Paychecks view header next to Add
  Paycheck. `docs/LOGIC.md` got a new "Paycheck estimator" section.
  `docs/ROADMAP.md` updated the "explicitly aren't doing" line to clarify
  the estimator is in scope as personal-planning, employer-side withholding
  is not.

Known limitations and follow-ups:
- HoH brackets for NY/NJ/MD/CT/VT still on user-rate (their HoH
  schedules are distinct from single/MFJ and weren't reachable via the
  WebFetch sources we tried). Same for NYC bracket schedule.
- A few addon rates carry TODO comments pending verification (NJ SUI,
  PA SUI, MA personal exemption, DE/VT intermediate thresholds, NY std
  deduction).
- The owed CONTEXT entries flagged in the handover (bootstrap fix, 0.5b,
  half-day-a, half-day-b, Juan migration) are still pending - they were
  scheduled for 0.5c but rolled forward when 0.5c got pulled into this
  session ahead of being narrowly scoped.

### June 24, 2026: bracket fills + 0.5c + 0.6 + estimator v2

Same-day continuation. The first chunk shipped the estimator end-to-end
(see above). The follow-ups: convert remaining user-rate states to
brackets, close 0.5c (column drop) and 0.6 (RLS tightening), and
respond to Ravi's request to add salary/hourly/multi-source modes.

- **Bracket fills (commit 0ec0dad).** NY (single+MFJ, 9 brackets each,
  3.9-10.9% reflecting the Ch. 59 Laws of 2025 0.2pp cut), NJ MFJ
  (8 brackets including the MFJ-only 2.45% rate), MD (single+MFJ,
  10 brackets, 2-6.5%, std deductions $2,550/$5,150), DC (one schedule
  for all 3 statuses, 7 brackets, 4-10.75%), VA (one schedule for all 3,
  4 brackets, std deductions $8,750/$17,500), CT MFJ (7 brackets), VT
  MFJ (4 brackets with proper MFJ thresholds). HoH for NY/NJ/MD/CT/VT
  stays user-rate. Source: ustax.tools 2026 pages (after Tax Foundation
  and the official PDFs both stalled). 5 new spot-check tests added.

- **0.5c (commit 5deebeb + live SQL).** Dropped `break_minutes`,
  `std_seg1_start`, `std_seg1_end`, `std_seg2_start`, `std_seg2_end`,
  `start_date` from companies. Code shipped first: both `ts:companies`
  SELECT lists no longer reference the columns; `companyRowToAppShape`
  now reads overlay-only (no row fallback); `supabase/schema.sql`
  mirror trimmed. SQL DROP COLUMN x6 ran clean. The three pre-existing
  test-companies-write failures got fixed at the same time (they were
  expectations missing the `startDate` field that the app-shape already
  returned).

- **0.6 (commit ac8e5fc + live SQL).** Tightened companies RLS from
  `USING(true)` shortcuts to owner-or-member scoping. Two SELECT
  policies (Owners can view, Members can view) get OR'd by Postgres
  RLS - the owner-only path covers bootstrap/createCompany/deleteCompany
  RETURNING clauses (before any company_members row exists), the
  membership path covers post-bootstrap reads. INSERT tightened to
  `owner_user_id = auth.uid()`. UPDATE unchanged. DELETE now has an
  explicit owner-only policy (was implicit via the loose SELECT before).
  Migration applied in pieces (dry-run + partial-state recovery + two
  single-statement applies for the loose-INSERT drop + the missing
  Owners-can-create policy).

- **Estimator v2 (commit c13f0d4 + live SQL).** Pay-type select added:
  Salary (amount + per-period-or-annual selector), Hourly (regular +
  OT 1.5x + double-time 2x at a rate, with live computed-gross
  readout), Multiple income sources (list of salary/hourly entries,
  summed to a single per-period gross with combined-total readout).
  State and filing stay single across all sources. Engine signature
  unchanged - the modal derives the per-period gross from the
  pay-type-specific inputs. Deduction quick-add menu added with 10
  presets (Health/Dental/Vision/HSA/FSA/401k/403b/Roth/Life/Disability).
  Two new columns on `estimator_settings`: `pay_type` and
  `salary_mode` (both with check constraints + defaults). Pay type
  and salary mode persist; all dollar amounts, hours, rates, and
  per-source values are transient (the no-rate-storage rule from v5
  applies to all numeric inputs).

Process note: Ravi flagged that combined multi-statement SQL blocks
(BEGIN + ALTER + verify + ROLLBACK in one editor execution) were hard
to manage as a non-developer. Working agreement updated: one SQL
statement per fenced block from now on, with explicit "Run this next"
labels and re-runnable verification queries separated out.

### June 17, 2026: 0.4 membership-scoped storage cutover

Moved entries and pays off user_id-scoped storage and onto membership-scoped
storage, in three steps.

- **0.4a (commit 76eb707).** `storage.js` gained `getSignedInMemberId(companyId)`,
  a session-cached lookup against `company_members`. The `writeEntries` upsert
  payload and the pays insert payload now stamp `member_id` directly. The 0.3
  autofill triggers stayed in place as a redundant safety net for this step.
- **0.4b (DB cutover, run manually via the Supabase SQL editor, no app commit).**
  Verified zero nulls on `entries.member_id` and `pays.member_id`, dropped both
  autofill triggers and their plpgsql functions, swapped the `entries` and `pays`
  RLS policies from user_id-scoped (`auth.uid() = user_id`) to membership-scoped
  (`member_id in (select id from company_members where user_id = auth.uid())`),
  and added NOT NULL to `entries.member_id` and `pays.member_id`.
- **0.4c (this commit).** `schema.sql` now reflects the dropped triggers and the
  NOT NULL columns; `policies.sql` reflects the membership-scoped RLS; this
  CONTEXT.md entry plus the header bump are added.

Carrying into 0.5 and 0.6:

- Per-employee fields still on `companies` (`break_minutes`, `std_seg1_*`,
  `std_seg2_*`, `start_date`) need to move off; this is 0.5's main job.
- `entries.user_id` and `pays.user_id` are still populated and still referenced
  in the pays update/delete `.eq()` expressions, plus the entries unique
  constraint still keys `(user_id, company_id, date)`. Full decommissioning of
  the user_id columns is its own chunk after 0.6.
- companies SELECT/INSERT RLS is still `USING(true)`; tightening is 0.6.

### June 17, 2026: Pre-0.4 clock and PTO fixes

Three contained chunks landed ahead of 0.4, fixing clock and PTO behavior with
no schema change.

- **Clock fixes (commit 409d817).** Clock-out now auto-marks the break on a
  qualifying segment (> 5h on Mon-Fri), using the new `segmentQualifiesForBreak`
  helper in `core/time.js` so the threshold lives in one place. Midnight
  rollover: `clockState` skips prior-day open segments, so the dashboard shows
  Clock in rather than a stale Clock out across midnight. The invariant relaxed
  from "at most one open clock" to "at most one open clock per company per day";
  the `doClockIn` guard now checks `clockState` mode instead of raw
  `findOpenClock`, letting a fresh clock-in coexist with a prior-day orphan.
  - Latent: the break deduction in `computeHoursPaid` still does not enforce
    Mon-Fri; it deducts on `breakTaken && gross > 5h` alone. A user who manually
    checks `breakTaken` on a weekend segment over 5h will still get the
    deduction. Deferred to its own chunk after Phase 0.
- **PTO cycle metrics (commit ffebecb plus the floor-everywhere follow-up
  535c595).** `computePoolAccrual` now emits a current-cycle scoped view: each
  cycle carries `pastReservedHours`, `futureReservedHours`, `poolCapacityHours`,
  and `unpaidHours`, plus a top-level `currentCycle` alias and seven
  `currentCycle*` convenience fields. The dashboard balance card reads these and
  no longer mixes lifetime `totalPaidHours` into "used to date". The pool label
  shows the carry split when `carriedIn > 0` ("pool: 11 days (88 h) = 6 this
  year + 5 carried"). All day rounding uses `Math.floor` (pool, used, reserved,
  available, plus earned and carried in the label) so the bar arithmetic always
  reconciles; the hours shown are derived from the floored day counts so days
  and hours never disagree on screen.
- **Forgotten clockout button (commit 2153c4a).** New const
  `FORGOTTEN_CLOCK_HOURS = 16` in `core/clock.js`. `clockState` now also returns
  `forgotten` and `forgottenOpen` (the oldest open segment past the threshold).
  The dashboard renders a red "Forgotten clockout" button alongside the normal
  control when `forgotten` is true; clicking it opens that entry's edit modal so
  the user can supply the missing `clockOut`. No auto-close and no end-time
  guess. Prior-day orphans surface as forgotten because they are always older
  than 16h.

Carrying into 0.4: weekend break deduction in `computeHoursPaid` (latent);
`waitingDays` semantic divergence in `core/accrual.js` (engine delays the grant
and permits unpaid usage, intended policy is grant accrues + usage blocked,
deferred to its own chunk); Issue 2 calendar-year filter in `core/balances.js`
for non-pool types (deferred indefinitely, no live impact); std_day-anchored
"day" model with cross-midnight support (A.2 big, deferred); OT visualization on
the pay period view (C, deferred); per-year pool override resolving
`pool_by_year` (deferred).

### June 16, 2026: 0.3 membership backbone landed in the live DB

Schema-and-docs only, no app behavior change. Two contained chunks:

- **0.2** reconciled `supabase/schema.sql` to the live database (commit
  9a8ed5c), so the file is now a faithful mirror of production.
- **0.3** landed the membership backbone in the live DB:
  - `company_members` gained a synthetic `id uuid` PK, dropped the old
    composite `(company_id, user_id)` PK, made `user_id` nullable, and added a
    partial unique index over `(company_id, user_id)` for claimed memberships
    only (owner-managed rows with null `user_id` are unconstrained). It also
    gained per-employee columns: `display_name`, `hire_date`, `break_minutes`,
    `std_seg1_start/end`, `std_seg2_start/end`.
  - `entries` and `pays` each gained a `member_id uuid` FK to
    `company_members(id)` with a covering index.
  - Backfill: 6/6 member rows seeded across all production users (two for the
    owner across Ferry Machines and Phillips Precision, four for other paying
    users' workspaces); 442/442 `entries.member_id` and 89/89 `pays.member_id`
    non-null.
  - Temporary autofill triggers on `entries` and `pays` keep `member_id`
    populated for new writes without any app change; scheduled for removal in
    0.4.

No app behavior change. `storage.js` still writes user_id-only payloads and
reads still scope by `user_id` and RLS. The cutover to membership-scoped
storage and the trigger drop are 0.4's job.

### June 16, 2026: PTO accrual complete

Shipped the full PTO accrual feature across a series of contained, mostly
output-identical chunks. The canonical rules now live in `docs/LOGIC.md` under
"PTO accrual"; this entry records the progression.

- **Schema.** Added booking fields on entries (`status`, `booked_at`;
  `created_at` already existed) and accrual config on time-off types (grant
  style, cycle anchor, anchor date, waiting days, carry-over mode and cap),
  plus a per-company hire date (`start_date`). Threaded through both storage
  paths with null defaults.
- **Engine.** `src/core/accrual.js`: a pure, hard-harnessed balance and
  reservation engine (`computePoolAccrual`), never importing storage or UI.
  Covers grant styles, the three cycle anchors, proration, waiting periods,
  carry-over, multi-cycle chaining, and the booking-order reservation/overdraw
  split. `scripts/test-accrual.mjs` proves each rule.
- **Entry modal.** Sets `status` and `bookedAt` on save, with an
  approved/pending toggle shown for time-off; `bookedAt` is stamped at the
  first save that makes a day a time-off booking and preserved thereafter.
- **Settings.** Added the accrual config UI per type and the company hire date,
  defaulting to null-equivalent so flat pools read as before.
- **Year-override retired.** `pool_days` was seeded from each type's current-year
  override; the per-year UI was removed and `pool_by_year` left dormant (nothing
  reads it). The allotment now reads `pool_days`.
- **Hire date.** Renamed the per-company start-date field to "Hire date" and
  guarded the waiting period: with no hire date there is no probation.
- **Pay-calc coverage flip.** `src/core/coverage.js` adds
  `paidHoursWithCoverage`, a wrapper over a frozen `computeHoursPaid`: a pool
  day pays only when the engine marks it covered, while uncovered/pending days
  drop to 0. Coverage is one per-company engine result shared by every
  paid-hours surface (period totals, week cards, Annual tile, balances, the
  paycheck Pull prefill, and the Daily Log). Stored paychecks are records and
  are not recomputed.
- **Cleanup.** Removed the vestigial user-level Hours and Standard Day cards
  from Settings (per-company break and Standard Day already drove everything;
  the one-time seed still reads the user values at load).

### June 16, 2026: One-click clock, two balances fixes, PTO accrual kickoff

**One-click clock in/out per company (3e.9).** The Pay Period landing gained a
Clock card per selected company tab. Clock in stamps now as a new OPEN segment
(clockOut null) on today's entry, creating the entry if needed; clock out
stamps that segment's end. Only one open clock is allowed across all companies:
while one is open the card shows "Clocked in since HH:MM" and offers only Clock
out. Open segments are excluded from every total by construction
(`computeSegmentHours` returns 0 for a missing clockOut), proven by
`scripts/test-clock.mjs`. Midnight edge: a clock-out on a later day splits into
the start day's 23:59 plus a fresh 00:00 to now segment on today.

**Balances fix 1: Holiday shows the flat per-day benefit.** The Time-off
balances tab summed paid hours for Holiday, which for an additive type is
worked plus the flat benefit, so a worked holiday folded its worked hours into
Holiday (a worked 8h holiday read 16, not 8). Extracted the benefit rule into
one canonical `computeHoursBenefit` (paid minus worked) in `src/core/time.js`,
and routed the dashboard period total, week cards, annual block, and a new
`sumBenefitForCode` in `src/core/balances.js` through it. The dashboard and the
balances tab now share one computation and cannot drift. Worked-on-holiday
flows to worked; Holiday reports the flat benefit, matching the dashboard.

**Balances fix 2: Unpaid shows no hours.** An unpaid day is neither worked nor
paid, but the balances tab printed a paid-style 8h figure for it. The non-pool
branch now suppresses the hours figure for any type flagged `unpaid` and shows
the day count only. Display-only; storage and compute paths are unchanged.

**PTO accrual: started.** Began the accrual model that replaces the
year-override pattern. The settled business rules are written up in
`docs/LOGIC.md` under "PTO accrual model (in build)": base allotment, grant
style (up front or linear), cycle anchor off a per-person start date,
mid-cycle proration, optional waiting period, carry-forward, shared pools, and
the overdraw rule. Year-override is being retired by reading the current year's
value as the opening allotment and running the rule forward, with no
reconstruction of past years. In build, not yet wired into the UI.

### June 6, 2026: Per-company pay period + overtime (3e.4 / 3e.4b / 3e.4c) and cleanup

Moved pay period and overtime off the user and onto the company.

**3e.4: per-company Pay Period settings.** Each company carries its own
pay-period config. The Dashboard reads the active company and ranges the
period from it.

**3e.4b: companies lifecycle.** Add a company, activate/deactivate it, and a
guarded delete so the app is never left without an active company.

**3e.4c: per-company overtime.** Companies gained `ot_threshold` and
`ot_period`. Settings has a per-company OT UI. The Dashboard windows OT by
`ot_period`: weekly per week, biweekly as paired weeks, semimonthly as
half-month halves split at `semiSecondDay`, monthly as calendar month. OT was
removed from the user-level Hours card.

**OT windowing model and its boundary.** OT is measured over the active
company's OT window on worked hours only (`computeHoursWorked`). Holiday and
PTO/Sick never push the worked total over the threshold. Accurate when
`otPeriod` is equal to or shorter than the pay frequency; a longer window
under-counts OT because the Dashboard only sees entries in the current pay
period. No OT-period option exists for semimonthly-as-pay or for advanced, by
design.

**Cleanup.** Removed the legacy user-level Pay Period settings block and
deleted `src/core/period.js` (the per-date pay-period math now lives in
`src/core/payPeriod.js`). Break duration consolidated onto the Hours card
(`#setHoursBreak`), with Standard Day's live total repointed to it.

**Tooling.** Added a graphify knowledge graph (`graphify-out/`) with CLI
routing rules in `CLAUDE.md` and a post-commit refresh hook.

**License.** Adopted PolyForm Noncommercial (source-available).

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
  `docs/ROADMAP.md`, `docs/LOGIC.md` (originally `docs/EXCEL_LOGIC.md`)
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
