/**
 * src/data/storage.js
 *
 * Storage abstraction. Two backends:
 *
 *   - LocalStore: browser localStorage (works without auth)
 *   - RemoteStore: Supabase tables (requires auth)
 *
 * The exported `Store` is a dispatcher that routes calls to the
 * correct backend based on whether a user is signed in.
 *
 * In 5b.1 (this refactor), RemoteStore is a stub. 5b.2 fills it in
 * for profile/settings reads. 5b.3 adds entries. 5b.4 adds pays.
 * 5c migrates writes.
 */

import { supabase } from './supabase.js';

/**
 * Synchronous-feeling check for whether a user is signed in.
 * Reads from the session cache that Supabase's client keeps in
 * localStorage. Used by the Store dispatcher to choose a backend.
 *
 * Returns the user id (UUID) if signed in, null otherwise.
 */
export function getSignedInUserId() {
  try {
    // Supabase stores its session in localStorage under a key like
    // sb-<project-ref>-auth-token. We can read it directly.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const session = JSON.parse(raw);
        if (session?.user?.id && session?.access_token) {
          return session.user.id;
        }
      }
    }
  } catch (e) {
    // Best-effort; ignore parse errors
  }
  return null;
}

// Cache of `${userId}|${companyId}` -> member_id for the page session. A user's
// membership in a company does not change mid-session, so a plain Map is safe
// and keeps the per-row lookups in the write loops to a single query each.
const memberIdCache = new Map();

/** Short, uuid-safe prefix for logging (never log a raw id). */
function idPrefix(id) {
  return id ? String(id).slice(0, 8) : 'null';
}

/**
 * Resolve the company_members.id for the signed-in user in `companyId`. Returns
 * null when signed out, when companyId is missing, or when no membership row
 * exists. Cached for the page session. Used by the entries/pays write paths to
 * stamp member_id directly; the DB autofill trigger remains as a safety net.
 */
export async function getSignedInMemberId(companyId) {
  if (!companyId) return null;
  const userId = getSignedInUserId();
  if (!userId) return null;

  const cacheKey = `${userId}|${companyId}`;
  if (memberIdCache.has(cacheKey)) return memberIdCache.get(cacheKey);

  const { data, error } = await supabase
    .from('company_members')
    .select('id')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    console.warn(
      `[storage] member_id lookup failed (user ${idPrefix(userId)}, company ${idPrefix(companyId)})`,
      error || 'no membership row');
    return null;
  }

  memberIdCache.set(cacheKey, data.id);
  return data.id;
}

export function getStorageMode() {
  return getSignedInUserId() ? 'remote' : 'local';
}

// Backward-compat export. Dynamic, not constant.
export const STORAGE_MODE = new Proxy({}, {
  get(_, prop) {
    if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
      return () => getStorageMode();
    }
    return getStorageMode();
  }
});

// ===========================================================
// Write cache for diff-tracked remote writes
// ===========================================================
//
// Keyed by storage key. Each entry holds:
//   snapshot:  the last-loaded data shape returned by .get()
//   companyId: the active company id captured at load time
//
// Writes diff against the snapshot to send only changes.
// The cache is reset on each successful .get() of that key.
// If .set() is called for a key with no cache entry, the write
// fails (we never silently full-write without a known baseline).
const writeCache = {};

// ===========================================================================
// LocalStore — browser localStorage backed
// ===========================================================================

export const LocalStore = {
  async get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  },

  async set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  },

  async del(key) {
    try { localStorage.removeItem(key); } catch (e) { /* noop */ }
  },

  async list(prefix) {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!prefix || (k && k.startsWith(prefix))) keys.push(k);
      }
    } catch (e) { /* noop */ }
    return keys;
  },
};

// ===========================================================================
// Companies: shared row↔app-shape mapping. Used by both the read and write
// paths so the snake_case ↔ camelCase contract lives in one place.
// ===========================================================================

