/**
 * scripts/test-coverage.mjs
 *
 * Gate harness for chunk 3b: pool time-off pays only when the engine marks the
 * day covered. Compares OLD (computeHoursPaid) vs NEW (paidHoursWithCoverage
 * over the per-company engine coverage) and proves:
 *   - within-budget company: NEW == OLD for every day (covered pays as today)
 *   - over-budget company: over-pool days drop to 0 paid; covered unchanged
 *   - a pending day does not pay
 *   - worked / Holiday / Unpaid days are byte-identical
 *
 * Run with: node scripts/test-coverage.mjs
 */
import { computeHoursPaid, computeHoursWorked, computeHoursBenefit } from '../src/core/time.js';
import { computeCompanyPools, coverageFromPools, paidHoursWithCoverage, benefitHoursWithCoverage } from '../src/core/coverage.js';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = Math.abs(got - want) < 1e-9;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}, want ${want})`);
  ok ? pass++ : fail++;
};
const eq = (name, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${name}`); c ? pass++ : fail++; };

const asOf = '2026-06-16';
const settings = { breakMinutes: 30 };
const company = { id: 'c1', name: 'Acme' }; // no hire date -> Jan 1 cycle, no probation
const companies = [company];
const typesFor = pool => ([
  { code: 'PTO', label: 'PTO', poolDays: pool, hoursPerDay: 8, countsAgainstPool: true, additive: false },
  { code: 'HOLIDAY', label: 'Holiday', poolDays: 0, hoursPerDay: 8, countsAgainstPool: false, additive: true },
  { code: 'UNPAID', label: 'Unpaid', poolDays: 0, hoursPerDay: 8, countsAgainstPool: false, additive: false, unpaid: true },
]);

function run(pool, entries) {
  const types = typesFor(pool);
  const pools = computeCompanyPools({ company, timeOffTypes: types, entries, settings, companies, asOf });
  const coverage = coverageFromPools(pools);
  let oldSum = 0, newSum = 0;
  const rows = entries.map(e => {
    const o = computeHoursPaid(e, settings, types, companies);
    const n = paidHoursWithCoverage(e, settings, types, companies, coverage);
    oldSum += o; newSum += n;
    return { date: e.date, code: e.timeOff || '(worked)', old: o, new: n };
  });
  return { rows, oldSum, newSum };
}

const pto = (date, extra = {}) => ({ date, segments: [], timeOff: 'PTO', ...extra });

// 1. Within-budget: 11-day pool, 3 PTO days taken -> NEW == OLD throughout.
console.log('\n== 1. within budget (11d pool, 3 PTO days) ==');
const within = run(11, [pto('2026-02-03'), pto('2026-03-10'), pto('2026-04-21')]);
within.rows.forEach(r => check(`  ${r.date} new==old`, r.new, r.old));
check('within: OLD total', within.oldSum, 24);
check('within: NEW total (unchanged)', within.newSum, 24);

// 2. Over-budget: 2-day pool (16h), 4 PTO days -> first 2 covered, last 2 unpaid.
console.log('\n== 2. over budget (2d pool, 4 PTO days) ==');
const over = run(2, [pto('2026-02-02'), pto('2026-02-09'), pto('2026-02-16'), pto('2026-02-23')]);
over.rows.forEach(r => console.log(`  ${r.date}  old ${r.old}  new ${r.new}`));
check('over: day 1 covered pays 8', over.rows[0].new, 8);
check('over: day 2 covered pays 8', over.rows[1].new, 8);
check('over: day 3 over-pool pays 0', over.rows[2].new, 0);
check('over: day 4 over-pool pays 0', over.rows[3].new, 0);
check('over: OLD total', over.oldSum, 32);
check('over: NEW total drops over-pool 16h', over.newSum, 16);

// 3. Pending day does not pay (approved within pool still pays).
console.log('\n== 3. pending day ==');
const pend = run(11, [pto('2026-02-03', { status: 'approved' }), pto('2026-05-01', { status: 'pending' })]);
const appr = pend.rows.find(r => r.date === '2026-02-03');
const pday = pend.rows.find(r => r.date === '2026-05-01');
check('pending: approved day pays 8', appr.new, 8);
check('pending: pending day old pays 8', pday.old, 8);
check('pending: pending day new pays 0', pday.new, 0);

