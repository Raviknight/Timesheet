/**
 * src/core/period.js
 *
 * Pay period calculation. Five supported systems:
 *   - weekly      : 7 days, starts on a chosen day of week
 *   - biweekly    : 14 days, anchored to a reference start date
 *   - semimonthly : two fixed days of month (e.g. 1st and 16th)
 *   - monthly     : 30/31 days starting on a chosen day of month
 *   - advanced    : custom cycleDays from an anchor date (escape hatch)
 *
 * Public functions all return { start, end, cycleDays } where start/end are
 * "YYYY-MM-DD" strings inclusive of both endpoints.
 */

import { fmtDate, parseDate, addDays } from './time.js';

export function clampDom(d) {
  return Math.max(1, Math.min(28, +d || 1));
}

export function lastDayOfMonth(y, m) {
  return new Date(y, m + 1, 0);
}

/** Return the pay period that contains the given date. */
export function getPeriodContaining(referenceDate, settings) {
  const ref = referenceDate instanceof Date
    ? new Date(referenceDate.getTime())
    : parseDate(referenceDate);
  ref.setHours(0, 0, 0, 0);

  const sys = settings.system || 'biweekly';

  if (sys === 'weekly') {
    const dow = ref.getDay();
    const startDow = +settings.startDow;
    const offset = (dow - startDow + 7) % 7;
    const start = new Date(ref);
    start.setDate(ref.getDate() - offset);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start, end, cycleDays: 7 };
  }

  if (sys === 'biweekly') {
    const anchor = parseDate(settings.biweeklyRef || settings.anchorDate || '2025-12-29');
    anchor.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((ref - anchor) / 86400000);
    const offset = ((diffDays % 14) + 14) % 14;
    const start = new Date(ref);
    start.setDate(ref.getDate() - offset);
    const end = new Date(start);
    end.setDate(start.getDate() + 13);
    return { start, end, cycleDays: 14 };
  }

  if (sys === 'semimonthly') {
    const d1 = clampDom(settings.semi1 || 1);
    const d2 = clampDom(settings.semi2 || 16);
    const [dA, dB] = d1 <= d2 ? [d1, d2] : [d2, d1];
    const y = ref.getFullYear();
    const m = ref.getMonth();
    const dom = ref.getDate();

    let start, end;
    if (dom >= dA && dom < dB) {
      start = new Date(y, m, dA);
      end = new Date(y, m, dB - 1);
    } else if (dom >= dB) {
      start = new Date(y, m, dB);
      end = lastDayOfMonth(y, m);
    } else {
      // before dA — belongs to previous month's second period
      const prev = new Date(y, m - 1, 1);
      start = new Date(prev.getFullYear(), prev.getMonth(), dB);
      end = lastDayOfMonth(prev.getFullYear(), prev.getMonth());
    }
    return { start, end, cycleDays: Math.round((end - start) / 86400000) + 1 };
  }

  if (sys === 'monthly') {
    const dStart = clampDom(settings.monthlyStart || 1);
    const y = ref.getFullYear();
    const m = ref.getMonth();
    const dom = ref.getDate();
    let start, end;
    if (dom >= dStart) {
      start = new Date(y, m, dStart);
      end = new Date(y, m + 1, dStart - 1);
    } else {
      start = new Date(y, m - 1, dStart);
      end = new Date(y, m, dStart - 1);
    }
    return { start, end, cycleDays: Math.round((end - start) / 86400000) + 1 };
  }

  // advanced: anchor + cycleDays
  const anchor = parseDate(settings.anchorDate || '2025-12-29');
  anchor.setHours(0, 0, 0, 0);
  const cycle = +settings.cycleDays || 14;
  const diffDays = Math.floor((ref - anchor) / 86400000);
  const offset = ((diffDays % cycle) + cycle) % cycle;
  const start = new Date(ref);
  start.setDate(ref.getDate() - offset);
  const end = new Date(start);
  end.setDate(start.getDate() + cycle - 1);
  return { start, end, cycleDays: cycle };
}

/**
 * Get the pay period for the dashboard selector ("current", "last", "other").
 * Returns string dates so they can be compared lexically against entry keys.
 */
export function getPayPeriodFor(mode, otherDate, settings) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (mode === 'current') {
    const p = getPeriodContaining(today, settings);
    return { start: fmtDate(p.start), end: fmtDate(p.end), cycleDays: p.cycleDays };
  }
  if (mode === 'last') {
    const cur = getPeriodContaining(today, settings);
    const refPrev = new Date(cur.start);
    refPrev.setDate(cur.start.getDate() - 1);
    const p = getPeriodContaining(refPrev, settings);
    return { start: fmtDate(p.start), end: fmtDate(p.end), cycleDays: p.cycleDays };
  }
  const ref = otherDate ? parseDate(otherDate) : today;
  const p = getPeriodContaining(ref, settings);
  return { start: fmtDate(p.start), end: fmtDate(p.end), cycleDays: p.cycleDays };
}

/**
 * Split a period into week-sized chunks for breakdown display. For periods
 * ≤ 7 days, returns one chunk labeled "Period".
 */
export function splitIntoWeeks(startStr, endStr) {
  const start = parseDate(startStr);
  const end = parseDate(endStr);
  const totalDays = Math.round((end - start) / 86400000) + 1;
  if (totalDays <= 7) {
    return [{ label: 'Period', start: startStr, end: endStr }];
  }
  const weeks = [];
  let cur = startStr;
  let wkIdx = 1;
  while (cur <= endStr) {
    const wkEnd = addDays(cur, 6);
    const segEnd = wkEnd > endStr ? endStr : wkEnd;
    weeks.push({ label: 'Week ' + wkIdx, start: cur, end: segEnd });
    cur = addDays(segEnd, 1);
    wkIdx++;
  }
  return weeks;
}
