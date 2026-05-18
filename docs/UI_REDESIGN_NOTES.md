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
