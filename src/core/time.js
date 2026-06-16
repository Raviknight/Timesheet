/**
 * src/core/time.js
 *
 * Time and date helpers, plus the canonical "hours worked" calculation.
 *
 * Rules encoded here (do not change without updating docs/LOGIC.md):
 *   1. Clock in/out times are rounded to the nearest 15 minutes.
 *   2. Break is deducted when the segment is flagged as breakTaken AND
 *      the segment is > 5h. The user owns the day-of-week judgment via
 *      the checkbox.
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

/** Zero-pad "H:MM" to "HH:MM" so HTML time inputs accept it. */
export function padHM(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':');
  if (h === undefined || m === undefined) return t;
  return pad(Number(h)) + ':' + pad(Number(m));
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
 * Effective break minutes for a company: the company's own break_minutes when
 * set, otherwise a flat default of 30. Uses a null-check, NOT a truthy check,
 * so a deliberately stored 0 (no break) is honored. The user-level setting is
 * no longer an inherit source; existing companies were seeded with their prior
 * effective break at load (see app.js), so dropping the inherit is
 * output-identical for them.
 *
 * @param {object}      settings  unused; kept for call-site signature stability
 * @param {object|null} company   the company object (null → 30)
 */
export function resolveBreakMinutes(settings, company) {
  if (company && company.breakMinutes != null) return company.breakMinutes;
  return 30;
}

/**
 * Find the company an entry belongs to, by its companyId. Returns null when
 * there is no match (no companies list, or the entry has no/unknown company),
 * in which case break resolution falls back to the user setting. Output stays
 * identical to the pre-per-company behavior whenever this is null.
 */
function companyForEntry(entry, companies) {
  if (!Array.isArray(companies) || !entry || entry.companyId == null) return null;
  const id = String(entry.companyId);
  return companies.find(c => String(c.id ?? '') === id) || null;
}

/**
 * Hours for ONE segment.
 *
 * @param {object} seg  { clockIn, clockOut, breakTaken }
 * @param {string} date "YYYY-MM-DD" (needed to determine weekday)
 * @param {object} settings  { breakMinutes }
 * @param {number} [breakMinutes]  effective break to deduct; when omitted,
 *        falls back to settings.breakMinutes (the original behavior). A passed
 *        value, including 0, is used as-is.
 * @returns {number} hours, 0 if invalid
 */
export function computeSegmentHours(seg, date, settings, breakMinutes, round = true) {
  const ci = timeToMinutes(seg.clockIn);
  const co = timeToMinutes(seg.clockOut);
  if (ci === null || co === null) return 0;

  // 15-minute rounding is the pay basis (default). Pass round=false for an
  // exact, unrounded read of clocked time (the Annual "Actual hours" tile).
  const ciR = round ? roundQuarter(ci) : ci;
  const coR = round ? roundQuarter(co) : co;
  let gross = coR - ciR;
  if (gross <= 0) return 0;

  const breakDur = breakMinutes != null ? breakMinutes : (settings.breakMinutes || 0);
  if (seg.breakTaken && gross > 5 * 60 && breakDur > 0) {
    gross -= breakDur;
  }

  return Math.max(0, gross / 60);
}

/**
 * Worked hours for a day: sum of segment hours only. Ignores any time-off
 * code. Use this for OT calculations and anything that means "time the
 * user actually clocked in".
 *
 * Break is resolved per entry from the entry's own company (via `companies`),
 * falling back to settings.breakMinutes. When `companies` is omitted, or the
 * company has no override, the result is identical to the old single-break
 * behavior.
 *
 * @param {object}   entry
 * @param {object}   settings
 * @param {object[]} [companies]  state.companies, to resolve the entry's break
 * @param {boolean}  [round=true]  apply 15-minute rounding (the pay basis).
 *        Pass false for an exact, unrounded total. Break is deducted either way.
 */
export function computeHoursWorked(entry, settings, companies, round = true) {
  if (!entry) return 0;
  const segs = entrySegments(entry);
  if (segs.length === 0) return 0;
  const breakMin = resolveBreakMinutes(settings, companyForEntry(entry, companies));
  let total = 0;
  for (const seg of segs) {
    total += computeSegmentHours(seg, entry.date, settings, breakMin, round);
  }
  return total;
}

/**
 * Paid hours for a day.
 *
 * Resolution rules:
 *   - Worked-only day: sum of segment hours.
 *   - Time-off type is additive (e.g. HOLIDAY): segment hours + the type's
 *     hoursPerDay. The holiday pay sits on top of any work done that day.
 *   - Time-off type is non-additive (PTO/SICK/UNPAID): segments win when
 *     present; otherwise the type's hoursPerDay (8 fallback).
 *
 * Use this for totals, balances, and any display that means "hours the
 * user gets paid for", including pure time-off days.
 *
 * @param {object}   entry
 * @param {object}   settings
 * @param {object[]} [timeOffTypes]  state.timeOffTypes; needed to resolve
 *                                   implied hours and additive flag for
 *                                   time-off entries
 * @param {object[]} [companies]     state.companies; resolves the entry's
 *                                   per-company break (passed to worked hours)
 */
export function computeHoursPaid(entry, settings, timeOffTypes, companies) {
  if (!entry) return 0;
  const segHrs = computeHoursWorked(entry, settings, companies);
  if (!entry.timeOff) return segHrs;

  let timeOffHrs = 8;
  let additive = false;
  if (Array.isArray(timeOffTypes)) {
    const t = timeOffTypes.find(x => x.code === entry.timeOff);
    if (t) {
      timeOffHrs = t.hoursPerDay ?? 8;
      additive = !!t.additive;
    }
  }
  if (additive) return segHrs + timeOffHrs;
  return segHrs > 0 ? segHrs : timeOffHrs;
}

/**
 * Time-off benefit hours for a day, EXCLUDING any work done that day.
 *
 * Defined as paid minus worked, so it isolates the part of the day the user
 * is paid for without clocking in:
 *   - HOLIDAY (additive): always the flat per-day benefit. Working on a
 *     holiday flows to worked, never inflating the benefit. A worked holiday
 *     and an unworked holiday both report the same flat figure.
 *   - PTO/SICK (non-additive, unworked): the type's hoursPerDay.
 *   - Any day with segments covering the full paid amount: 0.
 *
 * This is the single source of truth for the "Holiday hours" figure shared by
 * the dashboard totals, the week cards, the annual block, and the balances
 * tab, so those views cannot drift apart.
 */
export function computeHoursBenefit(entry, settings, timeOffTypes, companies) {
  return computeHoursPaid(entry, settings, timeOffTypes, companies)
    - computeHoursWorked(entry, settings, companies);
}

/**
 * Back-compat alias for computeHoursPaid. New code should prefer the
 * explicit Worked / Paid variants so the intent is obvious at the call
 * site.
 */
export function computeHours(entry, settings, timeOffTypes, companies) {
  return computeHoursPaid(entry, settings, timeOffTypes, companies);
}
