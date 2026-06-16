/**
 * scripts/test-accrual.mjs
 *
 * Hard harness for the PTO accrual engine (src/core/accrual.js). Benefit money,
 * so each semantic is proven independently and in combination:
 *   - grant style: upfront vs accrued
 *   - the three anchors: calendar / anniversary / fiscal (boundaries)
 *   - mid-cycle proration of the first eligible cycle
 *   - waiting / probation period
 *   - carry-over none / cap / unlimited, including the cap-plus-carry stack
 *   - multi-cycle chaining
 *   - overdraw paid vs unpaid-over-balance split, in date order
 *   - a shared pool across two types
 *
 * Run with: node scripts/test-accrual.mjs
 */

import { computePoolAccrual, mergeSharedPolicy } from '../src/core/accrual.js';

let pass = 0, fail = 0;
function approx(name, got, want, tol = 1e-2) {
  const ok = Math.abs(got - want) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${round(got)}, want ${round(want)})`);
  ok ? pass++ : fail++;
}
function eq(name, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`);
  ok ? pass++ : fail++;
}
const round = n => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);

// ---------------------------------------------------------------------------
// 1. Grant style: upfront vs accrued (calendar, start of year).
// ---------------------------------------------------------------------------
console.log('\n== 1. upfront vs accrued ==');
const accrued10 = computePoolAccrual({
  policy: { poolDays: 10, hoursPerDay: 8, grantStyle: 'accrued', accrualAnchor: 'calendar' },
  startDate: '2026-01-01', asOf: '2026-02-06',
});
// 36 days into a 365-day year: 10 * 36/365 = 0.986 days. Worked example: ~1 day.
approx('accrued 10d @ 1.2 months earns ~1 day (fractional)', accrued10.earnedFractionalDays, 0.986, 5e-3);
eq('accrued whole-day floor is 0', accrued10.earnedWholeDays, 0);

const upfront10 = computePoolAccrual({
  policy: { poolDays: 10, hoursPerDay: 8, grantStyle: 'upfront', accrualAnchor: 'calendar' },
  startDate: '2026-01-01', asOf: '2026-02-06',
});
approx('upfront 10d grants full 10 days at cycle start', upfront10.earnedFractionalDays, 10);
approx('upfront 10d available = 80h', upfront10.availableHours, 80);

// ---------------------------------------------------------------------------
// 2. The three anchors: cycle boundaries.
// ---------------------------------------------------------------------------
console.log('\n== 2. anchors ==');
const cal = computePoolAccrual({
  policy: { poolDays: 10, accrualAnchor: 'calendar' },
  startDate: '2026-03-10', asOf: '2026-06-01',
});
eq('calendar cycle start', cal.cycles[0].start, '2026-01-01');
eq('calendar cycle end', cal.cycles[0].end, '2027-01-01');

const anniv = computePoolAccrual({
  policy: { poolDays: 10, accrualAnchor: 'anniversary' },
  startDate: '2026-03-10', asOf: '2026-06-01',
});
eq('anniversary cycle start', anniv.cycles[0].start, '2026-03-10');
eq('anniversary cycle end', anniv.cycles[0].end, '2027-03-10');

const fiscal = computePoolAccrual({
  policy: { poolDays: 10, accrualAnchor: 'fiscal', anchorDate: '2020-07-01' },
  startDate: '2025-08-01', asOf: '2026-06-01',
});
eq('fiscal cycle start (Jul 1)', fiscal.cycles[0].start, '2025-07-01');
eq('fiscal cycle end', fiscal.cycles[0].end, '2026-07-01');

// ---------------------------------------------------------------------------
// 3. Mid-cycle proration: hired mid-May, upfront calendar.
// ---------------------------------------------------------------------------
console.log('\n== 3. mid-cycle proration ==');
const midMay = computePoolAccrual({
  policy: { poolDays: 10, hoursPerDay: 8, grantStyle: 'upfront', accrualAnchor: 'calendar' },
  startDate: '2026-05-15', asOf: '2026-12-31',
});
// 231 days remaining of 365: 10 * 231/365 = 6.33 days. Worked example: ~6.
approx('upfront first cycle prorates to ~6.33 days', midMay.earnedFractionalDays, 6.329, 5e-3);
eq('whole-day floor is 6', midMay.earnedWholeDays, 6);

