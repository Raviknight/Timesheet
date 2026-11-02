/**
 * scripts/test-timeoff-types.mjs
 *
 * Covers the default time-off type set and mergeDefaultTimeOffTypes, added
 * 2026-11-02 along with Bereavement, Jury Duty and FMLA.
 *
 * The merge exists because DEFAULT_TIME_OFF_TYPES only reaches an account
 * through bootstrap, so a company created before a type was added never sees
 * it. It runs on load against real stored data and writes the result back, so
 * the properties that matter are that it is ADDITIVE and IDEMPOTENT: it must
 * never alter, reorder or drop a type the user has tuned, and running it twice
 * must do nothing the second time.
 *
 * Run with: node scripts/test-timeoff-types.mjs
 */

import { DEFAULT_TIME_OFF_TYPES, mergeDefaultTimeOffTypes } from '../src/data/schema.js';
import { computeHoursPaid, computeHoursWorked } from '../src/core/time.js';

let pass = 0, fail = 0;
const eq = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  cond ? pass++ : fail++;
};
const check = (name, got, want) => {
  const ok = Math.abs(got - want) < 1e-9;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  (got ${got}, want ${want})`));
  ok ? pass++ : fail++;
};

const byCode = c => DEFAULT_TIME_OFF_TYPES.find(t => t.code === c);

// ---------------------------------------------------------------------------
console.log('\n== 1. the default set ==');
for (const code of ['PTO', 'SICK', 'HOLIDAY', 'UNPAID', 'BEREAVEMENT', 'JURY', 'FMLA']) {
  eq(`  ${code} is present`, !!byCode(code));
}
eq('  codes are unique',
  new Set(DEFAULT_TIME_OFF_TYPES.map(t => t.code)).size === DEFAULT_TIME_OFF_TYPES.length);

// The occasional leaves are granted as needed, not accrued, so they carry no
// pool. Getting countsAgainstPool wrong here would silently draw them from PTO.
for (const code of ['BEREAVEMENT', 'JURY', 'FMLA']) {
  const t = byCode(code);
  eq(`  ${code} allots 0 days`, t.poolDays === 0);
  eq(`  ${code} does not touch a pool`, t.countsAgainstPool === false);
  eq(`  ${code} is not additive`, !t.additive);
}
eq('  Bereavement is paid', byCode('BEREAVEMENT').unpaid !== true);
eq('  Jury Duty is paid', byCode('JURY').unpaid !== true);
eq('  FMLA is unpaid', byCode('FMLA').unpaid === true);

// ---------------------------------------------------------------------------
console.log('\n== 2. pay semantics of the new types ==');
{
  const settings = { breakMinutes: 30 };
  const types = DEFAULT_TIME_OFF_TYPES;
  const whole = code => ({ date: '2026-11-02', segments: [], timeOff: code });
  const partWorked = code => ({
    date: '2026-11-02',
    segments: [{ clockIn: '07:00', clockOut: '09:00' }],
    timeOff: code,
  });

  check('  whole Bereavement day pays 8', computeHoursPaid(whole('BEREAVEMENT'), settings, types, []), 8);
  check('  whole Jury Duty day pays 8', computeHoursPaid(whole('JURY'), settings, types, []), 8);
  // FMLA is unpaid, so it pays nothing for the absence itself.
  check('  whole FMLA day pays 0', computeHoursPaid(whole('FMLA'), settings, types, []), 0);
  check('  FMLA day with 2h worked pays only the 2',
    computeHoursPaid(partWorked('FMLA'), settings, types, []), 2);
  check('  and that 2 is all worked, no benefit',
    computeHoursWorked(partWorked('FMLA'), settings, []), 2);
}

// ---------------------------------------------------------------------------
console.log('\n== 3. merge is additive ==');
{
  // A company bootstrapped before this change: the original four types.
  const legacy = [
    { code: 'PTO', label: 'PTO', poolDays: 11, countsAgainstPool: true, hoursPerDay: 8, additive: false },
    { code: 'SICK', label: 'Sick', poolDays: 0, countsAgainstPool: true, hoursPerDay: 8, additive: false, sharedPoolWith: 'PTO' },
    { code: 'HOLIDAY', label: 'Holiday', poolDays: 0, countsAgainstPool: false, hoursPerDay: 8, additive: true },
    { code: 'UNPAID', label: 'Unpaid', poolDays: 0, countsAgainstPool: false, hoursPerDay: 8, additive: false, unpaid: true },
  ];
  const r = mergeDefaultTimeOffTypes(legacy);
  eq('  adds exactly the three new codes',
    r.added.join(',') === 'BEREAVEMENT,JURY,FMLA');
  eq('  existing four keep their order',
    r.types.slice(0, 4).map(t => t.code).join(',') === 'PTO,SICK,HOLIDAY,UNPAID');
  eq('  PTO pool days untouched', r.types.find(t => t.code === 'PTO').poolDays === 11);
  eq('  SICK still shares the PTO pool',
    r.types.find(t => t.code === 'SICK').sharedPoolWith === 'PTO');
  eq('  nothing was dropped', r.types.length === legacy.length + 3);
  eq('  the input array was not mutated', legacy.length === 4);

  // Deep copy, not a shared reference: editing the merged type must not reach
  // back into the module-level defaults.
  r.types.find(t => t.code === 'FMLA').label = 'Changed';
  eq('  merged types are copies, defaults unaffected', byCode('FMLA').label === 'FMLA');
}

console.log('\n== 4. merge is idempotent and tolerant ==');
{
  const once = mergeDefaultTimeOffTypes([]);
  const twice = mergeDefaultTimeOffTypes(once.types);
  eq('  second run adds nothing', twice.added.length === 0);
  eq('  second run changes nothing', twice.types.length === once.types.length);

  eq('  null stored yields the full default set',
    mergeDefaultTimeOffTypes(null).types.length === DEFAULT_TIME_OFF_TYPES.length);
  eq('  undefined stored is handled',
    mergeDefaultTimeOffTypes(undefined).added.length === DEFAULT_TIME_OFF_TYPES.length);
  eq('  a non-array is handled',
    mergeDefaultTimeOffTypes('nonsense').types.length === DEFAULT_TIME_OFF_TYPES.length);

  // A user who retuned a default must keep their version untouched.
  const tuned = [{ code: 'PTO', label: 'Vacation', poolDays: 20, countsAgainstPool: true, hoursPerDay: 10, additive: false }];
  const t = mergeDefaultTimeOffTypes(tuned);
  const pto = t.types.find(x => x.code === 'PTO');
  eq('  a retuned PTO is left exactly as the user set it',
    pto.label === 'Vacation' && pto.poolDays === 20 && pto.hoursPerDay === 10);
  eq('  and PTO is not duplicated',
    t.types.filter(x => x.code === 'PTO').length === 1);
}

console.log(`\n--- ${pass} pass, ${fail} fail ---`);
if (fail > 0) process.exit(1);
console.log('All time-off type self-tests passed.');