// 4. Worked / Holiday / Unpaid byte-identical.
console.log('\n== 4. worked / holiday / unpaid untouched ==');
const mixed = run(11, [
  { date: '2026-02-04', segments: [{ clockIn: '08:00', clockOut: '16:30', breakTaken: true }], timeOff: null },
  { date: '2026-02-05', segments: [], timeOff: 'HOLIDAY' },
  { date: '2026-02-06', segments: [], timeOff: 'UNPAID' },
]);
mixed.rows.forEach(r => check(`  ${r.code} ${r.date} new==old`, r.new, r.old));
// Absolute values, not just new==old. Regression for the bug where
// computeHoursPaid never read the unpaid flag and fell through to the type's
// hoursPerDay, so a pure unpaid day paid 8h and inflated pay-period totals.
check('  worked day pays 8 (8.5h less 30m break)', mixed.rows[0].new, 8);
check('  HOLIDAY additive pays 8', mixed.rows[1].new, 8);
check('  UNPAID pays 0', mixed.rows[2].new, 0);

// An unpaid day still pays whatever was actually worked that day, and the
// unpaid portion adds nothing on top, override or not.
console.log('\n== 4b. unpaid pays worked hours only ==');
const workedUnpaid = run(11, [
  { date: '2026-02-09', segments: [{ clockIn: '08:00', clockOut: '12:00' }], timeOff: 'UNPAID' },
  { date: '2026-02-10', segments: [{ clockIn: '08:00', clockOut: '12:00' }], timeOff: 'UNPAID', hoursOverride: 4 },
]);
check('  worked 4h + UNPAID pays 4', workedUnpaid.rows[0].new, 4);
check('  UNPAID 4h override still pays only the 4 worked', workedUnpaid.rows[1].new, 4);

// ---------------------------------------------------------------------------
// Half-day override (chunk half-day-a). hours_override sets an explicit
// time-off portion for a partial day. computeHoursPaid lays it on top of any
// worked segment; the pool draws only that time-off portion (paid minus
// worked), never the worked hours.
// ---------------------------------------------------------------------------
function poolRun(types, entries) {
  const pools = computeCompanyPools({ company, timeOffTypes: types, entries, settings, companies, asOf });
  const coverage = coverageFromPools(pools);
  // PTO-owner pool is the only pool in these fixtures.
  return { result: pools[0].result, coverage };
}

// A. Half-day pool draw: one PTO entry, 4h override, 11-day (88h) pool.
console.log('\n== A. half-day PTO override (4h, 11d pool) ==');
{
  const types = typesFor(11);
  const e = pto('2026-02-03', { hoursOverride: 4 });
  const { result, coverage } = poolRun(types, [e]);
  const paid = paidHoursWithCoverage(e, settings, types, companies, coverage);
  check('A: paidHoursWithCoverage', paid, 4);
  check('A: pool draw', result.usedHours, 4);
  check('A: remaining pool', result.availableHours, 11 * 8 - 4);
  eq('A: day covered', coverage['2026-02-03'] && coverage['2026-02-03'].covered === true);
}

// B. Half-day with sharedPoolWith: a 4h SICK entry sharing PTO's pool plus a
// separate full 8h PTO entry -> combined 12h draw from the merged pool.
console.log('\n== B. half-day SICK sharing PTO pool + full PTO ==');
{
  const types = [
    { code: 'PTO',  label: 'PTO',  poolDays: 11, hoursPerDay: 8, countsAgainstPool: true, additive: false },
    { code: 'SICK', label: 'Sick', poolDays: 0,  hoursPerDay: 8, countsAgainstPool: true, additive: false, sharedPoolWith: 'PTO' },
  ];
  const eSick = { date: '2026-02-03', segments: [], timeOff: 'SICK', hoursOverride: 4 };
  const ePto  = pto('2026-02-10');
  const { result, coverage } = poolRun(types, [eSick, ePto]);
  check('B: combined draw from merged pool', result.usedHours, 12);
  eq('B: SICK half-day covered', coverage['2026-02-03'] && coverage['2026-02-03'].covered === true);
  eq('B: full PTO day covered', coverage['2026-02-10'] && coverage['2026-02-10'].covered === true);
}