// ---------------------------------------------------------------------------
// 4. Waiting period: nothing earns before eligibility.
// ---------------------------------------------------------------------------
console.log('\n== 4. waiting period ==');
const waiting = computePoolAccrual({
  policy: { poolDays: 12, hoursPerDay: 8, grantStyle: 'accrued', accrualAnchor: 'calendar', waitingDays: 90 },
  startDate: '2026-01-01', asOf: '2026-02-01',
  usage: [{ date: '2026-01-15', hours: 8, code: 'PTO' }],
});
eq('eligibility = start + 90 days', waiting.eligibilityDate, '2026-04-01');
approx('nothing earned before eligibility', waiting.earnedHours, 0);
approx('use before eligibility is fully unpaid', waiting.overdraw[0].unpaidHours, 8);
approx('use before eligibility pays 0', waiting.overdraw[0].paidHours, 0);

// ---------------------------------------------------------------------------
// 5. Carry-over none / cap / unlimited, with the cap-plus-carry stack.
//    Upfront 10d, full unused 2025 cycle, current cycle 2026.
// ---------------------------------------------------------------------------
console.log('\n== 5. carry-over modes ==');
const base5 = { poolDays: 10, hoursPerDay: 8, grantStyle: 'upfront', accrualAnchor: 'calendar' };
const carryNone = computePoolAccrual({ policy: { ...base5, carryoverMode: 'none' }, startDate: '2025-01-01', asOf: '2026-06-01' });
const carryCap = computePoolAccrual({ policy: { ...base5, carryoverMode: 'cap', carryoverCap: 5 }, startDate: '2025-01-01', asOf: '2026-06-01' });
const carryUnl = computePoolAccrual({ policy: { ...base5, carryoverMode: 'unlimited' }, startDate: '2025-01-01', asOf: '2026-06-01' });
approx('none: carries 0 into 2026', carryNone.carriedInHours, 0);
approx('none: available = fresh 10d only', carryNone.availableHours, 80);
approx('cap 5d: carries 40h (5 days)', carryCap.carriedInHours, 40);
approx('cap 5d: available = 5 carried + 10 new = 15d (120h)', carryCap.availableHours, 120);
approx('unlimited: carries full 80h', carryUnl.carriedInHours, 80);
approx('unlimited: available = 10 + 10 = 20d (160h)', carryUnl.availableHours, 160);
// Cap-plus-carry stack: total available (15d) exceeds the cap (5d).
eq('cap+carry stack exceeds the cap', carryCap.availableHours > carryCap.cycles[1]?.carriedInHours + 0, true);

// ---------------------------------------------------------------------------
// 6. Multi-cycle chaining: accrued, unlimited carry, three cycles (incl leap).
// ---------------------------------------------------------------------------
console.log('\n== 6. multi-cycle chaining ==');
const chain = computePoolAccrual({
  policy: { poolDays: 10, hoursPerDay: 8, grantStyle: 'accrued', accrualAnchor: 'calendar', carryoverMode: 'unlimited' },
  startDate: '2024-01-01', asOf: '2026-06-01',
});
eq('three cycles walked', chain.cycles.length, 3);
approx('2024 full year accrues 80h, carries out 80h', chain.cycles[0].carriedOutHours, 80);
approx('2025 carries out 160h', chain.cycles[1].carriedOutHours, 160);
approx('2026 carries in 160h', chain.carriedInHours, 160);
// 151 days into 2026: 80 * 151/365 = 33.10h earned to date. available = 160 + 33.10.
approx('2026 earned-to-date ~33.10h', chain.earnedHours, 33.096, 5e-2);
approx('available = 193.10h', chain.availableHours, 193.096, 5e-2);

