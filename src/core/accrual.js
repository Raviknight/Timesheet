/**
 * src/core/accrual.js
 *
 * PTO accrual balance engine. A standalone PURE module: given a pool policy, a
 * per-person start date, an as-of date, and the usage entries, it returns the
 * cycle chain, carried-in, earned-to-date, used, available balance, and a
 * date-ordered overdraw split. It computes; it does not read or write.
 *
 * Deliberately decoupled: imports only pure date helpers from core/time.js,
 * never storage, UI, schema, or app state. Nothing calls it yet (chunk 2 is the
 * engine only); wiring comes in a later chunk.
 *
 * Semantics (see docs/LOGIC.md "PTO accrual model"):
 *   - Eligibility = startDate + waitingDays. Nothing earns before it.
 *   - Cycle anchor: 'calendar' = Jan 1; 'anniversary' = the start date's
 *     month/day; 'fiscal' = anchorDate's month/day. Cycles are walked from the
 *     cycle containing the start date through the cycle containing the as-of
 *     date, chaining carry-over at every boundary.
 *   - Grant style 'upfront': the full allotment lands at cycle start, prorated
 *     for the first eligible cycle to the span remaining from the eligibility
 *     date. 'accrued': the allotment is earned linearly across the cycle from
 *     eligibility (so a mid-cycle eligibility prorates naturally).
 *   - Carry-over at each boundary: prior cycle leftover (clamped at 0) carried
 *     per mode: 'none' = 0, 'cap' = min(leftover, cap), 'unlimited' = leftover.
 *     The cap limits only the carried amount; it stacks on top of the next
 *     allotment, so cap-plus-carry can exceed the cap.
 *   - Overdraw: usage consumes available in date order; once available is
 *     exhausted, further pool days are unpaid (over balance) but stay
 *     categorized under their type.
 *   - Shared pool: types linked by sharedPoolWith form one combined pool. Use
 *     mergeSharedPolicy() to sum allotments, then pass the combined usage.
 *
 * All hours/days are plain numbers. Dates are 'YYYY-MM-DD' strings. Days carry
 * carryoverCap and waitingDays in days; cap is converted to hours internally.
 */

import { parseDate, fmtDate, addDays } from './time.js';

/** Whole days from a to b (b - a), DST-safe via round. */
function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}

