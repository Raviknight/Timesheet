// scripts/test-companies-write.mjs
//
// Step 3e.1 self-test: exercises companyRowToAppShape and
// diffCompanyForUpdate from src/data/storage.js, plus replays the
// exact diff loop the write path uses so the "exactly N updates"
// contract is checked end-to-end.
//
// Run with: node scripts/test-companies-write.mjs

import {
  companyRowToAppShape,
  diffCompanyForUpdate,
} from '../src/data/storage.js';
import { migrateCompanies } from '../src/data/schema.js';

let failures = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL  ${label}\n      expected: ${e}\n      actual:   ${a}`);
    failures++;
  } else {
    console.log(`PASS  ${label}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Read-path mapping
// ---------------------------------------------------------------------------

// After 0.5c the per-employee columns (break_minutes, std_seg*, start_date)
// no longer exist on the companies row. companyRowToAppShape reads them from
// the member overlay only; without an overlay they come back null.
const fullRow = {
  id: '93bf1d42-4f06-4d14-ad72-587f787b7c0a',
  name: 'Ferry',
  pay_frequency: 'biweekly',
  week_start_dow: 1,
  biweekly_start_parity: 'odd',
  semi_first_day: null,
  semi_second_day: null,
  monthly_start_day: null,
  advanced_anchor_date: null,
  advanced_cycle_days: null,
};

eq(
  'read: full row → app shape',
  companyRowToAppShape(fullRow),
  {
    id: '93bf1d42-4f06-4d14-ad72-587f787b7c0a',
    name: 'Ferry',
    payFrequency: 'biweekly',
    weekStartDow: 1,
    biweeklyStartParity: 'odd',
    semiFirstDay: null,
    semiSecondDay: null,
    monthlyStartDay: null,
    advancedAnchorDate: null,
    advancedCycleDays: null,
    isActive: null,
    otThreshold: 40,
    otPeriod: 'weekly',
    breakMinutes: null,
    stdSeg1Start: null,
    stdSeg1End: null,
    stdSeg2Start: null,
    stdSeg2End: null,
    startDate: null,
  }
);

// Older DB rows with no pay-period columns: every new field should map to
// null (no crash, no undefined leak).
const oldRow = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Legacy',
};
eq(
  'read: legacy row missing new columns → nulls',
  companyRowToAppShape(oldRow),
  {
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    name: 'Legacy',
    payFrequency: null,
    weekStartDow: null,
    biweeklyStartParity: null,
    semiFirstDay: null,
    semiSecondDay: null,
    monthlyStartDay: null,
    advancedAnchorDate: null,
    advancedCycleDays: null,
    isActive: null,
    otThreshold: 40,
    otPeriod: 'weekly',
    breakMinutes: null,
    stdSeg1Start: null,
    stdSeg1End: null,
    stdSeg2Start: null,
    stdSeg2End: null,
    startDate: null,
  }
);

// ---------------------------------------------------------------------------
// 2. diffCompanyForUpdate
// ---------------------------------------------------------------------------

const ferryOld = companyRowToAppShape(fullRow);
const phillipsOld = companyRowToAppShape({
  id: '944f07e7-8cbf-4ea3-8858-3863c37ce510',
  name: 'Phillips Precision',
  pay_frequency: 'biweekly',
  week_start_dow: 1,
  biweekly_start_parity: 'even',
  semi_first_day: null,
  semi_second_day: null,
  monthly_start_day: null,
  advanced_anchor_date: null,
  advanced_cycle_days: null,
});

eq('diff: no change → null', diffCompanyForUpdate(ferryOld, ferryOld), null);

const ferryNew = { ...ferryOld, payFrequency: 'monthly' };
eq(
  'diff: pay_frequency changed → patch with only that key',
  diffCompanyForUpdate(ferryNew, ferryOld),
  { pay_frequency: 'monthly' }
);

const ferryRenamed = { ...ferryOld, name: 'Ferry Machines' };
eq(
  'diff: name changed → snake_case "name" patch',
  diffCompanyForUpdate(ferryRenamed, ferryOld),
  { name: 'Ferry Machines' }
);

