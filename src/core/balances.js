/**
 * src/core/balances.js
 *
 * Time-off pool calculations.
 *
 * Concepts:
 *   - Each time-off TYPE (PTO, Sick, Holiday, Unpaid) has:
 *       countsAgainstPool: whether it draws down a pool
 *       sharedPoolWith:    code of another type whose pool we draw from
 *       poolDays:          annual allowance in days (only on pool owners)
 *       hoursPerDay:       conversion factor (typically 8)
 *   - A "pool owner" has countsAgainstPool=true AND no sharedPoolWith.
 *   - All types that sharedPoolWith=ownerCode roll up under that owner.
 *
 * Reported separately:
 *   - taken     : hours from past-dated entries (date <= today)
 *   - scheduled : hours from future-dated entries (date > today)
 *   - remaining : pool - taken - scheduled, clamped >= 0
 */

import { computeHours, fmtDate } from './time.js';

/**
 * @param {object[]} entries  array of entry objects
 * @param {string}   code     time-off code to match
 * @param {'past'|'future'|'all'} when
 * @param {number}   hoursPerDay  fallback when entry has no segments
 * @param {object}   settings
 * @returns {number} sum of hours
 */
export function sumHoursForCode(entries, code, when, hoursPerDay, settings) {
  const today = fmtDate(new Date());
  const yr = today.slice(0, 4);
  return entries
    .filter(e => e.date.startsWith(yr) && e.timeOff === code)
    .filter(e => when === 'all'
      || (when === 'past' && e.date <= today)
      || (when === 'future' && e.date > today))
    .reduce((s, e) => s + (computeHours(e, settings) || (hoursPerDay || 8)), 0);
}

export function countDaysForCode(entries, code, when) {
  const today = fmtDate(new Date());
  const yr = today.slice(0, 4);
  return entries
    .filter(e => e.date.startsWith(yr) && e.timeOff === code)
    .filter(e => when === 'all'
      || (when === 'past' && e.date <= today)
      || (when === 'future' && e.date > today))
    .length;
}

/**
 * Build the balance summary for a pool-owning type. Includes any types that
 * share its pool.
 *
 * @returns {object} {
 *   type, sharedTypes, poolHours, taken, scheduled, remaining,
 *   pctTaken, pctScheduled
 * }
 */
export function computePoolBalance(ownerType, allTypes, entries, settings) {
  const sharedTypes = allTypes.filter(x => x.sharedPoolWith === ownerType.code);
  const breakdownTypes = [ownerType, ...sharedTypes];

  let taken = 0;
  let scheduled = 0;
  for (const t of breakdownTypes) {
    taken += sumHoursForCode(entries, t.code, 'past', t.hoursPerDay, settings);
    scheduled += sumHoursForCode(entries, t.code, 'future', t.hoursPerDay, settings);
  }

  const hpd = ownerType.hoursPerDay || 8;
  const today = fmtDate(new Date());
  const yr = today.slice(0, 4);
  const effectivePoolDays = (ownerType.poolByYear && ownerType.poolByYear[yr] != null)
    ? ownerType.poolByYear[yr]
    : (ownerType.poolDays || 0);
  const poolHours = effectivePoolDays * hpd;
  const remaining = Math.max(0, poolHours - taken - scheduled);
  const pctTaken = poolHours > 0 ? Math.min(100, (taken / poolHours) * 100) : 0;
  const pctScheduled = poolHours > 0
    ? Math.min(100 - pctTaken, (scheduled / poolHours) * 100)
    : 0;

  return {
    type: ownerType,
    sharedTypes,
    breakdownTypes,
    poolHours,
    hoursPerDay: hpd,
    taken,
    scheduled,
    remaining,
    pctTaken,
    pctScheduled,
  };
}
