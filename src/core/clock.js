/**
 * src/core/clock.js
 *
 * One-click clock in/out (3e.9). Pure helpers over the entry/segment model;
 * no DOM, no storage. The dashboard wires these to a button and the
 * per-company persistence path.
 *
 * Model recap (see src/core/time.js): an entry is keyed by date in a company's
 * entry map and holds segments[] of { clockIn, clockOut, breakTaken }, each a
 * "HH:MM" string. A segment with a clockIn and NO clockOut is OPEN. The pay
 * math (computeSegmentHours) already returns 0 for a missing clockOut, so an
 * open segment contributes nothing to any total until it is closed.
 *
 * Invariant: at most one open clock per company per day. The relaxed model
 * lets a prior-day orphan (a clock left running across midnight) coexist with
 * today's open clock; clockState treats the orphan as inactive so a fresh
 * clock-in is allowed without first closing it.
 */

import { fmtDate, pad, parseDate, segmentQualifiesForBreak } from './time.js';

/**
 * Hours an open clock may run before it reads as a forgotten clock-out. Single
 * source of truth for the threshold; the dashboard surfaces a fix button past
 * it and clockState reports it. A normal shift never approaches 16h, so any
 * open clock older than this is almost certainly a missed clock-out (including
 * every prior-day orphan, which is by definition more than a day old).
 */
export const FORGOTTEN_CLOCK_HOURS = 16;

/** True when a segment has been clocked into but not yet out. */
export function isOpenSegment(seg) {
  return !!(seg && seg.clockIn && !seg.clockOut);
}

/** Index of the open segment in an entry, or -1 when none is open. */
export function openSegmentIndex(entry) {
  if (!entry || !Array.isArray(entry.segments)) return -1;
  return entry.segments.findIndex(isOpenSegment);
}

/**
 * Scan every loaded company's entry map for an open segment. Returns the first
 * match as { companyId, date, segIndex, clockIn } or null. companyId is the key
 * under which the map sits in entriesByCompany (the per-company write path key).
 *
 * @param {Object<string, Object<string, object>>} entriesByCompany
 */
export function findOpenClock(entriesByCompany) {
  if (!entriesByCompany) return null;
  for (const companyId of Object.keys(entriesByCompany)) {
    const map = entriesByCompany[companyId];
    if (!map) continue;
    for (const date of Object.keys(map)) {
      const segIndex = openSegmentIndex(map[date]);
      if (segIndex !== -1) {
        return { companyId, date, segIndex, clockIn: map[date].segments[segIndex].clockIn };
      }
    }
  }
  return null;
}

/**
 * Age in hours of an open segment, measured from its clock-in timestamp (the
 * entry's date plus the segment's "HH:MM") to `now`. Reuses parseDate's local
 * date convention so this matches every other date read in the app.
 */
function openSegmentAgeHours(date, clockIn, now) {
  const d = parseDate(date);
  const [h, m] = String(clockIn || '0:0').split(':').map(Number);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h || 0, m || 0, 0, 0);
  return (now.getTime() - start.getTime()) / 3600000;
}

/**
 * Decide what the dashboard clock control should offer.
 *
 * The ACTIVE clock is an open segment dated today or later. An open segment
 * dated strictly earlier than today is a midnight orphan (a clock left running
 * across midnight, or longer): we do NOT treat it as active, so the control
 * offers Clock in. The orphan stays in storage untouched, with no guessed end
 * time; the user closes it later by editing the entry. Under the relaxed
 * per-company-per-day model an orphan and today's open clock may coexist.
 *
 * Independently of which clock is active, any open segment older than
 * FORGOTTEN_CLOCK_HOURS is flagged as a forgotten clock-out so the dashboard
 * can offer a fix. forgottenOpen is the OLDEST such segment (the one most in
 * need of attention). A prior-day orphan is always past the threshold, so it
 * surfaces here too, in addition to staying out of the active-clock decision.
 *
 * @param {Object<string, Object<string, object>>} entriesByCompany
 * @returns {{ mode: 'in' | 'out', open: object|null,
 *             forgotten: boolean, forgottenOpen: object|null }}
 *          mode 'out' carries the active open clock ({companyId, date,
 *          segIndex, clockIn}, matching findOpenClock's shape); mode 'in'
 *          carries open: null. forgottenOpen (same shape) is the oldest open
 *          segment past the threshold, or null when forgotten is false.
 */
