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

## Smart entry defaults (deferred — post Phase 3)

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
