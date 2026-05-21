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

export const SCHEMA_VERSION = 2;

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

export const DEFAULT_PROFILE = {
  userId: 'me',
  name: 'You',
  role: 'owner',       // owner | employee | supervisor | admin
  companyId: null,
};

export const DEFAULT_SETTINGS = {
  // Pay period config
  system: 'biweekly',        // weekly | biweekly | semimonthly | monthly | advanced
  startDow: 1,               // 0=Sun..6=Sat (weekly + biweekly)
  biweeklyRef: '2025-12-29', // reference period start
  semi1: 1,                  // semi-monthly first day-of-month
  semi2: 16,                 // semi-monthly second day-of-month
  monthlyStart: 1,           // monthly day-of-month
  anchorDate: '2025-12-29',  // advanced mode
  cycleDays: 14,             // advanced mode

  // Calculation rules
  otThreshold: 40,           // hours/week before OT kicks in
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