export function companyRowToAppShape(row) {
  return {
    id: row.id,
    name: row.name,
    payFrequency: row.pay_frequency ?? null,
    weekStartDow: row.week_start_dow ?? null,
    biweeklyStartParity: row.biweekly_start_parity ?? null,
    semiFirstDay: row.semi_first_day ?? null,
    semiSecondDay: row.semi_second_day ?? null,
    monthlyStartDay: row.monthly_start_day ?? null,
    advancedAnchorDate: row.advanced_anchor_date ?? null,
    advancedCycleDays: row.advanced_cycle_days ?? null,
    isActive: row.is_active ?? null,
    otThreshold: row.ot_threshold ?? 40,
    otPeriod: row.ot_period ?? 'weekly',
    // Per-company break + Standard Day overrides. Each null means "inherit the
    // user-level setting"; resolution happens in the resolvers, not here. Note
    // break_minutes uses ?? (not ||) so a deliberately stored 0 survives.
    breakMinutes: row.break_minutes ?? null,
    stdSeg1Start: row.std_seg1_start ?? null,
    stdSeg1End: row.std_seg1_end ?? null,
    stdSeg2Start: row.std_seg2_start ?? null,
    stdSeg2End: row.std_seg2_end ?? null,
    // Per-person cycle anchor for PTO accrual. Carried, not yet used.
    startDate: row.start_date ?? null,
  };
}

// Fields the write path is allowed to update on a companies row.
// (id is the match key; created_at / owner_user_id are not touched.)
const COMPANY_UPDATE_FIELDS = [
  ['name',                'name'],
  ['payFrequency',        'pay_frequency'],
  ['weekStartDow',        'week_start_dow'],
  ['biweeklyStartParity', 'biweekly_start_parity'],
  ['semiFirstDay',        'semi_first_day'],
  ['semiSecondDay',       'semi_second_day'],
  ['monthlyStartDay',     'monthly_start_day'],
  ['advancedAnchorDate',  'advanced_anchor_date'],
  ['advancedCycleDays',   'advanced_cycle_days'],
  ['isActive',            'is_active'],
  ['otThreshold',         'ot_threshold'],
  ['otPeriod',            'ot_period'],
  ['breakMinutes',        'break_minutes'],
  ['stdSeg1Start',        'std_seg1_start'],
  ['stdSeg1End',          'std_seg1_end'],
  ['stdSeg2Start',        'std_seg2_start'],
  ['stdSeg2End',          'std_seg2_end'],
  ['startDate',           'start_date'],
];

// Return a snake_case patch of fields that differ between newApp and oldApp,
// or null if nothing changed.
export function diffCompanyForUpdate(newApp, oldApp) {
  const patch = {};
  let changed = false;
  for (const [appKey, dbKey] of COMPANY_UPDATE_FIELDS) {
    const a = newApp[appKey] ?? null;
    const b = oldApp[appKey] ?? null;
    if (a !== b) {
      patch[dbKey] = a;
      changed = true;
    }
  }
  return changed ? patch : null;
}

// ===========================================================================
// Time-off types: shared row↔app-shape mapping + company-scoped read/write.
// The active company is addressed by SK.timeOff ('ts:timeOffTypes'); any other
// company is addressed by 'ts:timeOffTypes:<companyId>'. Both go through the
// same helpers so the model and diff logic live in one place. The write cache
// is keyed by the SAME storage key, so each company keeps its own snapshot.
// ===========================================================================

function timeOffRowToAppShape(t) {
  const obj = {
    code: t.code,
    label: t.label,
    poolDays: t.pool_days,
    hoursPerDay: t.hours_per_day,
    countsAgainstPool: t.counts_against_pool,
    sharedPoolWith: t.shared_pool_with,
    unpaid: t.unpaid,
    additive: t.additive,
    // PTO accrual config. Carried, not yet used (defaults null).
    grantStyle: t.grant_style ?? null,
    accrualAnchor: t.accrual_anchor ?? null,
    anchorDate: t.anchor_date ?? null,
    waitingDays: t.waiting_days ?? null,
    carryoverMode: t.carryover_mode ?? null,
    carryoverCap: t.carryover_cap ?? null,
  };
  if (t.pool_by_year && Object.keys(t.pool_by_year).length > 0) {
    obj.poolByYear = t.pool_by_year;
  }
  return obj;
}

