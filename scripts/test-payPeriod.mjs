// scripts/test-payPeriod.mjs
//
// Step 3e.2 self-test for src/core/payPeriod.js. Covers:
//   1. Biweekly continuity across the DST window (the bug we're fixing).
//   2. Weekly boundaries with a Monday start.
//   3. Monthly boundaries including month rollover.
//   4. Semi-monthly boundaries on a 1/16 schedule.
//   5. Advanced with a custom cycle.
//   6. splitPayPeriodIntoWeeks edge cases.
//
// Run with: node scripts/test-payPeriod.mjs

import {
  getPayPeriodForDate,
  splitPayPeriodIntoWeeks,
} from '../src/core/payPeriod.js';
import { addDays } from '../src/core/time.js';

let failures = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL  ${label}\n      expected: ${e}\n      actual:   ${a}`);
    failures++;
  } else {
    console.log(`PASS  ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Test 1: biweekly via parity. Ferry='odd', Phillips='even'.
// Period starts always land on a Monday whose continuous week-index
// matches the company's parity. No DST sensitivity, no anchor date.
// ---------------------------------------------------------------------------

const ferry = {
  payFrequency: 'biweekly',
  weekStartDow: 1,
  biweeklyStartParity: 'odd',
};

eq('biweekly Ferry: today (Thu, mid-period)',
  getPayPeriodForDate('2026-05-21', ferry),
  { start: '2026-05-18', end: '2026-05-31' });

eq('biweekly Ferry: Sunday end of period',
  getPayPeriodForDate('2026-05-17', ferry),
  { start: '2026-05-04', end: '2026-05-17' });

eq('biweekly Ferry: Monday at period start',
  getPayPeriodForDate('2026-05-04', ferry),
  { start: '2026-05-04', end: '2026-05-17' });

eq('biweekly Ferry: Mon of ISO week 1, 2026',
  getPayPeriodForDate('2025-12-29', ferry),
  { start: '2025-12-29', end: '2026-01-11' });

eq('biweekly Ferry: across spring DST (Mon period start)',
  getPayPeriodForDate('2026-03-09', ferry),
  { start: '2026-03-09', end: '2026-03-22' });

eq('biweekly Ferry: Mon week before spring DST',
  getPayPeriodForDate('2026-03-02', ferry),
  { start: '2026-02-23', end: '2026-03-08' });

eq('biweekly Ferry: Mon of even-index week',
  getPayPeriodForDate('2025-12-22', ferry),
  { start: '2025-12-15', end: '2025-12-28' });

// Year-end edge: same period straddles the year boundary.
eq('biweekly Ferry: end-of-year period starts 2026-12-28',
  getPayPeriodForDate('2026-12-28', ferry),
  { start: '2026-12-28', end: '2027-01-10' });

eq('biweekly Ferry: 2027-01-04 still in 2026-12-28 period',
  getPayPeriodForDate('2027-01-04', ferry),
  { start: '2026-12-28', end: '2027-01-10' });

eq('biweekly Ferry: next period in 2027',
  getPayPeriodForDate('2027-01-11', ferry),
  { start: '2027-01-11', end: '2027-01-24' });

// Phillips runs on the opposite parity → exactly one week off Ferry.
const phillips = {
  payFrequency: 'biweekly',
  weekStartDow: 1,
  biweeklyStartParity: 'even',
};

eq('biweekly Phillips: today (one week off Ferry)',
  getPayPeriodForDate('2026-05-21', phillips),
  { start: '2026-05-11', end: '2026-05-24' });

eq('biweekly Phillips: Mon at period start',
  getPayPeriodForDate('2026-05-11', phillips),
  { start: '2026-05-11', end: '2026-05-24' });

// Mid-period sanity for Ferry.
eq('biweekly Ferry: 2026-05-25 stays in 2026-05-18 period',
  getPayPeriodForDate('2026-05-25', ferry),
  { start: '2026-05-18', end: '2026-05-31' });

// Default-to-'odd' behavior when parity is missing.
eq('biweekly: missing parity defaults to odd (same as Ferry)',
  getPayPeriodForDate('2026-05-21', { payFrequency: 'biweekly' }),
  { start: '2026-05-18', end: '2026-05-31' });

// ---------------------------------------------------------------------------
// Test 2: weekly
// ---------------------------------------------------------------------------

const wk = { payFrequency: 'weekly', weekStartDow: 1 };

eq('weekly: Thursday → Mon..Sun',
  getPayPeriodForDate('2026-05-21', wk),
  { start: '2026-05-18', end: '2026-05-24' });

