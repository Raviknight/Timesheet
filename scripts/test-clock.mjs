/**
 * scripts/test-clock.mjs
 *
 * Gate harness for one-click clock in/out (3e.9).
 *
 * Proves the hard gate: an OPEN segment (clockIn set, clockOut missing) is
 * excluded from every total. An entry with one open and one closed segment
 * must count only the closed one, and every total must match the same entry
 * with the open segment removed, across worked / paid / rounded / unrounded.
 *
 * Also covers the helpers (findOpenClock, clockInToday, clockOut) and the
 * midnight-crossing split.
 *
 * Run with: node scripts/test-clock.mjs
 */

import { computeHoursWorked, computeHoursPaid } from '../src/core/time.js';
import {
  isOpenSegment, openSegmentIndex, findOpenClock,
  clockInToday, clockOut, nowHM,
} from '../src/core/clock.js';

let pass = 0, fail = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? pass++ : fail++;
}
function eqHrs(name, got, want) {
  check(`${name} (got ${got}, want ${want})`, Math.abs(got - want) < 1e-9);
}

const settings = { breakMinutes: 30 };
const weekday = '2026-06-15'; // Monday
const timeOffTypes = [{ code: 'HOLIDAY', hoursPerDay: 8, additive: true }];

// ---------------------------------------------------------------------------
// GATE: open segment excluded from every total.
// ---------------------------------------------------------------------------
const closed = { clockIn: '08:00', clockOut: '16:30', breakTaken: true }; // 8.0h
const openSeg = { clockIn: '17:00', clockOut: null, breakTaken: false };  // open

const withOpen = { date: weekday, segments: [closed, openSeg] };
const withoutOpen = { date: weekday, segments: [closed] };

check('isOpenSegment true for missing clockOut', isOpenSegment(openSeg));
check('isOpenSegment false for closed', !isOpenSegment(closed));
check('openSegmentIndex finds the open one', openSegmentIndex(withOpen) === 1);

// Worked hours, rounded (pay basis) and unrounded: open seg adds nothing.
eqHrs('worked rounded: open counts as closed-only',
  computeHoursWorked(withOpen, settings, undefined),
  computeHoursWorked(withoutOpen, settings, undefined));
eqHrs('worked unrounded: open counts as closed-only',
  computeHoursWorked(withOpen, settings, undefined, false),
  computeHoursWorked(withoutOpen, settings, undefined, false));
eqHrs('worked total is exactly the closed segment (8.0h)',
  computeHoursWorked(withOpen, settings, undefined), 8.0);

// Paid hours, worked-only day and a HOLIDAY (additive) day: identical with/without open.
eqHrs('paid worked-only: open excluded',
  computeHoursPaid(withOpen, settings, timeOffTypes, undefined),
  computeHoursPaid(withoutOpen, settings, timeOffTypes, undefined));
const holWithOpen = { ...withOpen, timeOff: 'HOLIDAY' };
const holWithoutOpen = { ...withoutOpen, timeOff: 'HOLIDAY' };
eqHrs('paid HOLIDAY additive: open excluded',
  computeHoursPaid(holWithOpen, settings, timeOffTypes, undefined),
  computeHoursPaid(holWithoutOpen, settings, timeOffTypes, undefined));

// Open segment never errors a render-style read on a degenerate entry.
check('all-open entry → 0 worked, no throw',
  computeHoursWorked({ date: weekday, segments: [openSeg] }, settings, undefined) === 0);

// ---------------------------------------------------------------------------
// findOpenClock across companies: one open clock at a time.
// ---------------------------------------------------------------------------
const ebc = {
  '1': { [weekday]: { date: weekday, segments: [closed] } },
  '2': { '2026-06-16': { date: '2026-06-16', segments: [{ clockIn: '09:00', clockOut: null, breakTaken: false }] } },
};
const fc = findOpenClock(ebc);
check('findOpenClock locates the open clock in company 2',
  fc && fc.companyId === '2' && fc.date === '2026-06-16' && fc.clockIn === '09:00');
check('findOpenClock null when nothing open', findOpenClock({ '1': { [weekday]: { date: weekday, segments: [closed] } } }) === null);

// ---------------------------------------------------------------------------
// clockInToday: creates today's entry, appends an open segment.
// ---------------------------------------------------------------------------
const now1 = new Date(2026, 5, 15, 7, 3); // 2026-06-15 07:03
const map1 = {};
const d1 = clockInToday(map1, '1', now1);
check('clockInToday creates today entry', d1 === '2026-06-15' && !!map1['2026-06-15']);
check('clockInToday appends an open segment at now',
  map1['2026-06-15'].segments.length === 1 &&
  map1['2026-06-15'].segments[0].clockIn === '07:03' &&
  map1['2026-06-15'].segments[0].clockOut === null);
check('clockInToday tags companyId', map1['2026-06-15'].companyId === '1');

// Append onto an existing entry (clock in again same day after a clock-out).
clockInToday(map1, '1', new Date(2026, 5, 15, 13, 0));
check('clockInToday appends to existing day', map1['2026-06-15'].segments.length === 2);

// ---------------------------------------------------------------------------
// clockOut same day: stamps the open segment's clockOut.
// ---------------------------------------------------------------------------
const map2 = { '2026-06-15': { date: '2026-06-15', segments: [{ clockIn: '08:00', clockOut: null, breakTaken: false }], companyId: '1' } };
const r2 = clockOut(map2, '1', new Date(2026, 5, 15, 16, 30));
check('clockOut same-day stamps clockOut', r2 && !r2.crossedMidnight && map2['2026-06-15'].segments[0].clockOut === '16:30');
check('clockOut leaves no open clock', findOpenClock({ x: map2 }) === null);
check('clockOut returns null when nothing open', clockOut({ '2026-06-15': { date: '2026-06-15', segments: [] } }, '1') === null);

// ---------------------------------------------------------------------------
// MIDNIGHT EDGE: clock in 22:00 day 1, clock out 02:00 day 2.
// Split: start day closed at 23:59; today gets 00:00 -> 02:00. On the 15-min
// pay basis the two-day worked total equals the real 4h elapsed.
// ---------------------------------------------------------------------------
const map3 = { '2026-06-15': { date: '2026-06-15', segments: [{ clockIn: '22:00', clockOut: null, breakTaken: false }], companyId: '1' } };
const r3 = clockOut(map3, '1', new Date(2026, 5, 16, 2, 0));
check('midnight: flagged crossedMidnight', r3 && r3.crossedMidnight === true);
check('midnight: start day closed at 23:59', map3['2026-06-15'].segments[0].clockOut === '23:59');
check('midnight: today entry created 00:00 -> 02:00',
  map3['2026-06-16'] &&
  map3['2026-06-16'].segments[0].clockIn === '00:00' &&
  map3['2026-06-16'].segments[0].clockOut === '02:00');
check('midnight: no open clock left', findOpenClock({ x: map3 }) === null);
const midTotal =
  computeHoursWorked(map3['2026-06-15'], settings, undefined) +
  computeHoursWorked(map3['2026-06-16'], settings, undefined);
eqHrs('midnight: two-day worked total equals 4h elapsed', midTotal, 4.0);

// nowHM zero-pads.
check('nowHM pads', nowHM(new Date(2026, 5, 15, 9, 5)) === '09:05');

console.log(`\n${fail === 0 ? 'All clock self-tests passed.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