function timeOffRowFromAppShape(t, companyId) {
  return {
    company_id: companyId,
    code: t.code,
    label: t.label,
    pool_days: t.poolDays || 0,
    hours_per_day: t.hoursPerDay || 8,
    counts_against_pool: !!t.countsAgainstPool,
    shared_pool_with: t.sharedPoolWith || null,
    unpaid: !!t.unpaid,
    additive: !!t.additive,
    pool_by_year: t.poolByYear || {},
    // PTO accrual config. Carried, not yet used (defaults null).
    grant_style: t.grantStyle ?? null,
    accrual_anchor: t.accrualAnchor ?? null,
    anchor_date: t.anchorDate ?? null,
    waiting_days: t.waitingDays ?? null,
    carryover_mode: t.carryoverMode ?? null,
    carryover_cap: t.carryoverCap ?? null,
  };
}

// Read one company's time_off_types and cache the snapshot under `cacheKey`.
// Returns `fallback` when the company has no rows (mirrors the original
// active-company behavior so defaults seed an empty company).
async function readTimeOffTypes(companyId, cacheKey, fallback) {
  const { data, error } = await supabase
    .from('time_off_types')
    .select('*')
    .eq('company_id', companyId);
  if (error) {
    console.error('[storage] time_off_types read failed:', error);
    return fallback;
  }

  const out = (data || []).map(timeOffRowToAppShape);
  writeCache[cacheKey] = {
    snapshot: JSON.parse(JSON.stringify(out)),
    companyId,
  };

  if ((data || []).length === 0) return fallback;
  return out;
}

// Diff `value` against the snapshot cached under `cacheKey` and apply the
// insert/update/delete to that company's time_off_types. Refuses to write
// without a load-time cache so we never full-write from an unknown baseline.
async function writeTimeOffTypes(value, cacheKey) {
  const cache = writeCache[cacheKey];
  if (!cache || !cache.companyId) {
    console.error('[storage] time_off_types write attempted without a load-time cache; refusing to write');
    return false;
  }
  const companyId = cache.companyId;
  const newSnap = value || [];
  const oldSnap = cache.snapshot || [];

  const oldByCode = {};
  for (const t of oldSnap) oldByCode[t.code] = t;
  const newByCode = {};
  for (const t of newSnap) newByCode[t.code] = t;

  const toInsert = [];
  const toUpdate = [];
  const toDelete = [];

  for (const code of Object.keys(newByCode)) {
    const newT = newByCode[code];
    const oldT = oldByCode[code];
    if (!oldT) {
      toInsert.push(timeOffRowFromAppShape(newT, companyId));
    } else if (JSON.stringify(oldT) !== JSON.stringify(newT)) {
      toUpdate.push(timeOffRowFromAppShape(newT, companyId));
    }
  }
  for (const code of Object.keys(oldByCode)) {
    if (!newByCode[code]) toDelete.push(code);
  }

  if (toInsert.length === 0 && toUpdate.length === 0 && toDelete.length === 0) {
    return true;
  }

  if (toInsert.length > 0) {
    const { error: insertErr } = await supabase
      .from('time_off_types')
      .insert(toInsert);
    if (insertErr) {
      console.error('[storage] time_off_types insert failed:', insertErr);
      return false;
    }
  }

  for (const row of toUpdate) {
    const { error: updateErr } = await supabase
      .from('time_off_types')
      .update({
        label: row.label,
        pool_days: row.pool_days,
        hours_per_day: row.hours_per_day,
        counts_against_pool: row.counts_against_pool,
        shared_pool_with: row.shared_pool_with,
        unpaid: row.unpaid,
        additive: row.additive,
        pool_by_year: row.pool_by_year,
        grant_style: row.grant_style,
        accrual_anchor: row.accrual_anchor,
        anchor_date: row.anchor_date,
        waiting_days: row.waiting_days,
        carryover_mode: row.carryover_mode,
        carryover_cap: row.carryover_cap,
      })
      .eq('company_id', row.company_id)
      .eq('code', row.code);
    if (updateErr) {
      console.error('[storage] time_off_types update failed:', updateErr);
      return false;
    }
  }

  for (const code of toDelete) {
    const { error: deleteErr } = await supabase
      .from('time_off_types')
      .delete()
      .eq('company_id', companyId)
      .eq('code', code);
    if (deleteErr) {
      console.error('[storage] time_off_types delete failed:', deleteErr);
      return false;
    }
  }

  // Refresh cache from server to keep the snapshot accurate.
  const { data: refreshed } = await supabase
    .from('time_off_types')
    .select('*')
    .eq('company_id', companyId);
  writeCache[cacheKey] = {
    snapshot: JSON.parse(JSON.stringify((refreshed || []).map(timeOffRowToAppShape))),
    companyId,
  };

  return true;
}

