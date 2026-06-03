# UI Redesign Notes

Captured during Phase 3 (May 2026) for execution after Phase 3
completes. Do NOT start implementing these until Supabase migration
(Steps 4-9) is complete.

## Proposed page structure

### Page 1: Dashboard (new landing page)
Replaces current "Pay Period" landing view. Shows:

**Top section: last paycheck summary**
- Hours worked, regular hours, OT hours, time-off hours
- Gross, take-home, taxes/deductions
- Date and company of the paycheck

**Middle section: current cycle in progress**
- Days into current pay period
- Hours accumulated so far this cycle
- Projected take-home if current pace continues

**Below: charts**
- Chart 1 (if paycheck data is complete): taxes vs take-home
  for last paycheck AND YTD (pie or stacked bar)
- Chart 2: hours worked + gross + take-home over the last
  N paychecks (line or grouped bar)

**Header: "+ Add Entry" button** prominently placed

### Page 2: Pay Period (detailed view)
What's currently the dashboard. Detailed period-by-period
breakdown. Add a tab within this page for "All logged data"
(currently the Daily Log).

### Page 3: Paycheck Details
Expanded version of current Paychecks view. Capture more fields:
- Pre-tax deductions (401k, health insurance, etc.)
- Federal tax withheld
- State tax withheld (NJ)
- FICA (Social Security + Medicare)
- Other deductions
- Bonus / overtime breakouts

Later phase: use this data plus current tax tables to PREDICT
take-home from gross.

## Why this is deferred

These changes touch every view in the app. Doing them now means
rewriting them again when the storage layer migrates to Supabase
in Steps 4-5. Sequence: finish Phase 3 first (backend + auth),
then do this as a clean UI redesign sprint.

## When to start

After Step 9 of Phase 3 is complete and verified.

## Pay Period System Redesign

Captured during Phase 3 work (May 18, 2026).

### Problem

The current pay period system in `src/core/period.js` and
`src/ui/settings.js` uses an "anchor date" approach for all
non-trivial systems (biweekly and advanced). Users have to enter
a specific past date that represents a period-start. This is
confusing because most people don't think about payroll that way.
They know "I get paid every other Friday" or "1st and 15th",
not "the period anchor was March 14th."

### Proposed redesign

Replace anchor-date inputs with selectors that match how people
actually describe their pay schedule:

**Weekly:** "Pay periods start on [Monday ▼]". Defaults to Monday,
dropdown for the rare cases where it's another day.

**Bi-weekly:** "I get paid every other [Monday ▼]". Defaults to
Monday. A second question: "Which 2-week cycle?" with two options
based on ISO weeks:
  - Option A: weeks 1, 3, 5... (paid in odd weeks)
  - Option B: weeks 2, 4, 6... (paid in even weeks)
Show a preview: "Most recent pay period would be: [date range]"
so user can confirm visually.

**Semi-monthly:** "I get paid on the [1st ▼] and [15th ▼] of each
month." Defaults to 1st and 15th. Some employers use 1st/16th or
15th/last-day, so keep both as adjustable dropdowns.

**Monthly:** "I get paid on the [1st ▼] of each month."

**Advanced (escape hatch):** Keep the current anchor-date +
cycle-days inputs for unusual schedules.

### Migration

Existing users have `biweeklyRef` and `anchorDate` in their settings.
Migration logic: detect which ISO week the existing anchor falls in,
set the new "cycle parity" field accordingly. No data loss.

### Why deferred

This is business logic touching `src/core/period.js`,
`src/ui/settings.js`, and the data schema. Easier to redesign once
the storage layer is on Supabase (Step 5) so we know the data shape
is stable.

### Real-world reference

User's employer (Ferry Machines) pays bi-weekly starting Monday.
Current anchor in settings: 2025-12-29 (a Monday). This is the
test case for the migration.

---

## Smart entry defaults (deferred, post Phase 3)

