/**
 * src/data/schema.js
 *
 * The shape of stored data, defaults, and migration logic.
 *
 * Storage keys are namespaced under `ts:`. The schema version lets us evolve
 * data shapes safely.
 *
 * When you change the shape of any stored value:
 *   1. Bump SCHEMA_VERSION
 *   2. Add a step to migrate()
 *   3. Test with a sample export from the previous version
 */

export const SCHEMA_VERSION = 3;

/** Storage keys. Always reference via SK.* — never hard-code strings. */
export const SK = {
  profile: 'ts:profile',
  settings: 'ts:settings',
  timeOff: 'ts:timeOffTypes',
  companies: 'ts:companies',
  entries: 'ts:entries',
  pays: 'ts:pays',
  schema: 'ts:schemaVersion',
};

/**
 * Storage key for a SPECIFIC company's time-off types, scoped by company_id.
 * `SK.timeOff` (no suffix) reads/writes the profile's ACTIVE company and feeds
 * the pay math via state.timeOffTypes; this suffixed form addresses any other
 * active company for the per-company Settings editor. Remote (Supabase) only.
 */
export function timeOffKeyFor(companyId) {
  return SK.timeOff + ':' + companyId;
}

export const DEFAULT_PROFILE = {
  userId: 'me',
  name: 'You',
  role: 'owner',       // owner | employee | supervisor | admin
  companyId: null,
};

export const DEFAULT_SETTINGS = {
  // Calculation rules. Pay-period and OT config now live per-company
  // (see migrateCompanies); only the break length remains a user setting.
  breakMinutes: 30,          // default break deducted on segments > 5h
};

/**
 * Time-off type shape:
 *   {
 *     code:               string   short code (PTO, SICK, ...)
 *     label:              string   display name
 *     poolDays:           number   default annual allowance in days
 *     hoursPerDay:        number   conversion factor (typically 8)
 *     countsAgainstPool:  boolean  whether it draws down a pool
 *     sharedPoolWith?:    string   code of the pool owner this type rolls into
 *     unpaid?:            boolean  marker for unpaid time
 *     poolByYear?:        object   optional per-year override map,
 *                                  e.g. { '2025': 6, '2026': 11 }.
 *                                  When the active year has an entry, it
 *                                  replaces poolDays for that year. Missing
 *                                  years fall back to poolDays.
 *   }
 */
export const DEFAULT_TIME_OFF_TYPES = [
  { code: 'PTO',     label: 'PTO',     poolDays: 11, countsAgainstPool: true,  hoursPerDay: 8, additive: false },
  { code: 'SICK',    label: 'Sick',    poolDays: 0,  countsAgainstPool: true,  hoursPerDay: 8, additive: false, sharedPoolWith: 'PTO' },
  { code: 'HOLIDAY', label: 'Holiday', poolDays: 0,  countsAgainstPool: false, hoursPerDay: 8, additive: true },
  { code: 'UNPAID',  label: 'Unpaid',  poolDays: 0,  countsAgainstPool: false, hoursPerDay: 8, additive: false, unpaid: true },
];

/**
 * Migrate a stored entry to the current shape.
 *
 * Two historical shapes are handled:
 *   v0: legacy flat fields (clockIn/clockOut/breakStart/breakEnd at top level)
 *   v1: segments[] with { clockIn, clockOut, breakStart, breakEnd }
 *
 * Current shape (v2) is segments[] with { clockIn, clockOut, breakTaken }.
 * Pure time-off entries carry segments: [].
 */
export function migrateEntry(e) {
  if (!e) return e;

  // v0 -> v1: lift flat fields into a single segment.
  let segments;
  if (Array.isArray(e.segments)) {
    segments = e.segments;
  } else if (e.clockIn || e.clockOut || e.breakStart || e.breakEnd) {
    segments = [{
      clockIn: e.clockIn || null,
      clockOut: e.clockOut || null,
      breakStart: e.breakStart || null,
      breakEnd: e.breakEnd || null,
    }];
  } else {
    segments = [];
  }

  const out = segments
    .map(normalizeSegment)
    .filter(s => s.clockIn || s.clockOut);

  return {
    date: e.date,
    segments: out,
    timeOff: e.timeOff || null,
    notes: e.notes || null,
  };
}

/**
 * Normalize a single segment to { clockIn, clockOut, breakTaken }.
 * If a stale segment still carries breakStart/breakEnd, derive breakTaken
 * using the same semantic-bounds rule the SQL migration used: both endpoints
 * present, end > start, and the window sits inside the clock-in/out span.
 */
function normalizeSegment(s) {
  if (!s) return { clockIn: null, clockOut: null, breakTaken: false };

  const clockIn = s.clockIn || null;
  const clockOut = s.clockOut || null;

  if (typeof s.breakTaken === 'boolean') {
    return { clockIn, clockOut, breakTaken: s.breakTaken };
  }

  const bs = s.breakStart || '';
  const be = s.breakEnd || '';
  const ci = clockIn || '';
  const co = clockOut || '';
  const breakTaken =
    !!bs && !!be && be > bs &&
    !!ci && !!co && bs >= ci && be <= co;

  return { clockIn, clockOut, breakTaken };
}

/** Migrate the entire entries map. */
export function migrateEntries(entries) {
  if (!entries) return {};
  const out = {};
  for (const k of Object.keys(entries)) {
    out[k] = migrateEntry(entries[k]);
  }
  return out;
}

/**
 * Fill any missing pay-period and OT fields on each company with defaults.
 * Pay-period configuration lives per-company; the old v2 user-level settings
 * fields that once seeded these (system, startDow, semi1/2, monthlyStart,
 * anchorDate, cycleDays) have been retired, so this only fills `??` gaps.
 */
export function migrateCompanies(companies) {
  if (!Array.isArray(companies)) return companies;
  return companies.map(c => ({
    ...c,
    payFrequency:        c.payFrequency        ?? 'biweekly',
    weekStartDow:        c.weekStartDow        ?? 1,
    biweeklyStartParity: c.biweeklyStartParity ?? 'odd',
    semiFirstDay:        c.semiFirstDay        ?? null,
    semiSecondDay:       c.semiSecondDay       ?? null,
    monthlyStartDay:     c.monthlyStartDay     ?? null,
    advancedAnchorDate:  c.advancedAnchorDate  ?? null,
    advancedCycleDays:   c.advancedCycleDays   ?? null,
    isActive:            c.isActive            ?? true,
    otThreshold:         c.otThreshold         ?? 40,
    otPeriod:            c.otPeriod            ?? 'weekly',
  }));
}
