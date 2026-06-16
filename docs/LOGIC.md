# LOGIC.md

This is the canonical statement of the app's payroll rules: how worked hours,
paid hours, overtime, time off, and pay periods are computed. Treat it as the
source of truth that the code implements, not a description of any one screen.

## Origins

These rules were ported from the original `Time_Sheet_2026.xlsx`, a personal
Excel timesheet Ravi built up over years. That spreadsheet is where the rules
came from and why some behaviors exist (15-minute rounding, the worked-versus-
paid split, the biweekly Monday anchor). The app now computes expected hours and
pay so they can be reconciled against the real paychecks an employer issues.
Where this doc and the code disagree, the code wins and this doc should be
corrected.

## Worked hours versus paid hours

Two different totals, used for different things.

- **Worked hours** are clocked segment time only: the sum of in/out segments
  after rounding and break deduction. Nothing else counts. This is what
  overtime is measured against.
- **Paid hours** are worked hours plus time-off hours: segment hours, plus an
  additive type's hours (Holiday), or a non-additive type's hours (PTO / Sick /
  Unpaid) when that day has no segments.

Totals and balances use paid hours. Overtime uses worked hours.

Code: `computeHoursWorked` and `computeHoursPaid` in `src/core/time.js`.

## Segment hours and break deduction

Each work day can have multiple segments (clock out for lunch, come back). Each
segment is computed independently and the day is the sum.

1. **15-minute rounding.** Clock-in and clock-out are each snapped to the
   nearest 15 minutes before the duration is taken. (In the original Excel this
   was `ROUND(t*96,0)/96`, since 1/96 of a day is 15 minutes.)
2. **Break is per segment, not per day.** A break is deducted from an individual
   segment, never once across the whole day.
3. **Break is deducted only when the segment qualifies.** Deduction applies when
   the segment is marked `breakTaken` AND the segment is longer than 5 hours.
   The user owns the judgment of when a break applies via the segment's
   checkbox.
4. **Break duration has a single source.** The minutes deducted come from
   `breakMinutes` on the Hours card. There is one break length; it is not stored
   or overridden anywhere else.
5. **Bad data yields no hours.** If clock-out is not after clock-in, the segment
   contributes nothing.

Code: `computeSegmentHours` in `src/core/time.js`.

## Overtime

Overtime is computed on worked hours only, inside an OT window, against a
threshold.

- **Worked hours only.** Only clocked segment hours count toward the OT
  threshold. Time off never does. Holiday in particular is an additive paid
  bonus that lands in the Holiday bucket, not in the OT-eligible worked total.
  PTO, Sick, and Unpaid likewise stay out of the worked total.
- **Per-company threshold.** The threshold is `company.otThreshold` (default 40
  hours).
- **Per-company window.** The window follows `company.otPeriod`:
  - weekly: each week independently
  - biweekly: paired weeks
  - semimonthly: half-month split at `semiSecondDay`
  - monthly: calendar month
- **Accuracy bound.** The split is accurate when the OT window is equal to or
  shorter than the pay frequency. A window longer than the pay period
  under-counts overtime, because OT earned in one pay period can be diluted
  across the longer window.
- There is no OT-period option for semimonthly-as-pay or for the advanced
  cycle, by design.

Code: OT windowing lives in `src/ui/dashboard.js`, which splits the active
company's window and computes regular versus OT on worked hours.

## Time-off types

Four types, two behaviors.

- **Holiday is a flat per-day benefit.** Its value is the type's `hoursPerDay`,
  identical whether or not the day is worked. Worked time on a holiday is worked
  hours on top of the benefit, never folded into Holiday. So a clocked 8h
  holiday reports 8 hours of Holiday plus 8 worked hours, not 16 of Holiday. The
  benefit lands in the Holiday bucket and never counts toward OT. The single
  source for this figure is `computeHoursBenefit` (paid minus worked) in
  `src/core/time.js`; the dashboard totals, week cards, annual block, and the
  balances tab all read it, so the views cannot drift.
