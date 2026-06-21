/**
 * src/core/coverage.js
 *
 * Bridges the pure accrual engine (core/accrual.js) to the app's pay/display
 * surfaces. One place builds the per-company pool results so the balances tab
 * and the pay calc read the SAME coverage (they cannot drift).
 *
 * Coverage rule for pay (chunk 3b): a POOL time-off day pays its normal paid
 * hours only when the engine marks that date covered. An uncovered (over-pool)
 * or pending day pays 0 while staying categorized under its type. A date the
 * engine never saw (out of its walked-cycle scope, e.g. a prior year) pays as
 * before: coverage only ever DROPS pay it explicitly judges uncovered, so
 * covered-day output is never perturbed. Worked hours, Holiday, and Unpaid are
 * untouched.
 */

import { computePoolAccrual } from './accrual.js';
import { computeHoursPaid, computeHoursBenefit } from './time.js';

/**
 * Run the accrual engine once per pool-owner group for a company. Mirrors the
 * balances-tab input assembly exactly (Option 2: current-year allotment from
 * poolDays; hire-date drives the cycle anchor and the probation guard).
 *
 * @returns {Array<{owner, sharedTypes, group, result}>} one entry per pool owner
 */
export function computeCompanyPools({ company, timeOffTypes, entries, settings, companies, asOf }) {
  const curYear = asOf.slice(0, 4);
  const hasHireDate = !!(company && company.startDate);
  const startDate = (company && company.startDate) || `${curYear}-01-01`;
  const entriesArr = Array.isArray(entries) ? entries : Object.values(entries || {});
  const types = Array.isArray(timeOffTypes) ? timeOffTypes : [];

  const pools = [];
  for (const t of types) {
    if (!t.countsAgainstPool || t.sharedPoolWith) continue; // pool owners only
    const sharedTypes = types.filter(x => x.sharedPoolWith === t.code);
    const group = [t, ...sharedTypes];
    const groupCodes = group.map(x => x.code);
    const hpd = t.hoursPerDay || 8;
    const allotmentDays = group.reduce((s, m) => s + (m.poolDays || 0), 0);

    const policy = {
      poolDays: allotmentDays,
      hoursPerDay: hpd,
      grantStyle: t.grantStyle || 'upfront',
      accrualAnchor: t.accrualAnchor || 'calendar',
      anchorDate: t.anchorDate || null,
      waitingDays: hasHireDate ? (t.waitingDays || 0) : 0,
      carryoverMode: t.carryoverMode || 'none',
      carryoverCap: t.carryoverCap || 0,
    };

    const usage = entriesArr
      .filter(e => groupCodes.includes(e.timeOff))
      .map(e => ({
        date: e.date,
        code: e.timeOff,
        // Draw the TIME-OFF portion (paid minus worked), not paid-including-
        // worked. For whole-day entries (no worked segment) benefit == paid, so
        // this is byte-identical to the prior computeHoursPaid draw. For a
        // worked half-day with an hours_override, only the override hours draw
        // the pool; the worked hours never deplete the balance.
        hours: computeHoursBenefit(e, settings, types, companies),
        status: e.status ?? null,
        bookedAt: e.bookedAt ?? null,
        createdAt: e.createdAt ?? null,
      }));

    pools.push({ owner: t, sharedTypes, group, result: computePoolAccrual({ policy, startDate, asOf, usage }) });
  }
  return pools;
}

/**
 * Reduce pool results to a date -> { covered, status, code } lookup. One pool
 * entry per date per company, so the date is a sufficient key.
 */
export function coverageFromPools(pools) {
  const map = {};
  for (const p of pools) {
    for (const o of p.result.overdraw) {
      map[o.date] = { covered: o.covered, status: o.status, code: o.code };
    }
  }
  return map;
}

/**
 * Paid hours for a day, honoring engine coverage. Identical to computeHoursPaid
 * except a POOL time-off day pays 0 when coverage explicitly marks its date
 * uncovered or pending. Dates absent from the map pay base (see file header).
 */
export function paidHoursWithCoverage(entry, settings, timeOffTypes, companies, coverage) {
  const base = computeHoursPaid(entry, settings, timeOffTypes, companies);
  if (!entry || !entry.timeOff) return base; // worked day
  const t = Array.isArray(timeOffTypes) ? timeOffTypes.find(x => x.code === entry.timeOff) : null;
  if (!t || !t.countsAgainstPool) return base; // Holiday (additive), Unpaid, unknown
  const cov = coverage && coverage[entry.date];
  if (!cov) return base;          // out of engine scope -> pay as before
  return cov.covered ? base : 0;  // covered pays base; uncovered/pending -> 0
}