When a user adds a new entry, the modal should pre-fill sensible 
defaults instead of an empty form.

**Defaults:**
- One segment pre-filled with start/end from a new "Standard Day" 
  setting (e.g. 8:00 AM to 4:30 PM).
- One break pre-filled from "Standard Break" setting (e.g. 12:00 PM 
  to 12:30 PM).
- Time-off entries (Holiday, PTO, Sick) auto-fill the full standard 
  day; user can edit start/end for half-days.

**New Settings section: "Standard Day"**
- start time
- end time
- break start
- break end

**Future enhancement: scheduled vs actual times**
Split segment into scheduled (from standard day) and actual (what 
user logs). Diff = lateness / early-out, shown as a badge per day. 
Useful for personal tracking. No effect on paycheck math.

**Implementation touchpoints:**
1. Schema: add `standardDay` to settings JSON.
2. UI: new section in Settings page.
3. Entry modal: detect new-vs-edit, pre-fill accordingly.
4. Entry modal: detect time-off-type selection and apply full-day defaults.
5. (Future) data model split for scheduled vs actual times.

**Risk:** schema change touches DEFAULT_SETTINGS and existing-user 
migration logic. Plan a small migration step.

---

## Vacation carry-over and annual reset (deferred, post Phase 3)

Vacation/PTO balances should reset on January 1 each year based on 
each company's policy. Unused days from the prior year may carry 
over, but typically with a cap.

**Example:**
- 2027: 10 PTO days granted. User takes 4. Ends year with 6 left.
- Company allows up to 5 days carry-over.
- 2028: starts with 10 (new annual grant) + 5 (capped carry-over) 
  = 15 days available.

**Settings to add per time-off type:**
- annualGrant (days)
- maxCarryOver (days, or null for unlimited)
- resetDate (default Jan 1, configurable for non-calendar fiscal years)
- isSharedPool (already exists via sharedPoolWith)

**Logic touchpoints:**
- New balance computation that processes year boundaries.
- Year-rollover job: either lazy (computed at dashboard render) or 
  one-time at app load on/after Jan 1.
- Settings UI to configure per-type policy.

Until this ships, users adjust pool balances manually in Settings.

---

## Pre-populate holidays (deferred, post Phase 3)

When viewing a new year for the first time, the app could 
auto-create HOLIDAY entries for known company holidays so the 
user doesn't have to log each one manually.

**Two design options:**
- Per-company holiday calendar in Settings. Each company has its 
  own list of dates. User edits the list. Could include common 
  defaults (US federal holidays).
- Federal-holidays baseline. Pre-populate 11 US federal holidays 
  each year. User removes any their company does not observe.

The per-company option is more flexible and matches the 
multi-company architecture the app already has. Federal-baseline 
is simpler.

**Implementation touchpoints:**
- New settings section per company: list of holiday dates and names.
- Logic to insert HOLIDAY entries for any dates in the list that 
  do not already have an entry.
- Trigger: first time user opens the app in a new calendar year, 
  or via a "Sync holidays" button in Settings.

---

## Company-scoped time-off policy administration (deferred, post Phase 3)

Time-off types and their per-year pool overrides are stored 
per-company in the database (time_off_types.company_id), but 
the current UI exposes them as a general Settings section that 
any signed-in user can edit.

For the ADP-style multi-user model, this should move into a 
company-admin area:

- Regular users see the company's time-off policy as read-only 
  information (codes, labels, pool sizes, per-year overrides).
- Admins see the same data with edit controls.
- The "Add year override" form, the per-year override rows, and 
  the existing type fields (poolDays, hoursPerDay, etc.) all 
  belong here.

**Implementation touchpoints:**
- New Company Settings or Admin section, gated by the user's role 
  (profile.role === 'owner' or 'admin').
- Move the Time Off Types card out of the general Settings page.
- RLS policy review on time_off_types: read for all company 
  members, write only for admins.