- **PTO, Sick, Unpaid are non-additive.** When the day has no segments, the
  type's hours are the day's paid hours. They land in the Time off bucket and
  never count toward OT.
- **Unpaid days carry no hours figure.** An unpaid day is neither worked nor
  paid, so the balances tab shows only the day count for an unpaid type, no
  hours. This is a display rule; it does not change how unpaid is stored.

Code: time-off codes are defined in `src/data/schema.js`
(`DEFAULT_TIME_OFF_TYPES`).

## Time-off pools

Pools track how much PTO / Sick is available, split into Taken, Scheduled, and
Remaining. The original Excel held a single annual number (PTO+Sick in days,
multiplied by 8 for hours). The app generalizes this to multiple pools with
`sharedPoolWith` semantics.

Code: `src/core/balances.js`.

## PTO accrual model (in build)

This is the accrual model being built to replace the year-override pattern. It
is not yet wired into the UI; this section is the settled business logic the
implementation targets.

A pool's available balance for a person is derived from these inputs:

- **Base allotment.** Days per year for the type. This is the plain value the
  rule starts from. (Tenure-based growth is deferred to the company phase; a
  pure tenure function can feed this value later without changing the rule.)
- **Grant style.** Either granted up front at the start of the cycle, or accrued
  linearly across the cycle (a per-period or per-day fraction of the allotment).
- **Cycle anchor.** When the cycle starts and resets, off a per-person start
  date. One of: calendar (Jan 1), hire anniversary (the start date's month and
  day each year), or a fixed fiscal date.
- **Mid-cycle proration.** The first partial cycle is prorated. A person who
  starts partway through a cycle earns a fraction of the allotment for that
  first cycle, proportional to the remaining span.
- **Waiting / probation period.** An optional eligibility delay before any time
  off can be taken or accrued. Until it elapses, no balance is available.
- **Carry-forward.** Unused balance crossing a cycle boundary is one of: none
  (reset to the new allotment), a cap (carry up to a maximum), or unlimited.
  Carry-forward stacks on top of the new cycle's allotment.
- **Shared pools.** Types can share one pool via `sharedPoolWith`; usage of any
  sharing type draws the same balance, as today.

**Overdraw rule.** Pool time-off is paid from the balance in date order. Once
the pool is exhausted, further days of that type are unpaid, but they stay
categorized under that type. Exhaustion changes whether a day is paid, never
what type it is.

**Year-override is retired.** Instead of storing a per-year override and
reconstructing past years, the model reads the current year's value as the
opening allotment and runs the rule forward. Past years are not reconstructed.

Pay periods are anchored to a continuous week counter, not to calendar
year-starts.

- **Monday epoch.** Every Monday on the global calendar has a continuous integer
  index. `1970-01-05` (a Monday) is week index 0.
- **Per-company parity.** A biweekly company anchors its cycle to either
  odd-indexed or even-indexed Mondays via `company.biweeklyStartParity`
  (`'odd'` or `'even'`). Each company picks one; the cycle is derived from the
  Monday index, so it stays continuous across year boundaries and DST.
- **Other frequencies.** Weekly, semimonthly, monthly, and advanced cycles are
  supported through `company.payFrequency` and related fields.

Code: `src/core/payPeriod.js` (`weekIndex`, period resolution, and
`splitPayPeriodIntoWeeks`).

## Paychecks

Paycheck records carry Date, Gross, Take Home, Hours, and Company. These are the
real amounts an employer paid, recorded so the computed expected pay can be
reconciled against them.

Code: `src/ui/paychecks.js`.

## Open questions

- The original Excel deducted break strictly on weekdays (`WEEKDAY < 6`). The
  app instead relies on the per-segment `breakTaken` checkbox plus the >5h rule.
  These are not identical: the app trusts the user's checkbox rather than the
  day of week. Confirm this is the intended behavior and that no weekday
  auto-detection is expected.