// ---------------------------------------------------------------------------
// 7. Overdraw: date-ordered paid vs unpaid split.
//    Upfront 5d (40h); six 8h days; the sixth overdraws.
// ---------------------------------------------------------------------------
console.log('\n== 7. overdraw split ==');
const overdrawUsage = ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06']
  .map(d => ({ date: d, hours: 8, code: 'PTO' }));
const overdraw = computePoolAccrual({
  policy: { poolDays: 5, hoursPerDay: 8, grantStyle: 'upfront', accrualAnchor: 'calendar' },
  startDate: '2026-01-01', asOf: '2026-12-31', usage: overdrawUsage,
});
eq('six usage days recorded', overdraw.overdraw.length, 6);
approx('first five days fully paid (40h)', overdraw.totalPaidHours, 40);
approx('sixth day unpaid over balance (8h)', overdraw.totalUnpaidHours, 8);
approx('day 5 fully paid', overdraw.overdraw[4].paidHours, 8);
approx('day 6 fully unpaid', overdraw.overdraw[5].unpaidHours, 8);
approx('balance exhausted', overdraw.availableHours, 0);

// ---------------------------------------------------------------------------
// 8. Shared pool across two types: PTO (8d) + Sick (4d) = one 12d pool.
// ---------------------------------------------------------------------------
console.log('\n== 8. shared pool ==');
const owner = { code: 'PTO', poolDays: 8, hoursPerDay: 8, grantStyle: 'upfront', accrualAnchor: 'calendar' };
const shared = [{ code: 'SICK', poolDays: 4 }];
const merged = mergeSharedPolicy(owner, shared);
eq('combined allotment is 12 days', merged.poolDays, 12);
const sharedUsage = [
  ...['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05',
      '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']
    .map(d => ({ date: d, hours: 8, code: 'PTO' })),   // 80h PTO
  ...['2026-04-01', '2026-04-02', '2026-04-03'].map(d => ({ date: d, hours: 8, code: 'SICK' })), // 24h Sick
];
const sharedPool = computePoolAccrual({ policy: merged, startDate: '2026-01-01', asOf: '2026-12-31', usage: sharedUsage });
approx('shared allotment = 96h', sharedPool.allotmentHours, 96);
approx('shared pool pays 96h across both types', sharedPool.totalPaidHours, 96);
approx('shared pool overdraws 8h (104 used - 96 pool)', sharedPool.totalUnpaidHours, 8);

// ---------------------------------------------------------------------------
// 9. Reservation: book-future-then-urgent. A 10-day vacation booked early but
//    dated far out is covered; a nearer-dated urgent day booked later overflows
//    and is unpaid; available reflects the vacation reservation now.
// ---------------------------------------------------------------------------
console.log('\n== 9. reservation: book-future-then-urgent ==');
const resvPolicy = { poolDays: 10, hoursPerDay: 8, grantStyle: 'upfront', accrualAnchor: 'calendar' };
const resvUsage = [
  // 10-day vacation (80h) booked Mar 1, dated Sep 1 (far future).
  { date: '2026-09-01', hours: 80, code: 'PTO', status: 'approved', bookedAt: '2026-03-01T09:00:00Z' },
  // 1 urgent day (8h) booked later (May 1), dated sooner (Jun 15), overflows.
  { date: '2026-06-15', hours: 8, code: 'PTO', status: 'approved', bookedAt: '2026-05-01T09:00:00Z' },
];
const before = computePoolAccrual({ policy: resvPolicy, startDate: '2026-01-01', asOf: '2026-06-01', usage: resvUsage });
const vac = before.overdraw.find(o => o.date === '2026-09-01');
const urg = before.overdraw.find(o => o.date === '2026-06-15');
eq('vacation (earlier booking) is covered', vac.covered, true);
approx('vacation reserves the full 80h', vac.reservedHours, 80);
eq('urgent (later booking) is NOT covered', urg.covered, false);
approx('urgent reserves 0h (pool already reserved out)', urg.reservedHours, 0);
approx('available reflects the vacation reservation (0h left)', before.availableHours, 0);
approx('reserved-now total = 80h', before.totalReservedHours, 80);
eq('covered vacation has not occurred yet', vac.occurred, false);
approx('nothing paid to date (covered day is future)', before.totalPaidHours, 0);