const ferryMulti = { ...ferryOld, weekStartDow: 0, biweeklyStartParity: 'even' };
eq(
  'diff: multiple changes → patch with all changed keys',
  diffCompanyForUpdate(ferryMulti, ferryOld),
  { week_start_dow: 0, biweekly_start_parity: 'even' }
);

// ---------------------------------------------------------------------------
// 3. Replay the write-path loop with two companies
// ---------------------------------------------------------------------------

// Helper that walks the same logic as RemoteStore.set('ts:companies', …).
function simulateWritePath(oldSnap, newSnap) {
  const oldById = {};
  for (const c of oldSnap) oldById[c.id] = c;
  const updates = [];
  for (const c of newSnap) {
    const oldRow = oldById[c.id];
    if (!oldRow) continue;  // inserts deferred
    const patch = diffCompanyForUpdate(c, oldRow);
    if (patch) updates.push({ id: c.id, patch });
  }
  return updates;
}

// Scenario A: change Ferry only; Phillips untouched.
const writes_A = simulateWritePath(
  [ferryOld, phillipsOld],
  [{ ...ferryOld, payFrequency: 'monthly' }, phillipsOld]
);
eq('write loop: change Ferry only → exactly one update for Ferry', writes_A, [
  { id: '93bf1d42-4f06-4d14-ad72-587f787b7c0a', patch: { pay_frequency: 'monthly' } },
]);

// Scenario B: no change → zero updates.
const writes_B = simulateWritePath(
  [ferryOld, phillipsOld],
  [ferryOld, phillipsOld]
);
eq('write loop: no-change set → zero updates', writes_B, []);

// Scenario C: a brand-new company (not in oldSnap) is silently skipped.
const writes_C = simulateWritePath(
  [ferryOld],
  [ferryOld, { ...phillipsOld, id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' }]
);
eq('write loop: unknown id is skipped (no INSERT path here)', writes_C, []);

// ---------------------------------------------------------------------------
// 4. migrateCompanies fills missing columns with per-company defaults.
//
// As of 3e.5 (commit 2b08341) it no longer reads user-level settings: the old
// v2 → v3 settings bridge (system/semi1/semi2/monthlyStart/anchorDate/...) was
// removed. Pay-period config now lives on each company's own columns, and a
// company that lacks them gets the per-company defaults, NOT values copied from
// settings. We pass a populated settings object below purely to prove it is
// ignored.
// ---------------------------------------------------------------------------

const ignoredSettings = {
  system: 'biweekly',
  startDow: 1,
  biweeklyRef: '2025-12-28',
  semi1: 1,
  semi2: 16,
  monthlyStart: 1,
  anchorDate: '2025-12-29',
  cycleDays: 14,
};

const v2Companies = [
  { id: 'x', name: 'X' },                                    // no pay-period yet
  { id: 'y', name: 'Y', payFrequency: 'monthly' },           // partial: keep its own freq
];

// Second argument is ignored; passed to assert the settings bridge is gone.
const migrated = migrateCompanies(v2Companies, ignoredSettings);

eq(
  'migrate: empty company gets per-company defaults, ignoring user settings',
  migrated[0],
  {
    id: 'x',
    name: 'X',
    payFrequency: 'biweekly',
    weekStartDow: 1,
    biweeklyStartParity: 'odd',
    semiFirstDay: null,
    semiSecondDay: null,
    monthlyStartDay: null,
    advancedAnchorDate: null,
    advancedCycleDays: null,
    isActive: true,
    otThreshold: 40,
    otPeriod: 'weekly',
    // Per-employee fields (break, Standard Day, hire date) live on
    // company_members. migrateCompanies no longer defaults them, so they're
    // absent from the migrated shape; they only appear on the app-shape after
    // companyRowToAppShape pulls them off the member overlay.
  }
);

eq(
  'migrate: partial company keeps its own payFrequency, fills the rest',
  migrated[1].payFrequency,
  'monthly'
);

eq(
  'migrate: partial company gets the default weekStartDow, not a settings value',
  migrated[1].weekStartDow,
  1
);

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('\nAll self-tests passed.');
}