// C. Half-day + worked segment same date: 4h worked AND 4h override on a
// non-additive PTO day. Paid = 8 (4 worked + 4 PTO); the pool draws only the
// 4h override (the worked hours never deplete the balance).
console.log('\n== C. half-day override + worked segment same date ==');
{
  const types = typesFor(11);
  const e = {
    date: '2026-02-03',
    segments: [{ clockIn: '08:00', clockOut: '12:00', breakTaken: false }],
    timeOff: 'PTO',
    hoursOverride: 4,
  };
  const { result, coverage } = poolRun(types, [e]);
  const paid = paidHoursWithCoverage(e, settings, types, companies, coverage);
  check('C: paidHoursWithCoverage (4 worked + 4 PTO)', paid, 8);
  check('C: pool draws only the override', result.usedHours, 4);
  check('C: remaining pool', result.availableHours, 11 * 8 - 4);
}

// D. Regression lock: clone the within-budget whole-day PTO case with explicit
// hoursOverride: null and assert it is byte-identical to the override-absent run.
console.log('\n== D. regression lock (hoursOverride: null whole-day PTO) ==');
{
  const entries = [
    pto('2026-02-03', { hoursOverride: null }),
    pto('2026-03-10', { hoursOverride: null }),
    pto('2026-04-21', { hoursOverride: null }),
  ];
  const d = run(11, entries);
  d.rows.forEach(r => check(`  ${r.date} new==old`, r.new, r.old));
  check('D: OLD total (byte-identical)', d.oldSum, 24);
  check('D: NEW total (byte-identical)', d.newSum, 24);
}

// ---------------------------------------------------------------------------
// E. Worked part of a day, then took sick leave for the rest.
//
// Reported 2026-10-31: clocking 2 hours and taking sick leave gave either 2
// hours or 8, never both. The cause is not broken arithmetic. A non-additive
// type with no override pays the worked hours and the time off adds nothing,
// so a part-worked day can only be expressed with an explicit override.
// SICK shares the PTO pool, so the time-off portion must draw from that pool
// and the worked hours must not.
// ---------------------------------------------------------------------------
console.log('\n== E. worked 2h then sick for the rest of an 8h day ==');
{
  const types = [
    { code: 'PTO',  label: 'PTO',  poolDays: 11, hoursPerDay: 8, countsAgainstPool: true, additive: false },
    { code: 'SICK', label: 'Sick', poolDays: 0,  hoursPerDay: 8, countsAgainstPool: true, additive: false, sharedPoolWith: 'PTO' },
  ];
  const e = {
    date: '2026-10-26',
    segments: [{ clockIn: '07:00', clockOut: '09:00' }],
    timeOff: 'SICK',
    hoursOverride: 6,
  };
  const { result, coverage } = poolRun(types, [e]);
  check('E: worked hours', computeHoursWorked(e, settings, companies), 2);
  check('E: pays 2 worked + 6 sick = 8',
    paidHoursWithCoverage(e, settings, types, companies, coverage), 8);
  check('E: pool draws only the 6 sick hours', result.usedHours, 6);
  check('E: remaining pool', result.availableHours, 11 * 8 - 6);
  eq('E: the day is covered',
    coverage['2026-10-26'] && coverage['2026-10-26'].covered === true);

  // The shape the user actually hit: Full day, so no override. The sick leave
  // contributes nothing and the day pays only what was clocked.
  const noOverride = { ...e, hoursOverride: null };
  check('E: with no override the day pays only the 2 worked',
    computeHoursPaid(noOverride, settings, types, companies), 2);
}