// ===========================================================================
// Entries: company-scoped read/write. The active company is addressed by
// SK.entries ('ts:entries'); any other company by 'ts:entries:<companyId>'.
// Both go through the same helpers so the diff/reassignment logic lives in one
// place. The write cache is keyed by the SAME storage key, so each company
// keeps its own snapshot. Mirrors the time_off_types helpers above.
// ===========================================================================

// Read one company's entries (keyed by date) and cache the snapshot under
// `cacheKey`. Returns `fallback` when the company has no rows.
async function readEntries(companyId, cacheKey, fallback) {
  const { data, error } = await supabase
    .from('entries')
    .select('date, segments, time_off, notes, company_id, status, booked_at, created_at')
    .eq('company_id', companyId);
  if (error) {
    console.error('[storage] entries read failed:', error);
    return fallback;
  }

  const out = {};
  for (const row of (data || [])) {
    out[row.date] = {
      date: row.date,
      segments: row.segments || [],
      timeOff: row.time_off,
      notes: row.notes,
      // Carry the entry's own company so the editor can show and preserve it.
      // Scoped reads only return this company, so it equals companyId here,
      // but storing it keeps the write path's explicit-company choice
      // authoritative.
      companyId: row.company_id,
      // PTO booking fields. created_at is DB-managed and read-only here: it is
      // exposed on read but never written back (see the upsert payload below).
      status: row.status ?? null,
      bookedAt: row.booked_at ?? null,
      createdAt: row.created_at ?? null,
    };
  }

  // Cache a deep snapshot so later mutations to `out` by the UI don't poison
  // the diff baseline.
  writeCache[cacheKey] = {
    snapshot: JSON.parse(JSON.stringify(out)),
    companyId,
  };

  if ((data || []).length === 0) return fallback;
  return out;
}

// Diff `value` (entries keyed by date) against the snapshot cached under
// `cacheKey` and apply the upsert/delete to that company's entries. Refuses to
// write without a load-time cache so we never full-write from an unknown
// baseline.
async function writeEntries(value, cacheKey, userId) {
  const cache = writeCache[cacheKey];
  if (!cache || !cache.companyId) {
    console.error('[storage] entries write attempted without a load-time cache; refusing to write');
    return false;
  }
  const companyId = cache.companyId;
  const oldSnap = cache.snapshot || {};
  const newSnap = value || {};

  // Diff
  const toUpsert = [];
  const toDelete = [];
  // Entries that moved to a different company: the row under the OLD company
  // must be removed so the entry doesn't linger there.
  const toReassignDelete = [];
  for (const date of Object.keys(newSnap)) {
    const oldRow = oldSnap[date];
    const newRow = newSnap[date];
    if (!oldRow) {
      toUpsert.push(newRow);
    } else if (JSON.stringify(oldRow) !== JSON.stringify(newRow)) {
      toUpsert.push(newRow);
      const oldCompany = oldRow.companyId || companyId;
      const newCompany = newRow.companyId || companyId;
      if (oldCompany !== newCompany) {
        toReassignDelete.push({ date, company: oldCompany });
      }
    }
  }
  for (const date of Object.keys(oldSnap)) {
    if (!newSnap[date]) toDelete.push(date);
  }

  if (toUpsert.length === 0 && toDelete.length === 0) {
    // No changes; nothing to do
    return true;
  }

  // Upserts: rely on the (user_id, company_id, date) unique constraint for
  // conflict resolution. Map app shape to DB shape. The entry's explicit
  // company is authoritative; companyId (the scoped company captured at load)
  // only fills in when the entry has none.
  if (toUpsert.length > 0) {
    const rows = [];
    for (const e of toUpsert) {
      const rowCompanyId = e.companyId || companyId;
      rows.push({
        user_id: userId,
        company_id: rowCompanyId,
        date: e.date,
        segments: e.segments || [],
        time_off: e.timeOff || null,
        notes: e.notes || null,
        status: e.status ?? null,
        booked_at: e.bookedAt ?? null,
        // Stamp member_id directly (cached lookup); the autofill trigger stays
        // as a safety net for any row that arrives with it null.
        member_id: await getSignedInMemberId(rowCompanyId),
        // created_at is intentionally omitted: it stays DB-default managed.
      });
    }
    const { error: upsertErr } = await supabase
      .from('entries')
      .upsert(rows, { onConflict: 'user_id,company_id,date' });
    if (upsertErr) {
      console.error('[storage] entries upsert failed:', upsertErr);
      return false;
    }
  }

  for (const r of toReassignDelete) {
    const { error: reassignErr } = await supabase
      .from('entries')
      .delete()
      .eq('user_id', userId)
      .eq('company_id', r.company)
      .eq('date', r.date);
    if (reassignErr) {
      console.error('[storage] entries reassign delete failed:', reassignErr);
      return false;
    }
  }

  if (toDelete.length > 0) {
    const { error: deleteErr } = await supabase
      .from('entries')
      .delete()
      .eq('user_id', userId)
      .eq('company_id', companyId)
      .in('date', toDelete);
    if (deleteErr) {
      console.error('[storage] entries delete failed:', deleteErr);
      return false;
    }
  }

  // Success: update the cache snapshot to the new baseline.
  writeCache[cacheKey] = {
    snapshot: JSON.parse(JSON.stringify(newSnap)),
    companyId,
  };
  return true;
}

