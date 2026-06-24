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

## PTO accrual

The pool balance, accrual, and coverage model. The engine is pure
(`src/core/accrual.js`, `computePoolAccrual`); the app feeds it per company and
reads the result through one coverage wrapper (`src/core/coverage.js`).

- **Allotment.** Each pool type has an allotment in days (`pool_days`). Grant
  style is either up front (the full allotment lands at cycle start) or accrued
  (earned linearly across the cycle).
- **Cycle anchor.** The cycle is anchored off a per-person hire date
  (`company.start_date`), one of: calendar (Jan 1), hire anniversary (the hire
  date's month and day each year), or fiscal (a fixed anchor date). The first
  cycle prorates for a mid-cycle hire, so someone hired partway through earns a
  fraction of that first cycle.
- **Waiting / probation.** A waiting period delays eligibility from the hire
  date; nothing earns or is payable before it. With no hire date recorded there
  is no probation (the person is treated as past it), and the cycle falls back
  to Jan 1 of the current year.
- **Carry-over.** Per type: none, a cap, or unlimited. Carried balance stacks on
  top of the next cycle's allotment, so a cap limits only the carried amount and
  cap-plus-allotment can exceed the cap.
- **Shared pools.** Types can share one pool via `sharedPoolWith`; the combined
  allotment and all the sharing types' usage draw the one balance.

**Reservation and booking.** Each time-off entry carries a status (approved or
pending) and a `bookedAt` stamped at first save. Only approved days reserve the
pool, in `bookedAt` order, falling back to `createdAt` then the time-off date
for legacy rows. Reservation is by booking order, not date order: a future
approved day reserves the pool now but pays only when its date occurs; a pending
day neither reserves nor pays; denied or cancelled days are excluded.

**Overdraw.** A pool day pays its per-day hours only if it was covered in
booking order. Once the pool is reserved out, later or over-pool days are
unpaid, but they stay categorized under their type. Holiday is never gated this
way (see Time-off types).

**Coverage application.** `paidHoursWithCoverage` (`src/core/coverage.js`) is a
thin wrapper over `computeHoursPaid`, which is unchanged. It drops only
explicitly uncovered or pending current-cycle pool days to zero; covered days
and out-of-scope days (for example a prior year the engine did not walk) pay
base. Coverage is computed once per company from a single engine result and read
by every paid-hours surface, so they cannot drift: period totals, week cards,
the Annual Total-paid tile, the balances tab, the paycheck Pull-from-period
prefill, and the Daily Log. Stored paychecks are records of what was actually
paid and are never recomputed.

**Allotment source.** The per-cycle allotment reads `pool_days`. The retired
per-year override `pool_by_year` was folded into `pool_days` and left dormant;
resolution happens in the caller so the engine stays frozen. Engine-side
per-cycle `poolByYear` is deferred until a real earlier hire date ever meets a
non-none carry-over.

Code: `src/core/accrual.js` (engine), `src/core/coverage.js` (per-company
coverage and the pay wrapper), `src/core/balances.js` (pool grouping).

## Pay-period anchoring

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

## Paycheck estimator

Personal-planning tool to project a take-home figure from a hypothetical gross.
NOT actual payroll withholding. Hourly rate is never stored. The estimator
result is clearly labeled an estimate in the UI.

### Inputs

- Per-period gross (typed each time, never persisted)
- Pay frequency: weekly (52), biweekly (26), semi-monthly (24), or monthly (12)
- State: one of 12 jurisdictions (PA, MA, NH, DE, RI, VT, NJ, CT, NY, MD, DC, VA)
- Filing status: single, married filing jointly, head of household
- Locality (state-conditional): NYC, Yonkers, Philadelphia, Wilmington, PA local
  EIT rate, MD county rate
- Deductions list: each row has a name, amount-per-period, and type.
  Types and their tax treatment:
    - `pre-tax-401k`        reduces federal + state, NOT FICA
    - `pre-tax-section125`  reduces federal + state + FICA (HSA, FSA, premiums)
    - `post-tax`            reduces take-home only
- State effective rate: only when the state/filing combination is in user-rate
  mode (caller-supplied), see "Coverage gaps" below

### Calculation flow

For each estimate, the engine:

1. **Annualizes** the per-period gross (× pay periods per year). All bracket
   math runs against the annual figure, then divides back to per-period. This
   matches how actual withholding works.
2. **Federal income tax**: applies the IRS 2026 bracket schedule for the chosen
   filing status against (annual gross − federal standard deduction − pre-tax
   deductions that reduce federal). Brackets and standard deductions come from
   IRS Rev. Proc. 2025-32.
3. **FICA**: Social Security 6.2% on (annual gross − Section-125 deductions) up
   to the 2026 wage base of $184,500; Medicare 1.45% on all wages; Additional
   Medicare 0.9% above the statutory threshold (Single/HoH $200k, MFJ $250k,
   MFS $125k). 401(k) deferrals do NOT reduce FICA wages.
4. **State income tax**: in bracket mode, runs the state's progressive schedule
   against (annual gross − state standard deduction − state pre-tax). Adds any
   state surtax (e.g., MA 4% over the inflation-adjusted millionaire threshold
   of $1,107,750 for 2026). In user-rate mode, multiplies state taxable income
   by the caller-supplied effective rate.
5. **Payroll add-ons** (state-specific, capped): NJ FLI, NY SDI/PFL, CT/MA
   PFML, RI TDI.
6. **Local taxes** (state-specific): NYC, Yonkers (resident surcharge =
   16.75% of state tax; non-resident = 0.5% of wages), Philadelphia (3.74%
   resident / 3.43% non-resident), Wilmington (1.25%), PA local EIT, MD county.
7. **Take-home** = gross − pre-tax − all taxes − post-tax.

### Coverage tiers

Per-filing-status mode chosen by what 2026 data has been verified:

- **Brackets** (full math): PA, MA, NH, DE, RI, VT for all statuses; NJ, CT, VT
  for single only (their MFJ/HoH thresholds are pending direct verification
  from the state's official PDF).
- **User-rate**: NY, MD, DC, VA for all statuses; NJ/CT/VT MFJ and HoH. The UI
  surfaces an "effective state rate %" input when this mode applies so the
  result is clearly an estimate against a user-supplied rate.

### Persistence

Two tables, both user-scoped via RLS:

- `estimator_settings` (1-to-1 per user): state, filing status, frequency,
  locality, deduction template, optional state effective rate. **No gross.**
- `estimate_history` (append-only): a full inputs+result snapshot per saved
  estimate, with optional note. Snapshot shape stays meaningful even if engine
  constants change later.

### Re-verification

Tax data in `src/core/tax.js` is valid for tax year 2026. Re-verify in January
when new IRS Rev. Proc. and state tables publish. The file's banner comment
calls this out and `.tax-research-2026.md` (gitignored scratch) has the
sources used.

Code: `src/core/tax.js`, `src/core/estimator.js`, `src/modals/estimateModal.js`.
Tests: `scripts/test-tax.mjs`, `scripts/test-estimator.mjs`.

## Open questions

- The original Excel deducted break strictly on weekdays (`WEEKDAY < 6`). The
  app instead relies on the per-segment `breakTaken` checkbox plus the >5h rule.
  These are not identical: the app trusts the user's checkbox rather than the
  day of week. Confirm this is the intended behavior and that no weekday
  auto-detection is expected.
