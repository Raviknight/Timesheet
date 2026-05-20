/**
 * src/data/standardDay.js
 *
 * Standard Day resolution and hours computation.
 *
 * The "standard day" describes a user's typical work schedule (up to two
 * segments plus a break). It powers Smart Entry Defaults: when the user
 * opens the entry modal for a fresh day, the form pre-fills from here
 * instead of starting empty.
 *
 * Phase 1: user-level only. Read from userSettings.standard_day, with a
 * hardcoded fallback for users who have not configured one. Future phases
 * may layer company-level defaults or per-weekday schedules on top.
 *
 * Shape of a standard day:
 *   {
 *     seg1Start: "HH:MM" | null,
 *     seg1End:   "HH:MM" | null,
 *     seg2Start: "HH:MM" | null,   // optional second segment
 *     seg2End:   "HH:MM" | null,
 *   }
 *
 * Break minutes are sourced from pay-period settings (settings.breakMinutes),
 * not stored on the standard day itself.
 */

import { timeToMinutes } from '../core/time.js';

export const HARDCODED_FALLBACK = Object.freeze({
  seg1Start: '06:00',
  seg1End: '14:30',
  seg2Start: null,
  seg2End: null,
});

/**
 * Resolve which standard day applies to a user.
 * Returns the user-configured standard_day if present, else the hardcoded
 * fallback. Does not mutate input.
 */
export function resolveStandardDay(userSettings) {
  if (userSettings && userSettings.standard_day) {
    return userSettings.standard_day;
  }
  return HARDCODED_FALLBACK;
}

/**
 * Compute the total hours represented by a standard day.
 *
 * Sums each segment's duration in minutes. If the longest segment is
 * greater than 5 hours (300 min), subtract breakMinutes once from the
 * total. breakMinutes is supplied by the caller (sourced from pay-period
 * settings); null/undefined/negative values are treated as 0. Returns
 * hours as a Number.
 */
export function computeStandardDayHours(standardDay, breakMinutes) {
  if (!standardDay) return 0;

  const segments = [
    segmentMinutes(standardDay.seg1Start, standardDay.seg1End),
    segmentMinutes(standardDay.seg2Start, standardDay.seg2End),
  ].filter((m) => m > 0);

  if (segments.length === 0) return 0;

  const total = segments.reduce((sum, m) => sum + m, 0);
  const longest = Math.max(...segments);
  const breakNum = Number(breakMinutes);
  const breakMin = Number.isFinite(breakNum) && breakNum > 0 ? breakNum : 0;
  const net = longest > 300 ? total - breakMin : total;

  return net / 60;
}

function segmentMinutes(start, end) {
  const s = timeToMinutes(start);
  const e = timeToMinutes(end);
  if (s == null || e == null) return 0;
  return Math.max(0, e - s);
}

/*
 * Self-tests (run manually in browser console or a node REPL):
 *
 *   import { resolveStandardDay, computeStandardDayHours, HARDCODED_FALLBACK }
 *     from './standardDay.js';
 *
 *   // resolveStandardDay
 *   console.assert(resolveStandardDay(null) === HARDCODED_FALLBACK);
 *   console.assert(resolveStandardDay({}) === HARDCODED_FALLBACK);
 *   const custom = { standard_day: { seg1Start: '09:00', seg1End: '17:00',
 *                                    seg2Start: null, seg2End: null } };
 *   console.assert(resolveStandardDay(custom) === custom.standard_day);
 *
 *   // computeStandardDayHours: fallback 06:00 to 14:30 minus 30 min break
 *   //   = 8.5h - 0.5h = 8.0h (longest segment 510 min > 300)
 *   console.assert(computeStandardDayHours(HARDCODED_FALLBACK, 30) === 8);
 *
 *   // Short single segment: no break deducted
 *   console.assert(computeStandardDayHours({
 *     seg1Start: '09:00', seg1End: '13:00', seg2Start: null, seg2End: null,
 *   }, 30) === 4);
 *
 *   // Two segments, longest > 5h: deduct break once
 *   //   8h + 2h = 10h, longest 480 > 300, minus 0.5h = 9.5h
 *   console.assert(computeStandardDayHours({
 *     seg1Start: '08:00', seg1End: '16:00',
 *     seg2Start: '18:00', seg2End: '20:00',
 *   }, 30) === 9.5);
 *
 *   // Two short segments, neither > 5h: no break deducted
 *   //   4h + 3h = 7h, longest 240, no deduction
 *   console.assert(computeStandardDayHours({
 *     seg1Start: '08:00', seg1End: '12:00',
 *     seg2Start: '13:00', seg2End: '16:00',
 *   }, 30) === 7);
 *
 *   // breakMinutes 0 / missing / negative: treated as 0
 *   console.assert(computeStandardDayHours(HARDCODED_FALLBACK, 0) === 8.5);
 *   console.assert(computeStandardDayHours(HARDCODED_FALLBACK) === 8.5);
 *   console.assert(computeStandardDayHours(HARDCODED_FALLBACK, -10) === 8.5);
 *
 *   // Empty / missing
 *   console.assert(computeStandardDayHours(null, 30) === 0);
 *   console.assert(computeStandardDayHours({
 *     seg1Start: null, seg1End: null, seg2Start: null, seg2End: null,
 *   }, 30) === 0);
 */
