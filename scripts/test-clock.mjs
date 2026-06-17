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
  isOpenSegment, openSegmentIndex, findOpenClock, clockState,
  clockInToday, clockOut, nowHM, FORGOTTEN_CLOCK_HOURS,
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

// ---------------------------------------------------------------------------
// AUTO-BREAK on qualifying clock-out: > 5h on a weekday (Mon-Fri) sets
// breakTaken; the rule mirrors computeSegmentHours' deduction threshold.
// Calendar refs: 2026-06-17 is a Wednesday, 2026-06-20 is a Saturday.
// ---------------------------------------------------------------------------
function openMap(date, clockIn, extraSegs = []) {
  return {
    [date]: {
      date, companyId: '1',
      segments: [...extraSegs, { clockIn, clockOut: null, breakTaken: false }],
    },
  };
}

const wedSix = openMap('2026-06-17', '08:00');
clockOut(wedSix, '1', new Date(2026, 5, 17, 14, 0)); // 08:00 -> 14:00 = 6h
check('auto-break: 6h Wednesday sets breakTaken=true',
  wedSix['2026-06-17'].segments[0].breakTaken === true);

const wedFour = openMap('2026-06-17', '08:00');
clockOut(wedFour, '1', new Date(2026, 5, 17, 12, 0)); // 4h
check('auto-break: 4h Wednesday leaves breakTaken=false',
  wedFour['2026-06-17'].segments[0].breakTaken === false);

const satSix = openMap('2026-06-20', '08:00');
clockOut(satSix, '1', new Date(2026, 5, 20, 14, 0)); // 6h but Saturday
check('auto-break: 6h Saturday leaves breakTaken=false (weekend)',
  satSix['2026-06-20'].segments[0].breakTaken === false);

const wedFive = openMap('2026-06-17', '08:00');
clockOut(wedFive, '1', new Date(2026, 5, 17, 13, 0)); // exactly 5h
check('auto-break: 5h Wednesday leaves breakTaken=false (strictly > 5h, not >=)',
  wedFive['2026-06-17'].segments[0].breakTaken === false);

// Two segments: a prior closed 3h plus an open one that closes at 6h. Only the
// 6h segment (the one being closed) gets breakTaken; the 3h stays untouched.
const wedTwo = openMap('2026-06-17', '12:00',
  [{ clockIn: '08:00', clockOut: '11:00', breakTaken: false }]); // closed 3h
clockOut(wedTwo, '1', new Date(2026, 5, 17, 18, 0)); // open 12:00 -> 18:00 = 6h
check('auto-break: only the 6h segment gets breakTaken, 3h stays false',
  wedTwo['2026-06-17'].segments[0].breakTaken === false &&
  wedTwo['2026-06-17'].segments[1].breakTaken === true);

// ---------------------------------------------------------------------------
// clockState: hide Clock out across midnight. An open segment dated before
// today is a midnight orphan; the control offers Clock in and leaves it alone.
// ---------------------------------------------------------------------------
const nowToday = new Date(2026, 5, 17, 10, 0); // 2026-06-17
const csOpenToday = { '1': { '2026-06-17': { date: '2026-06-17', segments: [{ clockIn: '08:00', clockOut: null, breakTaken: false }] } } };
const stOut = clockState(csOpenToday, nowToday);
check('clockState: open segment dated today -> Clock out',
  stOut.mode === 'out' && stOut.open && stOut.open.date === '2026-06-17');

const csOpenYesterday = { '1': { '2026-06-16': { date: '2026-06-16', segments: [{ clockIn: '22:00', clockOut: null, breakTaken: false }] } } };
const stIn = clockState(csOpenYesterday, nowToday);
check('clockState: open segment dated yesterday -> Clock in (orphan)',
  stIn.mode === 'in' && stIn.open === null);
check('clockState: yesterday orphan left untouched in storage',
  csOpenYesterday['1']['2026-06-16'].segments[0].clockOut === null);

const csNone = { '1': { '2026-06-17': { date: '2026-06-17', segments: [{ clockIn: '08:00', clockOut: '16:30', breakTaken: true }] } } };
check('clockState: no open segment -> Clock in',
  clockState(csNone, nowToday).mode === 'in');

// ---------------------------------------------------------------------------
// Relaxed model: doClockIn guard agrees with clockState, and a prior-day
// orphan may coexist with today's fresh open clock.
// ---------------------------------------------------------------------------
// No open segments anywhere -> mode 'in' (clock-in allowed).
const csEmpty = { '1': {} };
check('clockState: no open segments anywhere -> Clock in (allow clock-in)',
  clockState(csEmpty, nowToday).mode === 'in');

// Prior-day orphan, no today-open -> mode 'in'. Then clock in today: the orphan
// is left untouched and today's open segment is appended. Two open segments on
// two dates coexist, and a follow-up clockState reports the active one (out).
const orphanMap = { '2026-06-16': { date: '2026-06-16', companyId: '1', segments: [{ clockIn: '22:00', clockOut: null, breakTaken: false }] } };
const orphanEbc = { '1': orphanMap };
check('clockState: prior-day orphan only -> Clock in (allow clock-in)',
  clockState(orphanEbc, nowToday).mode === 'in');