eq('weekly: Monday is its own start',
  getPayPeriodForDate('2026-05-18', wk),
  { start: '2026-05-18', end: '2026-05-24' });

eq('weekly: Sunday rolls back to previous Monday',
  getPayPeriodForDate('2026-05-24', wk),
  { start: '2026-05-18', end: '2026-05-24' });

// Sunday-start weekly. 2026-05-21 (Thu) → previous Sun 2026-05-17 .. Sat 2026-05-23.
eq('weekly: Sunday-start variant',
  getPayPeriodForDate('2026-05-21', { payFrequency: 'weekly', weekStartDow: 0 }),
  { start: '2026-05-17', end: '2026-05-23' });

// ---------------------------------------------------------------------------
// Test 3: monthly
// ---------------------------------------------------------------------------

const mo = { payFrequency: 'monthly', monthlyStartDay: 1 };

eq('monthly: mid-month',
  getPayPeriodForDate('2026-05-21', mo),
  { start: '2026-05-01', end: '2026-05-31' });

eq('monthly: last day of month',
  getPayPeriodForDate('2026-05-31', mo),
  { start: '2026-05-01', end: '2026-05-31' });

eq('monthly: first day rolls to new period',
  getPayPeriodForDate('2026-06-01', mo),
  { start: '2026-06-01', end: '2026-06-30' });

// Year boundary
eq('monthly: December → January rollover',
  getPayPeriodForDate('2026-12-15', mo),
  { start: '2026-12-01', end: '2026-12-31' });

// Mid-month start (15th)
const mo15 = { payFrequency: 'monthly', monthlyStartDay: 15 };
eq('monthly: 15th-start, date before 15th → previous month',
  getPayPeriodForDate('2026-05-10', mo15),
  { start: '2026-04-15', end: '2026-05-14' });

// Leap year
const mo28 = { payFrequency: 'monthly', monthlyStartDay: 28 };
eq('monthly: 28th-start in Feb 2024 (leap)',
  getPayPeriodForDate('2024-02-28', mo28),
  { start: '2024-02-28', end: '2024-03-27' });

// ---------------------------------------------------------------------------
// Test 4: semimonthly (1 / 16)
// ---------------------------------------------------------------------------

const semi = { payFrequency: 'semimonthly', semiFirstDay: 1, semiSecondDay: 16 };

eq('semimonthly: 10th → first period',
  getPayPeriodForDate('2026-05-10', semi),
  { start: '2026-05-01', end: '2026-05-15' });

eq('semimonthly: 20th → second period',
  getPayPeriodForDate('2026-05-20', semi),
  { start: '2026-05-16', end: '2026-05-31' });

eq('semimonthly: 1st (boundary)',
  getPayPeriodForDate('2026-05-01', semi),
  { start: '2026-05-01', end: '2026-05-15' });

eq('semimonthly: 16th (boundary)',
  getPayPeriodForDate('2026-05-16', semi),
  { start: '2026-05-16', end: '2026-05-31' });

// Swapped order should still canonicalize. clamp(30,1,28)=28, clamp(15,1,28)=15
// → effective (dA=15, dB=28), so 2026-05-20 lands in 2026-05-15 .. 2026-05-27.
const semiSwap = { payFrequency: 'semimonthly', semiFirstDay: 30, semiSecondDay: 15 };
eq('semimonthly: swapped order canonicalizes',
  getPayPeriodForDate('2026-05-20', semiSwap),
  { start: '2026-05-15', end: '2026-05-27' });

// ---------------------------------------------------------------------------
// Test 5: advanced
// ---------------------------------------------------------------------------

const adv10 = {
  payFrequency: 'advanced',
  advancedAnchorDate: '2026-01-01',
  advancedCycleDays: 10,
};

eq('advanced: anchor',
  getPayPeriodForDate('2026-01-01', adv10),
  { start: '2026-01-01', end: '2026-01-10' });

eq('advanced: 5 days in',
  getPayPeriodForDate('2026-01-06', adv10),
  { start: '2026-01-01', end: '2026-01-10' });

eq('advanced: next cycle',
  getPayPeriodForDate('2026-01-11', adv10),
  { start: '2026-01-11', end: '2026-01-20' });

eq('advanced: date before anchor (negative diff)',
  getPayPeriodForDate('2025-12-25', adv10),
  { start: '2025-12-22', end: '2025-12-31' });

// ---------------------------------------------------------------------------
// Test 6: splitPayPeriodIntoWeeks
// ---------------------------------------------------------------------------