export function clockState(entriesByCompany, now = new Date()) {
  if (!entriesByCompany) return { mode: 'in', open: null, forgotten: false, forgottenOpen: null };
  const today = todayStr(now);
  // The relaxed model allows a prior-day orphan to coexist with today's open
  // clock, so we cannot just take findOpenClock's first match (that could be
  // the orphan). The ACTIVE clock is the first open segment dated today or
  // later; prior-day orphans are skipped and left for the user to close. We
  // also scan every open segment for the oldest one past the forgotten
  // threshold, which is reported alongside regardless of which clock is active.
  let active = null;
  let forgottenOpen = null;
  let oldestAge = -Infinity;
  for (const companyId of Object.keys(entriesByCompany)) {
    const map = entriesByCompany[companyId];
    if (!map) continue;
    for (const date of Object.keys(map)) {
      const segIndex = openSegmentIndex(map[date]);
      if (segIndex === -1) continue;
      const clockIn = map[date].segments[segIndex].clockIn;
      const rec = { companyId, date, segIndex, clockIn };
      if (!active && date >= today) active = rec;
      const age = openSegmentAgeHours(date, clockIn, now);
      if (age > FORGOTTEN_CLOCK_HOURS && age > oldestAge) {
        oldestAge = age;
        forgottenOpen = rec;
      }
    }
  }
  return active
    ? { mode: 'out', open: active, forgotten: !!forgottenOpen, forgottenOpen }
    : { mode: 'in', open: null, forgotten: !!forgottenOpen, forgottenOpen };
}

/** Current wall-clock time as "HH:MM" (no rounding; the pay basis rounds). */
export function nowHM(now = new Date()) {
  return pad(now.getHours()) + ':' + pad(now.getMinutes());
}

/** Today's date as "YYYY-MM-DD". */
export function todayStr(now = new Date()) {
  return fmtDate(now);
}

/**
 * Stamp a clock-in onto today's entry in `map` for the given company, creating
 * the entry if none exists for today. Appends an open segment (clockOut null).
 * breakTaken starts false; the user owns the break judgment in the entry modal.
 * Mutates `map` in place and returns the affected date.
 *
 * Caller must have already verified no ACTIVE clock exists (clockState mode
 * 'out'). A prior-day orphan may still be present and is left untouched; this
 * just appends today's open segment alongside it.
 */
export function clockInToday(map, companyId, now = new Date()) {
  const date = todayStr(now);
  let entry = map[date];
  if (!entry) {
    entry = { date, segments: [], timeOff: null, notes: null, companyId };
    map[date] = entry;
  }
  if (!Array.isArray(entry.segments)) entry.segments = [];
  entry.segments.push({ clockIn: nowHM(now), clockOut: null, breakTaken: false });
  return date;
}

/**
 * Close the open clock found in `map`. Stamps the current time as the open
 * segment's clockOut.
 *
 * Midnight edge: a segment stores only "HH:MM", with no date of its own, so a
 * single segment cannot span midnight. When the clock-out lands on a later
 * calendar date than the open segment's entry, we split rather than write a
 * backwards (gross <= 0 → 0 hours) segment: the start day's segment is closed
 * at 23:59 and a fresh segment 00:00 -> now is added to today's entry (created
 * if needed). With 15-minute rounding the boundary minute is recovered, so the
 * two-day total matches the real elapsed time on the pay basis.
 *
 * Returns { date, crossedMidnight, days } describing what happened, or null if
 * there was no open clock in this map.
 *
 * @param {Object<string, object>} map        one company's entry map
 * @param {string}                 companyId  key for any new same-day entry
 */
export function clockOut(map, companyId, now = new Date()) {
  // Find the open segment in this map.
  let openDate = null, segIndex = -1;
  for (const date of Object.keys(map)) {
    const idx = openSegmentIndex(map[date]);
    if (idx !== -1) { openDate = date; segIndex = idx; break; }
  }
  if (openDate === null) return null;

  const today = todayStr(now);
  const seg = map[openDate].segments[segIndex];

  if (today === openDate) {
    seg.clockOut = nowHM(now);
    // Auto-mark the break on a qualifying clock-out (> 5h, weekday). Same rule
    // computeSegmentHours uses to deduct; the helper owns the threshold so it
    // is not re-implemented here. Non-qualifying segments are left untouched.
    if (segmentQualifiesForBreak(seg, openDate)) seg.breakTaken = true;
    return { date: openDate, crossedMidnight: false, days: [openDate] };
  }

  // Crossed midnight: close the start day at 23:59, open a fresh same-day
  // segment from 00:00 to now. Both ends are real, representable times.
  seg.clockOut = '23:59';
  let todayEntry = map[today];
  if (!todayEntry) {
    todayEntry = { date: today, segments: [], timeOff: null, notes: null, companyId };
    map[today] = todayEntry;
  }
  if (!Array.isArray(todayEntry.segments)) todayEntry.segments = [];
  // A multi-day gap (clock left open over 24h) loses the full days in between;
  // that is an absurd shift, so we record only the start-day tail and today's
  // head and let the caller warn. The common case is an adjacent-day shift.
  todayEntry.segments.push({ clockIn: '00:00', clockOut: nowHM(now), breakTaken: false });
  return { date: openDate, crossedMidnight: true, days: [openDate, today] };
}
