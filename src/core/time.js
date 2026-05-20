/**
 * src/core/time.js
 *
 * Time and date helpers, plus the canonical "hours worked" calculation.
 *
 * Rules encoded here (do not change without updating docs/EXCEL_LOGIC.md):
 *   1. Clock in/out times are rounded to the nearest 15 minutes.
 *   2. Break is deducted ONLY on weekdays, ONLY when a segment is > 5h,
 *      and ONLY when the segment is flagged as breakTaken.
 *   3. A day can have multiple segments (clock out, come back).
 *   4. Break is per-segment, not per-day.
 *   5. The break duration comes from settings.breakMinutes.
 */

export function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

export function fmtDate(d) {
  if (typeof d === 'string') return d;
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function parseDate(s) {
  if (s instanceof Date) return s;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d, n) {
  const dt = parseDate(d);
  dt.setDate(dt.getDate() + n);
  return fmtDate(dt);
}

export function dayShort(d) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][parseDate(d).getDay()];
}

export function timeToMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Snap a minute count to the nearest 15 minutes. */
export function roundQuarter(min) {
  return Math.round(min / 15) * 15;
}

/**
 * Normalize an entry to its segments[] form.
 */
export function entrySegments(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.segments) && entry.segments.length) return entry.segments;
  return [];
}

/**
 * Hours for ONE segment.
 *
 * @param {object} seg  { clockIn, clockOut, breakTaken }
 * @param {string} date "YYYY-MM-DD" (needed to determine weekday)
 * @param {object} settings  { breakMinutes }
 * @returns {number} hours, 0 if invalid
 */
export function computeSegmentHours(seg, date, settings) {
  const ci = timeToMinutes(seg.clockIn);
  const co = timeToMinutes(seg.clockOut);
  if (ci === null || co === null) return 0;

  const ciR = roundQuarter(ci);
  const coR = roundQuarter(co);
  let gross = coR - ciR;
  if (gross <= 0) return 0;

  const dow = parseDate(date).getDay();
  const isWeekday = dow >= 1 && dow <= 5;
  const breakDur = settings.breakMinutes || 0;

  if (seg.breakTaken && isWeekday && gross > 5 * 60 && breakDur > 0) {
    gross -= breakDur;
  }

  return Math.max(0, gross / 60);
}

/** Hours for a whole day (sum of all segments). */
export function computeHours(entry, settings) {
  if (!entry) return 0;
  const segs = entrySegments(entry);
  if (segs.length === 0) return 0;
  let total = 0;
  for (const seg of segs) {
    total += computeSegmentHours(seg, entry.date, settings);
  }
  return total;
}