eq('splitWeeks: biweekly across week boundary (Mon start)',
  splitPayPeriodIntoWeeks('2025-12-28', '2026-01-10', 1),
  [
    { start: '2025-12-28', end: '2025-12-28' },
    { start: '2025-12-29', end: '2026-01-04' },
    { start: '2026-01-05', end: '2026-01-10' },
  ]);

eq('splitWeeks: aligned 7-day period → one chunk',
  splitPayPeriodIntoWeeks('2026-05-18', '2026-05-24', 1),
  [{ start: '2026-05-18', end: '2026-05-24' }]);

eq('splitWeeks: single day',
  splitPayPeriodIntoWeeks('2026-05-21', '2026-05-21', 1),
  [{ start: '2026-05-21', end: '2026-05-21' }]);

eq('splitWeeks: aligned 14-day period (Sun start) → two full weeks',
  splitPayPeriodIntoWeeks('2026-05-17', '2026-05-30', 0),
  [
    { start: '2026-05-17', end: '2026-05-23' },
    { start: '2026-05-24', end: '2026-05-30' },
  ]);

eq('splitWeeks: month-long period with Mon start',
  splitPayPeriodIntoWeeks('2026-05-01', '2026-05-31', 1),
  [
    { start: '2026-05-01', end: '2026-05-03' },  // Fri..Sun
    { start: '2026-05-04', end: '2026-05-10' },  // Mon..Sun
    { start: '2026-05-11', end: '2026-05-17' },  // Mon..Sun
    { start: '2026-05-18', end: '2026-05-24' },  // Mon..Sun
    { start: '2026-05-25', end: '2026-05-31' },  // Mon..Sun
  ]);

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 7. Prev/next pay-period stepping (added 2026-11-02).
//
// The dashboard stepper does not do frequency arithmetic. It resolves a date
// just OUTSIDE the period on screen and lets getPayPeriodForDate place it:
//
//     prev = getPayPeriodForDate(addDays(cur.start, -1))
//     next = getPayPeriodForDate(addDays(cur.end,   +1))
//
// That is only correct if consecutive periods are contiguous, with no gap and
// no overlap, for every frequency. If a frequency ever leaves a one-day hole
// between periods, the stepper would silently skip a period or stall. These
// assertions pin the property the stepper leans on.
// ---------------------------------------------------------------------------
console.log('\n-- 7. prev/next stepping --');
{
  const stepFreqs = [
    ['weekly', { payFrequency: 'weekly', weekStartDow: 1 }],
    ['biweekly', { payFrequency: 'biweekly', biweeklyStartParity: 'odd' }],
    ['semimonthly', { payFrequency: 'semimonthly', semiFirstDay: 1, semiSecondDay: 16 }],
    ['monthly', { payFrequency: 'monthly', monthlyStartDay: 1 }],
    ['advanced', { payFrequency: 'advanced', advancedAnchorDate: '2026-01-05', advancedCycleDays: 10 }],
  ];
  const stepFrom = (ref, company, dir) => {
    const cur = getPayPeriodForDate(ref, company);
    return dir < 0 ? addDays(cur.start, -1) : addDays(cur.end, 1);
  };

  for (const [name, company] of stepFreqs) {
    const here = getPayPeriodForDate('2026-10-26', company);

    // Contiguous on both sides: the day after the previous period's end is this
    // period's start, and the day after this end is the next period's start.
    const prev = getPayPeriodForDate(addDays(here.start, -1), company);
    const next = getPayPeriodForDate(addDays(here.end, 1), company);
    eq(`${name}: previous period abuts this one`, addDays(prev.end, 1), here.start);
    eq(`${name}: next period abuts this one`, addDays(here.end, 1), next.start);

    // Stepping back N and forward N returns to exactly the same period, so the
    // arrows cannot drift over a long walk (the reported pain: being far back
    // and needing to get home).
    let ref = '2026-10-26';
    for (let i = 0; i < 6; i++) ref = stepFrom(ref, company, -1);
    for (let i = 0; i < 6; i++) ref = stepFrom(ref, company, +1);
    eq(`${name}: 6 back then 6 forward returns home`,
      getPayPeriodForDate(ref, company), here);

    // Each step actually moves, and always in the right direction.
    const backOne = getPayPeriodForDate(stepFrom('2026-10-26', company, -1), company);
    const fwdOne = getPayPeriodForDate(stepFrom('2026-10-26', company, +1), company);
    eq(`${name}: one step back is earlier`, backOne.start < here.start, true);
    eq(`${name}: one step forward is later`, fwdOne.start > here.start, true);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll self-tests passed.');
}
