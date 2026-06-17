/**
 * src/core/accrual.js
 *
 * PTO accrual balance engine. A standalone PURE module: given a pool policy, a
 * per-person start date, an as-of date, and the usage entries, it returns the
 * cycle chain, carried-in, earned-to-date, reserved/used, available balance,
 * and a reservation-order coverage split. It computes; it does not read or
 * write.
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
 *   - Reservation model: time off reserves the pool in BOOKING order, not date
 *     order. Booking order is bookedAt, then createdAt, then the time-off date
 *     for legacy rows; ties broken by date, then a stable input index. A
 *     booking is covered (and paid when its day occurs) only if the pool still
 *     had room at its position in booking order; once the pool is reserved out,
 *     later bookings are unpaid even if their date is sooner. Approved future
 *     days reserve the pool now, so available reflects them.
 *   - Status: null is treated as approved (legacy). Only approved days reserve
 *     and are pay-eligible. Pending days are returned but never reserve or pay.
 *     Denied and cancelled days are excluded entirely.
 *   - Payment timing stays separate from reservation: each booking carries its
 *     date, covered flag, and reserved hours, so the pay calc pays covered days
 *     in the period their date falls and zero for uncovered ones. Earned-to-
 *     date for the current cycle still uses the as-of date.
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
 * @param {object[]} [opts.usage]   usage entries:
 *   { date, hours, code?, status?, bookedAt?, createdAt? }.
 *   status null = approved. Future-dated approved days are included (they
 *   reserve the pool now). Days dated beyond the current cycle are out of scope.
 *
 * @returns {{
 *   eligibilityDate: string,
 *   hoursPerDay: number,
 *   allotmentDays: number,
 *   allotmentHours: number,
 *   cycles: Array<{
 *     index: number, start: string, end: string,
 *     carriedInHours: number, fullEarnedHours: number,
 *     poolCapacityHours: number,     // carriedIn + earnedHere (what the loop draws against)
 *     reservedHours: number,         // pastReserved + futureReserved
 *     pastReservedHours: number,     // reserved by bookings dated <= asOf
 *     futureReservedHours: number,   // reserved by bookings dated > asOf
 *     unpaidHours: number,           // approved hours over pool this cycle (not occurrence-gated)
 *     usedPaidHours: number,
 *     endBalanceHours: number, carriedOutHours: number, isCurrent: boolean
 *   }>,
 *   carriedInHours: number,
 *   earnedHours: number,
 *   earnedFractionalDays: number,
 *   earnedWholeDays: number,
 *   usedHours: number,        // reserved in the current cycle (incl future-dated covered)
 *   availableHours: number,
 *   availableDays: number,
 *   overdraw: Array<{ date: string, code: (string|null), status: string,
 *                     bookedAt: (string|null), hours: number,
 *                     reservedHours: number, covered: boolean, occurred: boolean,
 *                     paidHours: number, unpaidHours: number }>,
 *   totalReservedHours: number,
 *   totalPaidHours: number,
 *   totalUnpaidHours: number,
 *   currentCycle: object|null,         // the isCurrent cycle, or null when asOf precedes startDate
 *   currentCyclePoolHours: number,     // capacity available against the pool as of asOf
 *   currentCycleUsedHours: number,     // pastReservedHours of the current cycle
 *   currentCycleReservedHours: number, // futureReservedHours of the current cycle
 *   currentCycleAvailableHours: number,// max(0, pool - used - reserved)
 *   currentCycleUnpaidHours: number,   // over-pool hours this cycle
 *   currentCycleEarnedHours: number,   // earnedHere of the current cycle (earnedByDate(asOf))
 *   currentCycleCarriedInHours: number // carried into the current cycle
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

  // Classify usage. Status null is legacy = approved. Denied/cancelled are
  // dropped entirely; pending is kept for display but never reserves or pays.
  // Each entry keeps its input index as the ultimate stable tiebreaker, and a
  // `reserved` field filled in during the per-cycle pass.
  const considered = usage.map((u, i) => ({
    src: u,
    idx: i,
    date: u.date,
    code: u.code ?? null,
    hours: u.hours || 0,
    bookedAt: u.bookedAt ?? null,
    status: u.status == null ? 'approved' : u.status,
    reserved: 0,
  })).filter(u => u.status === 'approved' || u.status === 'pending');

  // Reservation order: bookedAt, then createdAt, then the time-off date for
  // legacy rows; ties broken by date, then input index. ISO-8601 strings sort
  // chronologically under plain string comparison, so legacy rows (key = date)
  // reproduce date order, keeping the pre-reservation cases intact.
  const bookingKey = u => u.bookedAt ?? u.src.createdAt ?? u.date;
  const byBooking = (a, b) => {
    const ka = bookingKey(a), kb = bookingKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.idx - b.idx;
  };

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

    // The pool for THIS cycle. The current cycle reserves against earned-to-
    // date (asOf); a closed cycle reserves against its full earned. Carry-in
    // stacks on top either way.
    const earnedHere = isCurrent ? earnedByDate(asOf) : fullEarned;
    const capacity = carriedIn + earnedHere;

    // Approved bookings whose DATE falls in this cycle, reserved in booking
    // order against the pool. The current cycle includes future-dated days
    // (date < end): they consume the pool now.
    const cycleApproved = considered
      .filter(u => u.status === 'approved'
        && daysBetween(start, u.date) >= 0 && daysBetween(u.date, end) > 0)
      .sort(byBooking);

    let reserved = 0;
    let pastReserved = 0;   // reserved by bookings dated on/before asOf (occurred)
    let futureReserved = 0; // reserved by bookings dated after asOf (future-booked)
    let cycleUnpaid = 0;    // approved hours this cycle that found no room (over pool)
    for (const u of cycleApproved) {
      const room = Math.max(0, capacity - reserved);
      const resv = Math.min(u.hours, room);
      reserved += resv;
      u.reserved = resv;
      // Split reserved hours by whether the booking's date has occurred as of
      // asOf (date <= asOf, same convention as `occurred` below). The over-pool
      // remainder accrues to the cycle's unpaid figure regardless of occurrence,
      // so it reads as "over pool now", not "over pool once the day arrives".
      if (daysBetween(u.date, asOf) >= 0) pastReserved += resv;
      else futureReserved += resv;
      cycleUnpaid += u.hours - resv;
    }

    const endBalance = Math.max(0, capacity - reserved);
    const carriedOut = isCurrent ? 0 // the current cycle has not closed yet
      : mode === 'none' ? 0
      : mode === 'cap' ? Math.min(endBalance, capHours)
      : endBalance; // unlimited

    cycles.push({
      index: i,
      start,
      end,
      carriedInHours: carriedIn,
      fullEarnedHours: earnedHere,
      poolCapacityHours: capacity, // carriedIn + earnedHere: what the loop draws against
      reservedHours: reserved,
      pastReservedHours: pastReserved,
      futureReservedHours: futureReserved,
      unpaidHours: cycleUnpaid,
      usedPaidHours: reserved, // back-compat alias
      endBalanceHours: endBalance,
      carriedOutHours: carriedOut,
      isCurrent,
    });

    if (!isCurrent) carriedIn = carriedOut;
  }

  const currentEnd = bounds[bounds.length - 1].end;

  // One output record per considered booking (approved + pending) that falls
  // within the walked cycles, in booking order. Bookings dated beyond the
  // current cycle draw a future cycle's pool and are out of scope here.
  const overdraw = considered
    .filter(u => daysBetween(firstStart, u.date) >= 0 && daysBetween(u.date, currentEnd) > 0)
    .sort(byBooking)
    .map(u => {
      const reservedHours = u.status === 'approved' ? u.reserved : 0;
      const occurred = daysBetween(u.date, asOf) >= 0; // date <= asOf
      const covered = u.status === 'approved' && u.hours > 0 && reservedHours >= u.hours - 1e-9;
      const overflow = u.status === 'approved' ? (u.hours - reservedHours) : 0;
      return {
        date: u.date,
        code: u.code,
        status: u.status,
        bookedAt: u.bookedAt,
        hours: u.hours,
        reservedHours,
        covered,
        occurred,
        // Payment timing: covered hours pay only once the day has occurred.
        paidHours: occurred ? reservedHours : 0,
        // Overflow (approved, over balance) is unpaid once the day occurs.
        unpaidHours: occurred ? overflow : 0,
      };
    });

  const current = cycles[cycles.length - 1];
  const earnedHours = current.fullEarnedHours;
  const earnedFractionalDays = hoursPerDay > 0 ? earnedHours / hoursPerDay : 0;
  const earnedWholeDays = Math.floor(earnedFractionalDays + 1e-9);
  // Reserved in the current cycle, including future-dated covered days, which
  // is what reduces the balance available now.
  const usedHours = current.reservedHours;
  const availableHours = Math.max(0, current.carriedInHours + earnedHours - usedHours);

  const totalReservedHours = overdraw.reduce((s2, o) => s2 + o.reservedHours, 0);
  const totalPaidHours = overdraw.reduce((s2, o) => s2 + o.paidHours, 0);
  const totalUnpaidHours = overdraw.reduce((s2, o) => s2 + o.unpaidHours, 0);

  // Current-cycle scoped view for the balance card. When asOf precedes the
  // start date (not yet hired), there is no meaningful current cycle: expose
  // null and zeroed convenience fields rather than the clamped first cycle.
  const currentCycle = daysBetween(startDate, asOf) >= 0
    ? (cycles.find(c => c.isCurrent) || null)
    : null;
  const currentCyclePoolHours = currentCycle ? currentCycle.poolCapacityHours : 0;
  const currentCycleUsedHours = currentCycle ? currentCycle.pastReservedHours : 0;
  const currentCycleReservedHours = currentCycle ? currentCycle.futureReservedHours : 0;
  const currentCycleAvailableHours = Math.max(
    0, currentCyclePoolHours - currentCycleUsedHours - currentCycleReservedHours);
  const currentCycleUnpaidHours = currentCycle ? currentCycle.unpaidHours : 0;
  const currentCycleEarnedHours = currentCycle ? currentCycle.fullEarnedHours : 0;
  const currentCycleCarriedInHours = currentCycle ? currentCycle.carriedInHours : 0;

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
    totalReservedHours,
    totalPaidHours,
    totalUnpaidHours,
    currentCycle,
    currentCyclePoolHours,
    currentCycleUsedHours,
    currentCycleReservedHours,
    currentCycleAvailableHours,
    currentCycleUnpaidHours,
    currentCycleEarnedHours,
    currentCycleCarriedInHours,
  };
}