clockInToday(orphanMap, '1', nowToday); // appends today's open segment
check('relaxed: orphan untouched after clock-in (still open on 2026-06-16)',
  isOpenSegment(orphanMap['2026-06-16'].segments[0]));
check('relaxed: today open segment appended on 2026-06-17',
  !!orphanMap['2026-06-17'] && isOpenSegment(orphanMap['2026-06-17'].segments[0]));
check('relaxed: two open segments coexist on two dates',
  openSegmentIndex(orphanMap['2026-06-16']) !== -1 &&
  openSegmentIndex(orphanMap['2026-06-17']) !== -1);
const stAfter = clockState(orphanEbc, nowToday);
check('relaxed: follow-up clockState -> Clock out (active = today)',
  stAfter.mode === 'out' && stAfter.open && stAfter.open.date === '2026-06-17');

// ---------------------------------------------------------------------------
// FORGOTTEN CLOCK-OUT: any open segment older than FORGOTTEN_CLOCK_HOURS (16h)
// surfaces forgotten=true and forgottenOpen pointing at the OLDEST such open.
// Threshold is strict ( > 16h ); a normal shift never approaches it.
// ---------------------------------------------------------------------------
check('FORGOTTEN_CLOCK_HOURS is 16', FORGOTTEN_CLOCK_HOURS === 16);

// No open clock: not forgotten. (csNone holds only a closed segment.)
const fgNone = clockState(csNone, nowToday);
check('forgotten: no open -> forgotten false, forgottenOpen null',
  fgNone.forgotten === false && fgNone.forgottenOpen === null);

// Today's open clocked in 4h ago: well under threshold, not forgotten.
const fg4 = { '1': { '2026-06-17': { date: '2026-06-17', segments: [{ clockIn: '08:00', clockOut: null, breakTaken: false }] } } };
const st4 = clockState(fg4, new Date(2026, 5, 17, 12, 0)); // 08:00 -> 12:00 = 4h
check('forgotten: today open 4h ago -> not forgotten',
  st4.mode === 'out' && st4.forgotten === false && st4.forgottenOpen === null);

// Today's open clocked in 17h ago, still the same calendar day: forgotten.
const fg17 = { '1': { '2026-06-17': { date: '2026-06-17', segments: [{ clockIn: '06:00', clockOut: null, breakTaken: false }] } } };
const st17 = clockState(fg17, new Date(2026, 5, 17, 23, 0)); // 06:00 -> 23:00 = 17h
check('forgotten: today open 17h ago (same day) -> forgotten, points at it',
  st17.mode === 'out' && st17.forgotten === true &&
  st17.forgottenOpen && st17.forgottenOpen.date === '2026-06-17' && st17.forgottenOpen.clockIn === '06:00');

// Prior-day orphan: well past the threshold, forgotten, and not the active clock.
const fgOrphan = { '1': { '2026-06-15': { date: '2026-06-15', segments: [{ clockIn: '20:00', clockOut: null, breakTaken: false }] } } };
const stOrphan = clockState(fgOrphan, new Date(2026, 5, 17, 10, 0)); // ~38h old
check('forgotten: prior-day orphan -> forgotten, points at orphan, mode in',
  stOrphan.mode === 'in' && stOrphan.open === null && stOrphan.forgotten === true &&
  stOrphan.forgottenOpen && stOrphan.forgottenOpen.date === '2026-06-15');

// Multiple opens (prior-day orphan + today's open, both past threshold):
// forgottenOpen is the OLDEST, i.e. the orphan. Active clock is still today's.
const fgMulti = {
  '1': {
    '2026-06-16': { date: '2026-06-16', segments: [{ clockIn: '06:00', clockOut: null, breakTaken: false }] }, // ~41h at now
    '2026-06-17': { date: '2026-06-17', segments: [{ clockIn: '06:00', clockOut: null, breakTaken: false }] }, // 17h at now
  },
};
const stMulti = clockState(fgMulti, new Date(2026, 5, 17, 23, 0));
check('forgotten: multiple opens -> active is today, forgottenOpen is oldest (orphan)',
  stMulti.mode === 'out' && stMulti.open.date === '2026-06-17' &&
  stMulti.forgotten === true && stMulti.forgottenOpen.date === '2026-06-16');

// Threshold boundary on a same-day open clocked in at midnight. Strict > 16h:
// 16h - 1s and exactly 16h stay not forgotten; 16h + 1s flips to forgotten.
const fgBoundary = { '1': { '2026-06-17': { date: '2026-06-17', segments: [{ clockIn: '00:00', clockOut: null, breakTaken: false }] } } };
check('forgotten: 16h - 1s -> not forgotten',
  clockState(fgBoundary, new Date(2026, 5, 17, 15, 59, 59)).forgotten === false);
check('forgotten: exactly 16h -> not forgotten (strict >)',
  clockState(fgBoundary, new Date(2026, 5, 17, 16, 0, 0)).forgotten === false);
check('forgotten: 16h + 1s -> forgotten',
  clockState(fgBoundary, new Date(2026, 5, 17, 16, 0, 1)).forgotten === true);

console.log(`\n${fail === 0 ? 'All clock self-tests passed.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
