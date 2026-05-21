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

const fullRow = {
  id: '93bf1d42-4f06-4d14-ad72-587f787b7c0a',
  name: 'Ferry',
  pay_frequency: 'biweekly',
  week_start_dow: 1,
  biweekly_ref_date: '2025-12-28',
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
    biweeklyRefDate: '2025-12-28',
    semiFirstDay: null,
    semiSecondDay: null,
    monthlyStartDay: null,
    advancedAnchorDate: null,
    advancedCycleDays: null,
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
    biweeklyRefDate: null,
    semiFirstDay: null,
    semiSecondDay: null,
    monthlyStartDay: null,
    advancedAnchorDate: null,
    advancedCycleDays: null,
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
  biweekly_ref_date: '2025-12-28',
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

const ferryMulti = { ...ferryOld, weekStartDow: 0, biweeklyRefDate: '2026-01-04' };
eq(
  'diff: multiple changes → patch with all changed keys',
  diffCompanyForUpdate(ferryMulti, ferryOld),
  { week_start_dow: 0, biweekly_ref_date: '2026-01-04' }
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
// 4. migrateCompanies fills v2 → v3 fields from user-level settings.
// ---------------------------------------------------------------------------

const v2Settings = {
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

const migrated = migrateCompanies(v2Companies, v2Settings);

eq(
  'migrate: empty company gets all defaults from settings',
  migrated[0],
  {
    id: 'x',
    name: 'X',
    payFrequency: 'biweekly',
    weekStartDow: 1,
    biweeklyRefDate: '2025-12-28',
    semiFirstDay: 1,
    semiSecondDay: 16,
    monthlyStartDay: 1,
    advancedAnchorDate: '2025-12-29',
    advancedCycleDays: 14,
  }
);

eq(
  'migrate: partial company keeps its own payFrequency, fills the rest',
  migrated[1].payFrequency,
  'monthly'
);

eq(
  'migrate: partial company still inherits weekStartDow from settings',
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