// Same bookings, later as-of: both dates have arrived; pay timing turns on.
const after = computePoolAccrual({ policy: resvPolicy, startDate: '2026-01-01', asOf: '2026-10-01', usage: resvUsage });
const vac2 = after.overdraw.find(o => o.date === '2026-09-01');
const urg2 = after.overdraw.find(o => o.date === '2026-06-15');
eq('vacation now occurred', vac2.occurred, true);
approx('vacation now paid 80h', vac2.paidHours, 80);
approx('urgent now unpaid 8h (overflow)', urg2.unpaidHours, 8);
approx('available still 0h after both occur', after.availableHours, 0);

// ---------------------------------------------------------------------------
// 10. Pending shows but does not reserve or pay. Denied/cancelled vanish.
// ---------------------------------------------------------------------------
console.log('\n== 10. pending shows but does not reserve ==');
const pendUsage = [
  { date: '2026-03-01', hours: 8, code: 'PTO', status: 'approved', bookedAt: '2026-02-01T09:00:00Z' },
  { date: '2026-04-01', hours: 8, code: 'PTO', status: 'pending',  bookedAt: '2026-02-15T09:00:00Z' },
];
const pend = computePoolAccrual({ policy: resvPolicy, startDate: '2026-01-01', asOf: '2026-06-01', usage: pendUsage });
const pday = pend.overdraw.find(o => o.date === '2026-04-01');
eq('pending day is present in output', !!pday, true);
eq('pending day status is pending', pday.status, 'pending');
approx('pending day reserves 0h', pday.reservedHours, 0);
approx('pending day pays 0h', pday.paidHours, 0);
approx('only the approved day reserves (8h)', pend.usedHours, 8);
approx('available = 80 - 8 = 72h (pending did not reduce it)', pend.availableHours, 72);
const dz = computePoolAccrual({ policy: resvPolicy, startDate: '2026-01-01', asOf: '2026-06-01', usage: [
  { date: '2026-03-01', hours: 8, status: 'denied' },
  { date: '2026-03-02', hours: 8, status: 'cancelled' },
]});
eq('denied/cancelled excluded from output', dz.overdraw.length, 0);
approx('denied/cancelled reserve nothing', dz.usedHours, 0);

// ---------------------------------------------------------------------------
// 11. Legacy rows: null status = approved, ordered by createdAt then date.
//     A pool of 1 day. The May-dated row was created first, so it wins coverage
//     over the Apr-dated row created later, even though April's date is sooner.
// ---------------------------------------------------------------------------
console.log('\n== 11. legacy rows: null status, createdAt-then-date order ==');
const legacyPool = { poolDays: 1, hoursPerDay: 8, grantStyle: 'upfront', accrualAnchor: 'calendar' };
const legacyUsage = [
  { date: '2026-04-01', hours: 8, code: 'PTO', createdAt: '2026-01-10T00:00:00Z' }, // sooner date, later created
  { date: '2026-05-01', hours: 8, code: 'PTO', createdAt: '2026-01-05T00:00:00Z' }, // later date, earlier created
];
const legacy = computePoolAccrual({ policy: legacyPool, startDate: '2026-01-01', asOf: '2026-06-01', usage: legacyUsage });
const apr = legacy.overdraw.find(o => o.date === '2026-04-01');
const may = legacy.overdraw.find(o => o.date === '2026-05-01');
eq('legacy null status treated as approved', may.status, 'approved');
eq('earlier createdAt (May-dated) is covered', may.covered, true);
eq('later createdAt (Apr-dated) uncovered despite sooner date', apr.covered, false);
approx('approved legacy rows reserve the pool (8h)', legacy.usedHours, 8);
// Both createdAt null -> key falls back to the time-off date.
const dateFallback = computePoolAccrual({ policy: legacyPool, startDate: '2026-01-01', asOf: '2026-06-01', usage: [
  { date: '2026-05-01', hours: 8, code: 'PTO' },
  { date: '2026-04-01', hours: 8, code: 'PTO' },
]});
eq('all-null falls back to date order: Apr covered', dateFallback.overdraw.find(o => o.date === '2026-04-01').covered, true);
eq('all-null falls back to date order: May uncovered', dateFallback.overdraw.find(o => o.date === '2026-05-01').covered, false);