- Profile-level Settings keeps user-scoped preferences (display 
  preferences, default views) only.

**Why deferred:** depends on the multi-company switcher and the 
role-based admin UI, neither of which exists yet. Until then, 
solo-user editing is fine since there is one user per company in 
practice.

---

## One-click clock in / clock out from dashboard (deferred, post Phase 3)

Add a "Clock In" / "Clock Out" button to the dashboard so the 
user can punch in and out without opening the entry modal. 
Captures system time and creates or updates today's entry.

**Behavior:**
- Dashboard shows a single primary button. If no entry exists 
  for today: button reads "Clock In" and is the primary action.
- On click: creates an entry for today with current system time 
  as clockIn (HH:MM), default break times 12:00 / 12:30, no 
  clockOut yet.
- Button changes to "Clock Out".
- On click: updates today's entry with current system time as 
  clockOut. Saves to Supabase via the normal saveKey path.
- Button changes to a confirmation state ("Logged out at 16:32"). 
  Visible until midnight or until the user returns the next day.
- If the user forgets and the day rolls over without clocking out, 
  the next day's "Clock In" still works. Yesterday's entry stays 
  with no clockOut (user can fix it manually via the modal).

**Manual override:**
- Daily Log view (existing) still lets the user add or edit any 
  entry. This is the recovery path if Clock In / Out is missed 
  or wrong.

**Edge cases to handle:**
- User is already clocked in for today (refresh page): button 
  still reads "Clock Out", uses the existing entry, not a new one.
- User clicks Clock In twice in a row: second click is a no-op or 
  shows a soft confirmation.
- User clicks Clock Out before Clock In on a fresh day: should 
  not be possible if the button states are wired right, but guard 
  anyway.
- The break (12:00 / 12:30) is recorded by default. If the user 
  is clocking out before 12:30, the break isn't real; consider 
  not recording break times until clockOut is later than 12:30.

**Implementation touchpoints:**
- Dashboard view component picks up a new top section.
- New helper for "current time as HH:MM string".
- Reuses existing entry save path; no new schema or DB work.

**Related deferred ideas this builds on:**
- Smart entry defaults (already captured above): the smart-default 
  logic for break times and time-off auto-fill should apply to 
  the Clock In / Clock Out flow too.

---

## Multi-company UX: Pay Period subtabs, per-company Settings, Daily Log indicator

Captured June 2026. Slot as 3e.7+ after 3e.4b, 3e.5, 3e.6 land.

**Pay Period view.** Subtabs at the top of the page, one per active company (`isActive !== false`). The selected subtab determines which company's pay period renders. On app load, default subtab is `profile.companyId` if it matches an active company, otherwise the first active company.

**Entry modal.** Add a Company picker listing active companies only.
- From a top-level "+ Add Entry": no preselected company; user picks before save.
- From inside a Pay Period subtab: picker pre-filled with that subtab's company; user can still change.
- The picker controls the `company_id` saved on the entry.

**Settings: time-off and standard day.** Move both from user-level to per-company, mirroring the per-company Pay Period section in 3e.4. Each active company gets its own Time-Off Types card and Standard Day card within the existing Settings page.
- `time_off_types` already has `company_id` from the Phase 3 schema; UI switches from user-level to company-level rendering and writes.
- Standard Day currently in `settings.standardDay`. Migrate to per-company columns on `companies` or a new table. Decide at build time.

**Daily Log.** No subtabs. Pick one at build time:
- A. Add a Company column to the table.
- B. Render the company name below the time/date for each row.

**Paychecks.** No change; already shows company name below the date.

**Implications.**
- `profile.companyId` semantics shift from "the single active company everywhere" to "default/last-viewed company."
- Every `activeCompany(state)` call site needs an audit pass: either rework to know its own scope (e.g. Pay Period subtab), or stay on profile-default fallback.
- Touchpoints: dashboard.js, entryModal.js, settings.js, log.js, activeCompany.js.

---
