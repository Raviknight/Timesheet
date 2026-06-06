# EXCEL_LOGIC.md

The original `Time_Sheet_2026.xlsx` had complex formulas built up over years.
This document records the rules so they survive code refactors and Claude
context resets.

## Daily hours calculation (was Excel column H/P)

Original formula (Excel `LET` version, cell P4):

```
=LET(
  clockIn,    ROUND(D4*96,0)/96,
  clockOut,   ROUND(G4*96,0)/96,
  breakStart, ROUND(E4*96,0)/96,
  breakEnd,   ROUND(F4*96,0)/96,
  grossDur,   clockOut - clockIn,
  breakDur,   breakEnd - breakStart,
  isWeekday,  WEEKDAY(B4,2) < 6,
  deductBreak, AND(isWeekday, grossDur > 5/24),
  netDur,     grossDur - IF(deductBreak, breakDur, 0),
  IF(netDur > 0, netDur * 24, "")
)
```

**Rules encoded:**

1. **15-minute rounding.** `ROUND(t*96,0)/96` snaps each time to the nearest
   1/96 of a day, which is 15 minutes. Multiplying by 24 at the end gives
   decimal hours.
2. **Break deducted only on weekdays.** `WEEKDAY(B4,2) < 6` is Mon-Fri.
3. **Break deducted only when shift > 5 hours.** `grossDur > 5/24`.
4. **Empty result on bad data.** If clock-out earlier than clock-in, return
   blank string (renders as nothing in Excel).

**Web app version:** `src/core/time.js` → `computeSegmentHours()`. Extended to
sum multiple segments per day (which Excel didn't support — Ravi used a
single in/out per day).

## Pay period (was Excel cell N2)

```
=DATE(YEAR(TODAY()),1,1)
  + (IF(ISEVEN(WEEKNUM(TODAY())),
        WEEKNUM(TODAY())-1,
        WEEKNUM(TODAY())) - 1) * 7
  - WEEKDAY(DATE(YEAR(TODAY()),1,1),2) + 1
```

**Rules encoded:**

- Bi-weekly cycle starting on the first Monday of the year
- "Current pay period" snaps to whichever odd-numbered ISO week we're in

**Web app version:** `src/core/period.js`. Replaced with a system selector
(weekly / bi-weekly / semi-monthly / monthly / advanced) since different
employers use different cycles.

## Overtime (was Excel cell O7)

```
=MAX(0, SUMIFS(... worked, this_week, no_time_off) - 40)
+ MAX(0, SUMIFS(... worked, next_week, no_time_off) - 40)
```

**Rules encoded:**

- OT calculated per ISO week, not per pay period
- Only actually worked hours count toward the OT threshold. Worked hours are
  the sum of clocked segments (`computeHoursWorked`), nothing else.
- No time-off counts toward the OT threshold. That includes Holiday: its paid
  hours are an additive bonus that lands in the Holiday bucket, not in the
  OT-eligible worked total. PTO, Sick, and Unpaid likewise stay out of the
  worked total and land in the Time off bucket.
- Threshold is 40h per week

This is the worked-versus-paid split. "Worked" is segment hours only and is
what OT is measured against. "Paid" is `computeHoursPaid`: segment hours, plus
the type's hours for an additive type like Holiday, or the type's hours when a
non-additive type (PTO/Sick/Unpaid) has no segments. Totals and balances use
paid hours; OT uses worked hours.

**Web app version:** `src/ui/dashboard.js` computes regular vs OT on worked
hours only, over the active company's OT window. The threshold is per-company
(`company.otThreshold`, default 40) and the window follows `company.otPeriod`:
weekly (per week), biweekly (paired weeks), semimonthly (half-month split at
`semiSecondDay`), or monthly (calendar month). The split is accurate when the
OT window is equal to or shorter than the pay frequency; a window longer than
the pay period under-counts OT. There is no OT-period option for
semimonthly-as-pay or for the advanced cycle, by design.

## Time-off pool (was Excel cell M2 = 11)

A single number `11` represented Ravi's annual PTO+Sick pool in days. The
Dashboard sheet multiplied by 8 to convert to hours, then subtracted SUMIFs
of PTO and Sick categories.

**Web app version:** `src/core/balances.js`. Generalized to multiple pools
with sharedPoolWith semantics, and split into Taken / Scheduled / Remaining.

## Time-off categories (was Excel sheet "Source")

```
UNPAID  | Current
SICK    | Last
PTO     | Other
HOLIDAY |
```

Two unrelated lists in one sheet. The left column is time-off codes; the
right is the pay-period selector for the Dashboard.

**Web app version:** time-off codes in `src/data/schema.js` →
`DEFAULT_TIME_OFF_TYPES`. Pay-period selector is hardcoded UI in
`src/ui/dashboard.js`.

## Pay history (was Excel sheet "Sheet1")

Five columns: Date, Gross, Take Home, Hours, Place.

**Web app version:** `src/ui/paychecks.js` with the same five fields
(Company replaces Place).

## Things we dropped

- **Calculator sheet.** Looked like scratch arithmetic from Ravi's pre-2026
  pay periods. Not used by the app.
- **Dashboard "WEEK N" sub-selector.** When "Other" pay period was selected,
  Excel let you type a week number. Replaced with a date picker (less
  ambiguous, no need to know ISO week numbers).
- **F-style cell references in formulas.** All math is in JS now; no cell
  refs to maintain.
