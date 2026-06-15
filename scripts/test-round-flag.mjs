/**
 * scripts/test-round-flag.mjs
 *
 * Gate harness for the worked-hours round opt-out (3e.8).
 *
 * Confirms:
 *   1. The DEFAULT (rounded) path is byte-identical to an independent
 *      roundQuarter-based reference across several segment scenarios. If any
 *      case diverges, the pay basis changed: FAIL and STOP.
 *   2. round=false yields the exact, unrounded clocked time (still deducting
 *      break), so the new Actual-hours tile reads true hours.
 */

import { computeSegmentHours, computeHoursWorked, roundQuarter } from '../src/core/time.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = Math.abs(got - want) < 1e-9;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`);
  ok ? pass++ : fail++;
}

const settings = { breakMinutes: 30 };
const weekday = '2026-06-15'; // Monday

// Independent reference for the rounded pay basis.
function refSegHours(seg, breakMin) {
  const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  let gross = roundQuarter(toMin(seg.clockOut)) - roundQuarter(toMin(seg.clockIn));
  if (gross <= 0) return 0;
  if (seg.breakTaken && gross > 5 * 60 && breakMin > 0) gross -= breakMin;
  return Math.max(0, gross / 60);
}

const scenarios = [
  { clockIn: '08:00', clockOut: '16:30', breakTaken: true },  // clean, > 5h, break
  { clockIn: '08:07', clockOut: '16:23', breakTaken: true },  // off-grid mins, rounds
  { clockIn: '09:00', clockOut: '13:00', breakTaken: true },  // 4h, under 5h, no break
  { clockIn: '08:53', clockOut: '17:08', breakTaken: false }, // off-grid, no break
  { clockIn: '07:00', clockOut: '07:14', breakTaken: false }, // rounds to 0 gross
  { clockIn: '10:00', clockOut: '09:00', breakTaken: true },  // negative, clamps 0
];

// 1. Rounded default must match the reference exactly.
scenarios.forEach((s, i) => {
  const def = computeSegmentHours(s, weekday, settings, 30);          // default round
  const explicit = computeSegmentHours(s, weekday, settings, 30, true);
  const ref = refSegHours(s, 30);
  check(`seg[${i}] default === explicit-rounded`, def, explicit);
  check(`seg[${i}] default === roundQuarter reference`, def, ref);
});

// computeHoursWorked default identical to explicit round=true.
const entry = { date: weekday, segments: scenarios };
check('computeHoursWorked default === round=true',
  computeHoursWorked(entry, settings, undefined),
  computeHoursWorked(entry, settings, undefined, true));

// 2. Unrounded path: exact minutes, break still deducted on a > 5h segment.
// 08:07 -> 16:23 = 496 min gross, -30 break = 466 min = 7.7666... h
check('seg unrounded exact (08:07-16:23, break)',
  computeSegmentHours({ clockIn: '08:07', clockOut: '16:23', breakTaken: true }, weekday, settings, 30, false),
  (496 - 30) / 60);
// Sanity: unrounded differs from rounded for off-grid input.
const offGrid = { clockIn: '08:07', clockOut: '16:23', breakTaken: true };
const r = computeSegmentHours(offGrid, weekday, settings, 30, true);
const u = computeSegmentHours(offGrid, weekday, settings, 30, false);
check('rounded != unrounded for off-grid', r === u ? 1 : 0, 0);

console.log(`\n${fail === 0 ? 'All self-tests passed.' : fail + ' FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
