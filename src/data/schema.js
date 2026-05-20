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

export const SCHEMA_VERSION = 1;

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
  { code: 'PTO',     label: 'PTO',     poolDays: 11, countsAgainstPool: true,  hoursPerDay: 8 },
  { code: 'SICK',    label: 'Sick',    poolDays: 0,  countsAgainstPool: true,  hoursPerDay: 8, sharedPoolWith: 'PTO' },
  { code: 'HOLIDAY', label: 'Holiday', poolDays: 0,  countsAgainstPool: false, hoursPerDay: 8 },
  { code: 'UNPAID',  label: 'Unpaid',  poolDays: 0,  countsAgainstPool: false, hoursPerDay: 8, unpaid: true },
];

/**
 * Migrate a stored entry from any older shape to the current shape.
 * Currently we only have one shape transition: legacy flat fields to
 * segments[] (introduced when multi-segment days were added).
 */
export function migrateEntry(e) {
  if (!e) return e;
  if (Array.isArray(e.segments)) return e;

  const hasTimes = e.clockIn || e.clockOut || e.breakStart || e.breakEnd;
  if (hasTimes) {
    return {
      date: e.date,
      segments: [{
        clockIn: e.clockIn || null,
        clockOut: e.clockOut || null,
        breakStart: e.breakStart || null,
        breakEnd: e.breakEnd || null,
      }],
      timeOff: e.timeOff || null,
      notes: e.notes || null,
    };
  }

  return {
    date: e.date,
    segments: [],
    timeOff: e.timeOff || null,
    notes: e.notes || null,
  };
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
