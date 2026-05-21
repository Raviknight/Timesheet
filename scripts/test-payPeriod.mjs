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
// Test 1: biweekly across the DST window
// Anchor 2025-12-28 is a Sunday. Every period start should also be a Sunday.
// ---------------------------------------------------------------------------

const bi = {
  payFrequency: 'biweekly',
  weekStartDow: 1,
  biweeklyRefDate: '2025-12-28',
};

eq('biweekly: anchor date itself',
  getPayPeriodForDate('2025-12-28', bi),
  { start: '2025-12-28', end: '2026-01-10' });

eq('biweekly: one day after anchor',
  getPayPeriodForDate('2025-12-29', bi),
  { start: '2025-12-28', end: '2026-01-10' });

eq('biweekly: last day of first period',
  getPayPeriodForDate('2026-01-10', bi),
  { start: '2025-12-28', end: '2026-01-10' });

eq('biweekly: first day of second period',
  getPayPeriodForDate('2026-01-11', bi),
  { start: '2026-01-11', end: '2026-01-24' });

eq('biweekly: across spring DST (start)',
  getPayPeriodForDate('2026-03-08', bi),
  { start: '2026-03-08', end: '2026-03-21' });

eq('biweekly: across spring DST (mid)',
  getPayPeriodForDate('2026-03-09', bi),
  { start: '2026-03-08', end: '2026-03-21' });

// Note: the spec listed 2026-05-18/2026-05-31 here, but with a Sunday
// anchor of 2025-12-28 and a 14-day cycle, period starts land on Sundays:
//   ..., 2026-05-03, 2026-05-17, 2026-05-31.
// 2026-05-21 (Thu) falls inside 2026-05-17 → 2026-05-30. The spec value
// would have implied a Monday anchor, which contradicts 2025-12-28.
eq('biweekly: today (post-spring-DST, Sunday-anchored)',
  getPayPeriodForDate('2026-05-21', bi),
  { start: '2026-05-17', end: '2026-05-30' });

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

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll self-tests passed.');
}