// ---------------------------------------------------------------------------
// 12. A covered future day reserves now but is not paid until its date arrives.
// ---------------------------------------------------------------------------
console.log('\n== 12. covered future day pays only when its date arrives ==');
const futUsage = [{ date: '2026-08-01', hours: 16, code: 'PTO', status: 'approved', bookedAt: '2026-02-01T09:00:00Z' }];
const futBefore = computePoolAccrual({ policy: resvPolicy, startDate: '2026-01-01', asOf: '2026-06-01', usage: futUsage });
const futAfter = computePoolAccrual({ policy: resvPolicy, startDate: '2026-01-01', asOf: '2026-09-01', usage: futUsage });
eq('future day covered (reserved now)', futBefore.overdraw[0].covered, true);
approx('reserved now reduces available (80 - 16 = 64h)', futBefore.availableHours, 64);
approx('paid-to-date is 0 before its date', futBefore.totalPaidHours, 0);
approx('paid becomes 16h once the date has arrived', futAfter.totalPaidHours, 16);

// ---------------------------------------------------------------------------
// Concrete cases printed for eyeballing the semantics before wiring.
// ---------------------------------------------------------------------------
console.log('\n---- concrete cases (eyeball) ----');
const show = (label, r) => console.log(
  `${label}\n  eligible ${r.eligibilityDate} | cycle ${r.cycles[0].start}->${r.cycles[r.cycles.length - 1].end}` +
  ` | carriedIn ${round(r.carriedInHours)}h | earned ${round(r.earnedFractionalDays)}d (floor ${r.earnedWholeDays})` +
  ` | used ${round(r.usedHours)}h | available ${round(r.availableHours)}h (${round(r.availableDays)}d)`
);
show('accrued 10d calendar, 1.2 months in', accrued10);
show('upfront 10d hired 2026-05-15 (first year)', midMay);
show('carry none (2025 unused, 2026 now)', carryNone);
show('carry cap 5d (stacks on next allotment)', carryCap);
show('carry unlimited', carryUnl);
show('3-cycle accrued chain, unlimited', chain);
show('overdraw: six 8h days on a 5d pool', overdraw);
show('shared pool PTO+Sick = 12d, 104h used', sharedPool);

const showBookings = (label, r) => {
  console.log(label);
  for (const o of r.overdraw) {
    console.log(
      `  ${o.date} ${o.code} [${o.status}] book@${o.bookedAt ?? '-'} ${round(o.hours)}h` +
      ` -> reserved ${round(o.reservedHours)}h covered=${o.covered} occurred=${o.occurred}` +
      ` | paid ${round(o.paidHours)}h unpaid ${round(o.unpaidHours)}h`
    );
  }
  console.log(
    `  => available ${round(r.availableHours)}h | reserved-now ${round(r.totalReservedHours)}h` +
    ` | paid-to-date ${round(r.totalPaidHours)}h`
  );
};
console.log('');
showBookings('book-future-then-urgent @ 2026-06-01 (both future)', before);
showBookings('book-future-then-urgent @ 2026-10-01 (both occurred)', after);
showBookings('pending shows but does not reserve', pend);
showBookings('legacy createdAt ordering (1-day pool)', legacy);

console.log('\n' + (fail === 0 ? `All ${pass} accrual self-tests passed.` : `${fail} FAILED, ${pass} passed.`));
process.exit(fail === 0 ? 0 : 1);