// ---------------------------------------------------------------------------
// F. Coverage must never withhold hours that were actually worked.
//
// Reported 2026-11-02 with a screenshot: Mon Oct 26 had 06:58-08:58 clocked
// plus a PTO code, and the week card showed a dash for hours while the week
// total excluded the day entirely. paidHoursWithCoverage returned 0 for any
// uncovered pool day, including the part that was physically worked.
//
// It was not an over-pool edge case. A whole-day PTO code on a part-worked day
// draws nothing from the pool (benefit is paid minus worked, which is 0 when
// the segments already cover the day), and the engine marks a zero-hour draw
// as not covered (see `u.hours > 0` in accrual.js), so an everyday entry with
// a nearly full balance landed on the zero path.
// ---------------------------------------------------------------------------
console.log('\n== F. uncovered day still pays the hours worked ==');
{
  // F1: the reported entry, against a nearly untouched 11-day pool.
  const types = typesFor(11);
  const reported = {
    date: '2026-10-26',
    segments: [{ clockIn: '06:58', clockOut: '08:58', breakTaken: true }],
    timeOff: 'PTO',
    status: 'approved',
  };
  const r1 = poolRun(types, [reported]);
  eq('F1: engine marks the zero-hour draw uncovered',
    r1.coverage['2026-10-26'] && r1.coverage['2026-10-26'].covered === false);
  check('F1: still pays the 2 hours clocked',
    paidHoursWithCoverage(reported, settings, types, companies, r1.coverage), 2);
  check('F1: and draws nothing from the pool',
    computeHoursBenefit(reported, settings, types, companies), 0);

  // F2 / F3: a 1-day (8h) pool with three whole-day bookings plus one
  // part-worked day, so later bookings are genuinely over pool.
  const small = typesFor(1);
  const covered   = { date: '2026-02-02', segments: [], timeOff: 'PTO', status: 'approved' };
  const overWhole = { date: '2026-02-09', segments: [], timeOff: 'PTO', status: 'approved' };
  const overWorked = {
    date: '2026-02-16',
    segments: [{ clockIn: '08:00', clockOut: '12:00' }],
    timeOff: 'PTO', status: 'approved', hoursOverride: 4,
  };
  const r2 = poolRun(small, [covered, overWhole, overWorked]);

  eq('F2: first booking is covered', r2.coverage['2026-02-02'].covered === true);
  check('F2: covered whole day pays 8',
    paidHoursWithCoverage(covered, settings, small, companies, r2.coverage), 8);

  eq('F3: second booking is over pool', r2.coverage['2026-02-09'].covered === false);
  check('F3: uncovered whole day pays 0, nothing was worked',
    paidHoursWithCoverage(overWhole, settings, small, companies, r2.coverage), 0);

  eq('F4: part-worked booking is over pool', r2.coverage['2026-02-16'].covered === false);
  check('F4: over-pool part-worked day pays the 4 worked, not the 4 PTO',
    paidHoursWithCoverage(overWorked, settings, small, companies, r2.coverage), 4);
}