// ===========================================================================
// RemoteStore — Supabase backed (stub in 5b.1, filled in 5b.2+)
// ===========================================================================

export const RemoteStore = {
  async get(key, fallback) {
    try {
      if (key === 'ts:profile') {
        const { data, error } = await supabase
          .from('profiles')
          .select('*')
          .maybeSingle();
        if (error) {
          console.error('[storage] profile read failed:', error);
          return fallback;
        }
        if (!data) return fallback;
        // Map DB shape to app shape (camelCase, expected fields)
        return {
          userId: data.user_id,
          name: data.name,
          role: data.role,
          companyId: data.active_company_id,
        };
      }

      if (key === 'ts:settings') {
        const { data, error } = await supabase
          .from('settings')
          .select('data')
          .maybeSingle();
        if (error) {
          console.error('[storage] settings read failed:', error);
          return fallback;
        }
        if (!data) return fallback;  // No settings row yet, use defaults
        return data.data;  // settings.data is JSONB
      }

      if (key === 'ts:companies') {
        const { data, error } = await supabase
          .from('companies')
          .select(
            'id, name, pay_frequency, week_start_dow, biweekly_start_parity,' +
            ' semi_first_day, semi_second_day, monthly_start_day,' +
            ' advanced_anchor_date, advanced_cycle_days, is_active,' +
            ' ot_threshold, ot_period, break_minutes,' +
            ' std_seg1_start, std_seg1_end, std_seg2_start, std_seg2_end,' +
            ' start_date'
          );
        if (error) {
          console.error('[storage] companies read failed:', error);
          return fallback;
        }
        const out = (data || []).map(companyRowToAppShape);
        writeCache['ts:companies'] = {
          snapshot: JSON.parse(JSON.stringify(out)),
        };
        if (out.length === 0) return fallback;
        return out;
      }

      if (key === 'ts:timeOffTypes') {
        const { data: profile } = await supabase
          .from('profiles')
          .select('active_company_id')
          .maybeSingle();
        const companyId = profile?.active_company_id || null;
        if (!companyId) {
          console.error('[storage] time_off_types read: no active_company_id on profile');
          writeCache['ts:timeOffTypes'] = { snapshot: [], companyId: null };
          return fallback;
        }
        return readTimeOffTypes(companyId, 'ts:timeOffTypes', fallback);
      }

      // Per-company time-off, addressed by 'ts:timeOffTypes:<companyId>'. Used
      // by the Settings editor to read any active company without disturbing
      // the active-company cache that feeds the pay math.
      if (key.startsWith('ts:timeOffTypes:')) {
        const companyId = key.slice('ts:timeOffTypes:'.length);
        if (!companyId) return fallback;
        return readTimeOffTypes(companyId, key, fallback);
      }

      if (key === 'ts:entries') {
        // Fetch active_company_id first so we can scope the read and
        // tag the write cache. Single source of truth: the profiles row.
        const { data: profile } = await supabase
          .from('profiles')
          .select('active_company_id')
          .maybeSingle();
        const companyId = profile?.active_company_id || null;
        if (!companyId) {
          console.error('[storage] entries read: no active_company_id on profile');
          writeCache['ts:entries'] = { snapshot: {}, companyId: null };
          return fallback;
        }
        return readEntries(companyId, 'ts:entries', fallback);
      }

      // Per-company entries, addressed by 'ts:entries:<companyId>'. Used by the
      // per-company entries load to read any active company without disturbing
      // the active-company cache that feeds state.entries.
      if (key.startsWith('ts:entries:')) {
        const companyId = key.slice('ts:entries:'.length);
        if (!companyId) return fallback;
        return readEntries(companyId, key, fallback);
      }

      if (key === 'ts:pays') {
        // Need company_id alongside company_name so the diff can match
        // existing rows on upsert.
        const { data, error } = await supabase
          .from('pays')
          .select('company_id, date, gross, take_home, hours, company_name');
        if (error) {
          console.error('[storage] pays read failed:', error);
          return fallback;
        }

        const out = [];
        if (data) {
          for (const row of data) {
            out.push({
              date: row.date,
              company: row.company_name,
              gross: row.gross,
              takeHome: row.take_home,
              hours: row.hours,
              // Internal-only fields, used by the diff. UI ignores them.
              _companyId: row.company_id,
            });
          }
        }

        // Cache deep snapshot for diff-tracking on write
        writeCache['ts:pays'] = {
          snapshot: JSON.parse(JSON.stringify(out)),
        };

        if (data && data.length === 0) return fallback;
        return out;
      }

      if (key === 'ts:schemaVersion') {
        // No-op in remote mode; schema is enforced server-side
        return null;
      }

      // Not yet implemented (entries, pays, etc.)
      console.warn('[storage] RemoteStore.get not yet implemented for:', key);
      return fallback;
    } catch (e) {
      console.error('[storage] RemoteStore.get unexpected error for ' + key + ':', e);
      return fallback;
    }
  },

  async set(key, value) {
    try {
      if (key === 'ts:profile') {
        const userId = getSignedInUserId();
        if (!userId) {
          console.error('[storage] profile write attempted while signed out');
          return false;
        }
        // value is the app-shape profile object
        const { error } = await supabase
          .from('profiles')
          .upsert({
            user_id: userId,
            name: value.name,
            role: value.role,
            active_company_id: value.companyId,
          }, { onConflict: 'user_id' });
        if (error) {
          console.error('[storage] profile write failed:', error);
          return false;
        }
        return true;
      }

      if (key === 'ts:settings') {
        const userId = getSignedInUserId();
        if (!userId) {
          console.error('[storage] settings write attempted while signed out');
          return false;
        }
        const { error } = await supabase
          .from('settings')
          .upsert({
            user_id: userId,
            data: value,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' });
        if (error) {
          console.error('[storage] settings write failed:', error);
          return false;
        }
        return true;
      }

      if (key === 'ts:entries') {
        const userId = getSignedInUserId();
        if (!userId) {
          console.error('[storage] entries write attempted while signed out');
          return false;
        }
        return writeEntries(value, 'ts:entries', userId);
      }

      // Per-company entries write, addressed by 'ts:entries:<companyId>'. Diffs
      // against that company's own cached snapshot; never touches the
      // active-company cache.
      if (key.startsWith('ts:entries:')) {
        const userId = getSignedInUserId();
        if (!userId) {
          console.error('[storage] entries write attempted while signed out');
          return false;
        }
        return writeEntries(value, key, userId);
      }

      if (key === 'ts:pays') {
        const userId = getSignedInUserId();
        if (!userId) {
          console.error('[storage] pays write attempted while signed out');
          return false;
        }
        const cache = writeCache['ts:pays'];
        if (!cache) {
          console.error('[storage] pays write attempted without a load-time cache; refusing to write');
          return false;
        }

        // Need active_company_id for the "— Other —" fallback case.
        const { data: profile } = await supabase
          .from('profiles')
          .select('active_company_id')
          .maybeSingle();
        const activeCompanyId = profile?.active_company_id || null;

        // Build a name → id lookup from companies loaded at boot.
        // We need to query companies fresh here since storage.js does
        // not hold a reference to app state.companies.
        const { data: companiesRows, error: companiesErr } = await supabase
          .from('companies')
          .select('id, name');
        if (companiesErr) {
          console.error('[storage] pays write: companies lookup failed:', companiesErr);
          return false;
        }
        const nameToId = {};
        for (const c of (companiesRows || [])) {
          nameToId[c.name] = c.id;
        }

        // Resolve each new pay's company_id. If company is '' or
        // unrecognized, fall back to activeCompanyId.
        function resolveCompanyId(payCompanyName) {
          if (payCompanyName && nameToId[payCompanyName]) {
            return nameToId[payCompanyName];
          }
          return activeCompanyId;
        }

        const newSnap = value || [];
        const oldSnap = cache.snapshot || [];

        // Build keyed lookups for diff. Composite key: companyId|date
        // (mirrors the unique constraint).
        function keyOf(pay, resolvedCompanyId) {
          return `${resolvedCompanyId || 'NULL'}|${pay.date}`;
        }

        // Index old snap by its stored _companyId|date
        const oldByKey = {};
        for (const p of oldSnap) {
          oldByKey[keyOf(p, p._companyId)] = p;
        }

        // Index new pays by their resolved companyId|date
        const newByKey = {};
        for (const p of newSnap) {
          const cid = resolveCompanyId(p.company);
          newByKey[keyOf(p, cid)] = { pay: p, companyId: cid };
        }

        const toInsert = [];
        const toUpdate = [];
        const toDelete = [];

        for (const k of Object.keys(newByKey)) {
          const { pay, companyId } = newByKey[k];
          if (!companyId) {
            console.error('[storage] pays write: cannot resolve company_id for pay', pay);
            return false;
          }
          const oldRow = oldByKey[k];
          if (!oldRow) {
            // New row
            toInsert.push({
              user_id: userId,
              company_id: companyId,
              company_name: pay.company || (companiesRows.find(c => c.id === companyId)?.name || ''),
              date: pay.date,
              gross: pay.gross || 0,
              take_home: pay.takeHome || 0,
              hours: pay.hours || 0,
              // Stamp member_id directly (cached lookup); the autofill trigger
              // stays as a safety net. Update/delete paths still match on
              // user_id and flip in a later chunk.
              member_id: await getSignedInMemberId(companyId),
            });
          } else {
            // Existing row — check if any tracked field changed.
            const changed =
              (oldRow.gross || 0)    !== (pay.gross || 0) ||
              (oldRow.takeHome || 0) !== (pay.takeHome || 0) ||
              (oldRow.hours || 0)    !== (pay.hours || 0);
            if (changed) {
              toUpdate.push({
                user_id: userId,
                company_id: companyId,
                date: pay.date,
                gross: pay.gross || 0,
                take_home: pay.takeHome || 0,
                hours: pay.hours || 0,
                // NOTE: company_name intentionally omitted so a renamed
                // company does not retroactively rewrite history.
              });
            }
          }
        }

        for (const k of Object.keys(oldByKey)) {
          if (!newByKey[k]) {
            const oldRow = oldByKey[k];
            toDelete.push({
              company_id: oldRow._companyId,
              date: oldRow.date,
            });
          }
        }

        if (toInsert.length === 0 && toUpdate.length === 0 && toDelete.length === 0) {
          return true;
        }

        // Inserts: pure insert (company_name set).
        if (toInsert.length > 0) {
          const { error: insertErr } = await supabase
            .from('pays')
            .insert(toInsert);
          if (insertErr) {
            console.error('[storage] pays insert failed:', insertErr);
            return false;
          }
        }

        // Updates: match on (user_id, company_id, date), update the
        // mutable fields only. company_name not touched.
        for (const u of toUpdate) {
          const { error: updateErr } = await supabase
            .from('pays')
            .update({
              gross: u.gross,
              take_home: u.take_home,
              hours: u.hours,
            })
            .eq('user_id', u.user_id)
            .eq('company_id', u.company_id)
            .eq('date', u.date);
          if (updateErr) {
            console.error('[storage] pays update failed:', updateErr);
            return false;
          }
        }

        // Deletes
        for (const d of toDelete) {
          const { error: deleteErr } = await supabase
            .from('pays')
            .delete()
            .eq('user_id', userId)
            .eq('company_id', d.company_id)
            .eq('date', d.date);
          if (deleteErr) {
            console.error('[storage] pays delete failed:', deleteErr);
            return false;
          }
        }

        // Refresh cache: re-fetch from server so _companyId tags are
        // accurate for the next diff. Simpler than trying to reconstruct
        // the snapshot in-memory with all the new ids.
        const { data: refreshed } = await supabase
          .from('pays')
          .select('company_id, date, gross, take_home, hours, company_name');
        const refreshedShape = (refreshed || []).map(row => ({
          date: row.date,
          company: row.company_name,
          gross: row.gross,
          takeHome: row.take_home,
          hours: row.hours,
          _companyId: row.company_id,
        }));
        writeCache['ts:pays'] = {
          snapshot: JSON.parse(JSON.stringify(refreshedShape)),
        };

        return true;
      }

      if (key === 'ts:timeOffTypes') {
        return writeTimeOffTypes(value, 'ts:timeOffTypes');
      }

      // Per-company time-off write, addressed by 'ts:timeOffTypes:<companyId>'.
      // Diffs against that company's own cached snapshot; never touches the
      // active-company cache.
      if (key.startsWith('ts:timeOffTypes:')) {
        return writeTimeOffTypes(value, key);
      }

      if (key === 'ts:companies') {
        // Diff-tracked UPDATE only. Inserts/deletes are deferred to a
        // later phase (companies are created by bootstrap; deletion is
        // a destructive flow that needs its own UI + confirmation).
        const cache = writeCache['ts:companies'];
        if (!cache) {
          console.error('[storage] companies write attempted without a load-time cache; refusing to write');
          return false;
        }
        const oldSnap = cache.snapshot || [];
        const newSnap = value || [];

        const oldById = {};
        for (const c of oldSnap) oldById[c.id] = c;

        const updates = [];
        for (const c of newSnap) {
          const oldRow = oldById[c.id];
          if (!oldRow) continue;  // new company — INSERT path not implemented here
          const patch = diffCompanyForUpdate(c, oldRow);
          if (patch) updates.push({ id: c.id, patch });
        }

        if (updates.length === 0) return true;

        for (const u of updates) {
          const { error: updateErr } = await supabase
            .from('companies')
            .update(u.patch)
            .eq('id', u.id);
          if (updateErr) {
            console.error('[storage] companies update failed:', updateErr);
            return false;
          }
        }

        // Refresh the snapshot from server so subsequent diffs see the
        // post-write baseline. Mirrors the entries/pays pattern.
        const { data: refreshed } = await supabase
          .from('companies')
          .select(
            'id, name, pay_frequency, week_start_dow, biweekly_start_parity,' +
            ' semi_first_day, semi_second_day, monthly_start_day,' +
            ' advanced_anchor_date, advanced_cycle_days, is_active,' +
            ' ot_threshold, ot_period, break_minutes,' +
            ' std_seg1_start, std_seg1_end, std_seg2_start, std_seg2_end,' +
            ' start_date'
          );
        writeCache['ts:companies'] = {
          snapshot: JSON.parse(JSON.stringify((refreshed || []).map(companyRowToAppShape))),
        };
        return true;
      }

      // Skip writes for read-only / server-enforced keys.
      if (key === 'ts:schemaVersion') {
        return true;
      }

      // Any other key has no remote write path yet.
      console.warn('[storage] RemoteStore.set not yet implemented for:', key);
      return false;
    } catch (e) {
      console.error('[storage] RemoteStore.set unexpected error for ' + key + ':', e);
      return false;
    }
  },

  async del(key) {
    console.warn('[storage] RemoteStore.del not yet implemented for:', key);
  },

  async list(prefix) {
    return [];
  },
};

// ===========================================================================
// Store dispatcher
// ===========================================================================

function pick() {
  return getStorageMode() === 'remote' ? RemoteStore : LocalStore;
}

export const Store = {
  get(key, fallback) {
    return pick().get(key, fallback);
  },
  set(key, value) {
    return pick().set(key, value);
  },
  del(key) {
    return pick().del(key);
  },
  list(prefix) {
    return pick().list(prefix);
  },
};
