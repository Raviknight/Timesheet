/**
 * src/core/payPeriod.js
 *
 * Date-only pay-period math. Replaces src/core/period.js in step 3e.3.
 *
 * Why this exists:
 *   The legacy module subtracted two local-midnight Date objects and
 *   divided by 86_400_000 ms to count days. Across a DST transition the
 *   wall-day span is 23h or 25h, not 24h, so Math.floor of that ratio
 *   drifted period boundaries by one day for any reference date sitting
 *   on the other side of a transition from the anchor.
 *
 * Rules:
 *   - All inputs and outputs are "YYYY-MM-DD" strings.
 *   - All internal math is on (y, m, d) integer tuples.
 *   - NO Date OBJECTS in this module. If you find yourself reaching for
 *     `new Date(...)` here, stop. Add a helper instead.
 *
 * Algorithms:
 *   - Days-from-civil / civil-from-days are Howard Hinnant's proleptic
 *     Gregorian conversions, calibrated so 1970-01-01 = 0.
 *   - Day-of-week is derived from that day count plus an offset so
 *     Sunday = 0, Saturday = 6. Same convention as JS Date.getDay().
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function parseISODate(s) {
  const y = +s.slice(0, 4);
  const m = +s.slice(5, 7);
  const d = +s.slice(8, 10);
  return { y, m, d };
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatISODate(y, m, d) {
  return y + '-' + pad2(m) + '-' + pad2(d);
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
}

const DAYS_IN_MONTH_COMMON = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysInMonth(y, m) {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return DAYS_IN_MONTH_COMMON[m - 1];
}

// Howard Hinnant's "days_from_civil". Returns the number of days from
// 1970-01-01 (negative for earlier dates).
function daysFromCivil(y, m, d) {
  const yAdj = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yAdj / 400);
  const yoe = yAdj - era * 400;
  const mAdj = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mAdj + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// Inverse of daysFromCivil. Returns { y, m, d }.
function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const yBase = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = m <= 2 ? yBase + 1 : yBase;
  return { y, m, d };
}

function addDays(s, n) {
  const { y, m, d } = parseISODate(s);
  const t = civilFromDays(daysFromCivil(y, m, d) + n);
  return formatISODate(t.y, t.m, t.d);
}

function diffDays(a, b) {
  const A = parseISODate(a);
  const B = parseISODate(b);
  return daysFromCivil(A.y, A.m, A.d) - daysFromCivil(B.y, B.m, B.d);
}

// 1970-01-01 was a Thursday. JS getDay() encodes Sunday=0..Saturday=6,
// so Thursday=4. (daysFromCivil + 4) mod 7 keeps that calibration.
function dayOfWeek(s) {
  const { y, m, d } = parseISODate(s);
  return ((daysFromCivil(y, m, d) + 4) % 7 + 7) % 7;
}

function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the pay period that contains the given date for the given company.
 *
 * @param {string} dateString  "YYYY-MM-DD"
 * @param {object} company     fields from the v3 companies row:
 *                             payFrequency, weekStartDow, biweeklyRefDate,
 *                             semiFirstDay, semiSecondDay, monthlyStartDay,
 *                             advancedAnchorDate, advancedCycleDays
 * @returns {{ start: string, end: string }}  inclusive on both ends
 */
export function getPayPeriodForDate(dateString, company) {
  const freq = company.payFrequency || 'biweekly';

  if (freq === 'weekly') {
    const wsd = company.weekStartDow ?? 1;
    const offset = ((dayOfWeek(dateString) - wsd) % 7 + 7) % 7;
    const start = addDays(dateString, -offset);
    const end = addDays(start, 6);
    return { start, end };
  }

  if (freq === 'biweekly') {
    const anchor = company.biweeklyRefDate;
    if (!anchor) {
      throw new Error('biweekly company is missing biweeklyRefDate');
    }
    const diff = diffDays(dateString, anchor);
    const offset = ((diff % 14) + 14) % 14;
    const start = addDays(dateString, -offset);
    const end = addDays(start, 13);
    return { start, end };
  }

  if (freq === 'semimonthly') {
    const d1raw = clamp(company.semiFirstDay ?? 1, 1, 28);
    const d2raw = clamp(company.semiSecondDay ?? 16, 1, 28);
    const dA = d1raw <= d2raw ? d1raw : d2raw;
    const dB = d1raw <= d2raw ? d2raw : d1raw;
    const { y, m, d } = parseISODate(dateString);
    if (d >= dA && d < dB) {
      return {
        start: formatISODate(y, m, dA),
        end: formatISODate(y, m, dB - 1),
      };
    }
    if (d >= dB) {
      return {
        start: formatISODate(y, m, dB),
        end: formatISODate(y, m, daysInMonth(y, m)),
      };
    }
    // d < dA — belongs to previous month's second period.
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return {
      start: formatISODate(py, pm, dB),
      end: formatISODate(py, pm, daysInMonth(py, pm)),
    };
  }

  if (freq === 'monthly') {
    const d1 = clamp(company.monthlyStartDay ?? 1, 1, 28);
    const { y, m, d } = parseISODate(dateString);
    if (d >= d1) {
      const ny = m === 12 ? y + 1 : y;
      const nm = m === 12 ? 1 : m + 1;
      return {
        start: formatISODate(y, m, d1),
        end: addDays(formatISODate(ny, nm, d1), -1),
      };
    }
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    return {
      start: formatISODate(py, pm, d1),
      end: addDays(formatISODate(y, m, d1), -1),
    };
  }

  if (freq === 'advanced') {
    const anchor = company.advancedAnchorDate;
    if (!anchor) {
      throw new Error('advanced company is missing advancedAnchorDate');
    }
    const cycle = company.advancedCycleDays || 14;
    const diff = diffDays(dateString, anchor);
    const offset = ((diff % cycle) + cycle) % cycle;
    const start = addDays(dateString, -offset);
    const end = addDays(start, cycle - 1);
    return { start, end };
  }

  throw new Error('Unknown payFrequency: ' + freq);
}

/**
 * Split a pay period into week-sized chunks aligned to weekStartDow.
 * The first chunk starts at `start` (which may not be on a weekStartDow);
 * its end is the day before the next weekStartDow boundary. Subsequent
 * chunks are full Mon→Sun (or whatever start day is configured) weeks.
 * The final chunk is clipped to `end`.
 *
 * Each chunk is at most 7 days. Both bounds inclusive.
 *
 * @param {string} start            "YYYY-MM-DD"
 * @param {string} end              "YYYY-MM-DD"
 * @param {number} weekStartDow     0=Sun .. 6=Sat
 * @returns {Array<{ start: string, end: string }>}
 */
export function splitPayPeriodIntoWeeks(start, end, weekStartDow) {
  const out = [];
  let cur = start;
  while (cur <= end) {
    const curDow = dayOfWeek(cur);
    let chunkEnd;
    if (curDow === weekStartDow) {
      chunkEnd = addDays(cur, 6);
    } else {
      const daysToNext = ((weekStartDow - curDow) % 7 + 7) % 7;
      chunkEnd = addDays(cur, daysToNext - 1);
    }
    if (chunkEnd > end) chunkEnd = end;
    out.push({ start: cur, end: chunkEnd });
    cur = addDays(chunkEnd, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Self-test recipe (run via: node scripts/test-payPeriod.mjs).
// The script covers: DST-window biweekly continuity, weekly/monthly/
// semimonthly/advanced boundaries, and splitPayPeriodIntoWeeks edge cases.
// ---------------------------------------------------------------------------