// ---------------------------------------------------------------------------
// G. A day's paid hours partition into worked plus benefit, with no overlap.
//
// Reported 2026-11-02: after taking a full 8h PTO day on top of 2 hours
// clocked, the week card still showed 1.50 OT instead of 3.50. The week card
// and the period totals put the FULL paid amount of a non-Holiday time-off day
// into the Time off bucket and dropped its worked hours, so those hours never
// reached the Regular/OT split. Holiday already did the right thing by adding
// its worked hours and bucketing only the benefit.
//
// The invariant the display layers depend on:
//
//     paidHoursWithCoverage == computeHoursWorked + benefitHoursWithCoverage
//
// Worked hours feed Regular/OT, benefit hours feed Time off or Holiday, and the
// two never overlap. Locked here for every entry shape that reaches those
// buckets, because the dashboard functions are DOM-coupled and cannot be
// called directly from a harness.
// ---------------------------------------------------------------------------
console.log('\n== G. paid partitions into worked + benefit ==');
{
  const types = typesFor(11);
  const small = typesFor(1); // 8h pool, to force an over-pool day

  const cases = [
    ['whole-day PTO', types,
      { date: '2026-05-04', segments: [], timeOff: 'PTO', status: 'approved' }],
    ['part-worked PTO, Full day (no override)', types,
      { date: '2026-05-05', segments: [{ clockIn: '06:58', clockOut: '08:58', breakTaken: true }],
        timeOff: 'PTO', status: 'approved' }],
    ['part-worked PTO, 6h override (gap fill)', types,
      { date: '2026-05-06', segments: [{ clockIn: '06:58', clockOut: '08:58', breakTaken: true }],
        timeOff: 'PTO', status: 'approved', hoursOverride: 6 }],
    ['part-worked PTO, full 8h on top', types,
      { date: '2026-05-07', segments: [{ clockIn: '06:58', clockOut: '08:58', breakTaken: true }],
        timeOff: 'PTO', status: 'approved', hoursOverride: 8 }],
    ['worked holiday', types,
      { date: '2026-05-08', segments: [{ clockIn: '07:00', clockOut: '13:45' }],
        timeOff: 'HOLIDAY', status: 'approved' }],
    ['part-worked unpaid', types,
      { date: '2026-05-11', segments: [{ clockIn: '07:00', clockOut: '09:00' }],
        timeOff: 'UNPAID', status: 'approved' }],
    ['plain worked day', types,
      { date: '2026-05-12', segments: [{ clockIn: '07:00', clockOut: '16:30', breakTaken: true }],
        timeOff: null }],
  ];

  for (const [label, tt, e] of cases) {
    const cov = coverageFromPools(computeCompanyPools({
      company, timeOffTypes: tt, entries: [e], settings, companies, asOf,
    }));
    const paid = paidHoursWithCoverage(e, settings, tt, companies, cov);
    const workedH = computeHoursWorked(e, settings, companies);
    const benefit = benefitHoursWithCoverage(e, settings, tt, companies, cov);
    check(`G: ${label} (paid ${paid})`, workedH + benefit, paid);
    eq(`G: ${label} benefit is never negative`, benefit >= -1e-9);
  }

  // The reported day specifically: 2 worked feed OT, 8 feed Time off.
  const reported = {
    date: '2026-10-26',
    segments: [{ clockIn: '06:58', clockOut: '08:58', breakTaken: true }],
    timeOff: 'PTO', status: 'approved', hoursOverride: 8,
  };
  const covR = coverageFromPools(computeCompanyPools({
    company, timeOffTypes: types, entries: [reported], settings, companies, asOf,
  }));
  check('G: reported day worked portion is 2', computeHoursWorked(reported, settings, companies), 2);
  check('G: reported day benefit portion is 8',
    benefitHoursWithCoverage(reported, settings, types, companies, covR), 8);
  check('G: reported day pays 10 in total',
    paidHoursWithCoverage(reported, settings, types, companies, covR), 10);

  // Over pool with work done: benefit collapses to 0, worked still counts.
  const over = [
    { date: '2026-02-02', segments: [], timeOff: 'PTO', status: 'approved' },
    { date: '2026-02-09', segments: [{ clockIn: '08:00', clockOut: '12:00' }],
      timeOff: 'PTO', status: 'approved', hoursOverride: 4 },
  ];
  const covO = coverageFromPools(computeCompanyPools({
    company, timeOffTypes: small, entries: over, settings, companies, asOf,
  }));
  check('G: over-pool day benefit is 0',
    benefitHoursWithCoverage(over[1], settings, small, companies, covO), 0);
  check('G: over-pool day still contributes 4 worked',
    computeHoursWorked(over[1], settings, companies), 4);
}

console.log('\n---- report numbers ----');
console.log(`within-budget: OLD ${within.oldSum}h  ->  NEW ${within.newSum}h  (must match)`);
console.log(`over-budget:   OLD ${over.oldSum}h  ->  NEW ${over.newSum}h  (intended 16h drop)`);

console.log('\n' + (fail === 0 ? `All ${pass} coverage self-tests passed.` : `${fail} FAILED, ${pass} passed.`));
process.exit(fail === 0 ? 0 : 1);
