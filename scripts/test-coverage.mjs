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
import { computeHoursPaid } from '../src/core/time.js';
import { computeCompanyPools, coverageFromPools, paidHoursWithCoverage } from '../src/core/coverage.js';

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

console.log('\n---- report numbers ----');
console.log(`within-budget: OLD ${within.oldSum}h  ->  NEW ${within.newSum}h  (must match)`);
console.log(`over-budget:   OLD ${over.oldSum}h  ->  NEW ${over.newSum}h  (intended 16h drop)`);

console.log('\n' + (fail === 0 ? `All ${pass} coverage self-tests passed.` : `${fail} FAILED, ${pass} passed.`));
process.exit(fail === 0 ? 0 : 1);