/** Clamp a date string into the inclusive-low, exclusive-high window [lo, hi]. */
function clampDate(d, lo, hi) {
  if (daysBetween(lo, d) < 0) return lo;
  if (daysBetween(d, hi) < 0) return hi;
  return d;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/**
 * Resolve the anchor month/day (1-based month, day) for the policy.
 *   calendar    -> Jan 1
 *   anniversary -> the start date's month/day
 *   fiscal      -> anchorDate's month/day (falls back to calendar if absent)
 */
function anchorMonthDay(anchor, startDate, anchorDate) {
  if (anchor === 'anniversary') {
    const d = parseDate(startDate);
    return [d.getMonth() + 1, d.getDate()];
  }
  if (anchor === 'fiscal' && anchorDate) {
    const d = parseDate(anchorDate);
    return [d.getMonth() + 1, d.getDate()];
  }
  return [1, 1]; // calendar (and fiscal with no anchorDate)
}

/** The cycle start on or before `date` for the given anchor month/day. */
function cycleStartOnOrBefore(date, am, ad) {
  const dt = parseDate(date);
  let cand = new Date(dt.getFullYear(), am - 1, ad);
  if (cand > dt) cand = new Date(dt.getFullYear() - 1, am - 1, ad);
  return fmtDate(cand);
}

/** The next cycle start after a given cycle start (one year on). */
function nextCycleStart(startStr, am, ad) {
  const dt = parseDate(startStr);
  return fmtDate(new Date(dt.getFullYear() + 1, am - 1, ad));
}

/**
 * Merge a pool owner with the types that share its pool into one combined
 * policy: allotment days are summed; accrual config and hoursPerDay come from
 * the owner. Usage across the member codes is the caller's concern (concat the
 * entries), since codes carry through untouched.
 *
 * @param {object}   owner          the pool-owning type
 * @param {object[]} [sharedTypes]  types whose sharedPoolWith === owner.code
 * @returns {object} combined policy
 */
export function mergeSharedPolicy(owner, sharedTypes = []) {
  const poolDays = (owner.poolDays || 0)
    + sharedTypes.reduce((s, t) => s + (t.poolDays || 0), 0);
  return {
    code: owner.code,
    poolDays,
    hoursPerDay: owner.hoursPerDay || 8,
    grantStyle: owner.grantStyle ?? null,
    accrualAnchor: owner.accrualAnchor ?? null,
    anchorDate: owner.anchorDate ?? null,
    waitingDays: owner.waitingDays ?? null,
    carryoverMode: owner.carryoverMode ?? null,
    carryoverCap: owner.carryoverCap ?? null,
    memberCodes: [owner.code, ...sharedTypes.map(t => t.code)],
  };
}

/**
 * Compute the accrual state for one pool.
 *
 * @param {object} opts
 * @param {object} opts.policy      pool policy. Fields:
 *   poolDays        number  combined allotment in days
 *   hoursPerDay     number  hours per day (default 8)
 *   grantStyle      'upfront' | 'accrued'   (default 'accrued')
 *   accrualAnchor   'calendar' | 'anniversary' | 'fiscal'  (default 'calendar')
 *   anchorDate      'YYYY-MM-DD'  required for 'fiscal'
 *   waitingDays     number  probation days before eligibility (default 0)
 *   carryoverMode   'none' | 'cap' | 'unlimited'  (default 'none')
 *   carryoverCap    number  cap in DAYS, used when mode is 'cap'
 * @param {string}   opts.startDate per-person start date 'YYYY-MM-DD'
 * @param {string}   opts.asOf      as-of date 'YYYY-MM-DD'
 * @param {object[]} [opts.usage]   usage entries: { date, hours, code? }.
 *                                  Only entries on or before asOf are counted.
 *
 * @returns {{
 *   eligibilityDate: string,
 *   hoursPerDay: number,
 *   allotmentDays: number,
 *   allotmentHours: number,
 *   cycles: Array<{
 *     index: number, start: string, end: string,
 *     carriedInHours: number, fullEarnedHours: number,
 *     usedPaidHours: number, endBalanceHours: number, carriedOutHours: number,
 *     isCurrent: boolean
 *   }>,
 *   carriedInHours: number,
 *   earnedHours: number,
 *   earnedFractionalDays: number,
 *   earnedWholeDays: number,
 *   usedHours: number,
 *   availableHours: number,
 *   availableDays: number,
 *   overdraw: Array<{ date: string, code: (string|null), hours: number,
 *                     paidHours: number, unpaidHours: number }>,
 *   totalPaidHours: number,
 *   totalUnpaidHours: number
 * }}
 */
export function computePoolAccrual({ policy, startDate, asOf, usage = [] }) {
  const hoursPerDay = policy.hoursPerDay || 8;
  const allotmentDays = policy.poolDays || 0;
  const allotmentHours = allotmentDays * hoursPerDay;
  const grantStyle = policy.grantStyle || 'accrued';
  const anchor = policy.accrualAnchor || 'calendar';
  const waitingDays = policy.waitingDays || 0;
  const mode = policy.carryoverMode || 'none';
  const capHours = (policy.carryoverCap || 0) * hoursPerDay;

  const eligibilityDate = addDays(startDate, waitingDays);
  const [am, ad] = anchorMonthDay(anchor, startDate, policy.anchorDate);

  // Walk cycle boundaries from the cycle containing startDate through the cycle
  // containing asOf.
  const firstStart = cycleStartOnOrBefore(startDate, am, ad);
  const lastStart = cycleStartOnOrBefore(asOf, am, ad);
  const bounds = [];
  let s = firstStart;
  // Guard: lastStart is always >= firstStart since asOf >= startDate in use,
  // but clamp to firstStart if a caller passes asOf before startDate.
  if (daysBetween(firstStart, lastStart) < 0) {
    bounds.push({ start: firstStart, end: nextCycleStart(firstStart, am, ad) });
  } else {
    while (daysBetween(s, lastStart) >= 0) {
      const e = nextCycleStart(s, am, ad);
      bounds.push({ start: s, end: e });
      s = e;
    }
  }

  // Usage sorted by date, restricted to on-or-before asOf.
  const sortedUsage = usage
    .filter(u => daysBetween(u.date, asOf) >= 0)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const overdraw = [];
  const cycles = [];
  let carriedIn = 0;

  for (let i = 0; i < bounds.length; i++) {
    const { start, end } = bounds[i];
    const isCurrent = i === bounds.length - 1;
    const cycleLen = daysBetween(start, end);

    // Earning for this cycle. eligibleThisCycle: eligibility reached by cycle
    // end. earningStart: when hours begin to earn within the cycle.
    const eligibleThisCycle = daysBetween(eligibilityDate, end) > 0;
    const earningStart = daysBetween(start, eligibilityDate) > 0 ? eligibilityDate : start;

    // fullEarned: hours earned by the cycle's end. For upfront this is the
    // (possibly prorated) grant; for accrued it is the linear total over the
    // earning span. earnedByDate(d): hours earned as of date d within the cycle.
    let fullEarned = 0;
    let earnedByDate = () => 0;
    if (eligibleThisCycle && allotmentHours > 0 && cycleLen > 0) {
      const earnSpan = daysBetween(earningStart, end); // <= cycleLen
      if (grantStyle === 'upfront') {
        fullEarned = allotmentHours * (earnSpan / cycleLen);
        earnedByDate = (d) => (daysBetween(earningStart, d) >= 0 ? fullEarned : 0);
      } else {
        fullEarned = allotmentHours * (earnSpan / cycleLen);
        earnedByDate = (d) => {
          const elapsed = daysBetween(earningStart, clampDate(d, start, end));
          return clamp(allotmentHours * (elapsed / cycleLen), 0, fullEarned);
        };
      }
    }

    // Consume this cycle's usage in date order against carriedIn + earnedByDate.
    const cycleUsage = sortedUsage.filter(
      u => daysBetween(start, u.date) >= 0 && daysBetween(u.date, end) > 0
    );
    let usedPaid = 0;
    for (const u of cycleUsage) {
      const hours = u.hours || 0;
      const availableAt = Math.max(0, carriedIn + earnedByDate(u.date) - usedPaid);
      const paid = Math.min(hours, availableAt);
      const unpaid = hours - paid;
      usedPaid += paid;
      overdraw.push({
        date: u.date,
        code: u.code ?? null,
        hours,
        paidHours: paid,
        unpaidHours: unpaid,
      });
    }

    let endBalance;
    let carriedOut;
    let earnedHere;
    if (isCurrent) {
      // Report the current cycle as-of asOf, not as of cycle end.
      earnedHere = earnedByDate(asOf);
      endBalance = Math.max(0, carriedIn + earnedHere - usedPaid);
      carriedOut = 0; // the current cycle has not closed; nothing carries yet
    } else {
      earnedHere = fullEarned;
      endBalance = Math.max(0, carriedIn + fullEarned - usedPaid);
      carriedOut = mode === 'none' ? 0
        : mode === 'cap' ? Math.min(endBalance, capHours)
        : endBalance; // unlimited
    }

    cycles.push({
      index: i,
      start,
      end,
      carriedInHours: carriedIn,
      fullEarnedHours: isCurrent ? earnedHere : fullEarned,
      usedPaidHours: usedPaid,
      endBalanceHours: endBalance,
      carriedOutHours: carriedOut,
      isCurrent,
    });

    if (!isCurrent) carriedIn = carriedOut;
  }

  const current = cycles[cycles.length - 1];
  const earnedHours = current.fullEarnedHours;
  const earnedFractionalDays = hoursPerDay > 0 ? earnedHours / hoursPerDay : 0;
  const earnedWholeDays = Math.floor(earnedFractionalDays + 1e-9);
  const usedHours = current.usedPaidHours;
  const availableHours = Math.max(0, current.carriedInHours + earnedHours - usedHours);

  const totalPaidHours = overdraw.reduce((s2, o) => s2 + o.paidHours, 0);
  const totalUnpaidHours = overdraw.reduce((s2, o) => s2 + o.unpaidHours, 0);

  return {
    eligibilityDate,
    hoursPerDay,
    allotmentDays,
    allotmentHours,
    cycles,
    carriedInHours: current.carriedInHours,
    earnedHours,
    earnedFractionalDays,
    earnedWholeDays,
    usedHours,
    availableHours,
    availableDays: hoursPerDay > 0 ? availableHours / hoursPerDay : 0,
    overdraw,
    totalPaidHours,
    totalUnpaidHours,
  };
}
