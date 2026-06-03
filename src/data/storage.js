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
            ' advanced_anchor_date, advanced_cycle_days'
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

        const { data, error } = await supabase
          .from('time_off_types')
          .select('*')
          .eq('company_id', companyId);
        if (error) {
          console.error('[storage] time_off_types read failed:', error);
          return fallback;
        }

        const out = (data || []).map(t => {
          const obj = {
            code: t.code,
            label: t.label,
            poolDays: t.pool_days,
            hoursPerDay: t.hours_per_day,
            countsAgainstPool: t.counts_against_pool,
            sharedPoolWith: t.shared_pool_with,
            unpaid: t.unpaid,
            additive: t.additive,
          };
          if (t.pool_by_year && Object.keys(t.pool_by_year).length > 0) {
            obj.poolByYear = t.pool_by_year;
          }
          return obj;
        });

        writeCache['ts:timeOffTypes'] = {
          snapshot: JSON.parse(JSON.stringify(out)),
          companyId,
        };

        if ((data || []).length === 0) return fallback;
        return out;
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

        const { data, error } = await supabase
          .from('entries')
          .select('date, segments, time_off, notes')
          .eq('company_id', companyId);
        if (error) {
          console.error('[storage] entries read failed:', error);
          return fallback;
        }

        const out = {};
        if (data) {
          for (const row of data) {
            out[row.date] = {
              date: row.date,
              segments: row.segments || [],
              timeOff: row.time_off,
              notes: row.notes,
            };
          }
        }

        // Cache a deep snapshot so later mutations to `out` by the UI
        // don't poison the diff baseline.
        writeCache['ts:entries'] = {
          snapshot: JSON.parse(JSON.stringify(out)),
          companyId,
        };

        if (data && data.length === 0) return fallback;
        return out;
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
        const cache = writeCache['ts:entries'];
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
        for (const date of Object.keys(newSnap)) {
          const oldRow = oldSnap[date];
          const newRow = newSnap[date];
          if (!oldRow) {
            toUpsert.push(newRow);
          } else if (JSON.stringify(oldRow) !== JSON.stringify(newRow)) {
            toUpsert.push(newRow);
          }
        }
        for (const date of Object.keys(oldSnap)) {
          if (!newSnap[date]) toDelete.push(date);
        }

        if (toUpsert.length === 0 && toDelete.length === 0) {
          // No changes; nothing to do
          return true;
        }

        // Upserts: rely on the (user_id, company_id, date) unique
        // constraint for conflict resolution. Map app shape to DB shape.
        if (toUpsert.length > 0) {
          const rows = toUpsert.map(e => ({
            user_id: userId,
            company_id: companyId,
            date: e.date,
            segments: e.segments || [],
            time_off: e.timeOff || null,
            notes: e.notes || null,
          }));
          const { error: upsertErr } = await supabase
            .from('entries')
            .upsert(rows, { onConflict: 'user_id,company_id,date' });
          if (upsertErr) {
            console.error('[storage] entries upsert failed:', upsertErr);
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
        writeCache['ts:entries'] = {
          snapshot: JSON.parse(JSON.stringify(newSnap)),
          companyId,
        };
        return true;
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
        const cache = writeCache['ts:timeOffTypes'];
        if (!cache || !cache.companyId) {
          console.error('[storage] time_off_types write attempted without a load-time cache; refusing to write');
          return false;
        }
        const companyId = cache.companyId;
        const newSnap = value || [];
        const oldSnap = cache.snapshot || [];

        const oldByCode = {};
        for (const t of oldSnap) {
          oldByCode[t.code] = t;
        }
        const newByCode = {};
        for (const t of newSnap) {
          newByCode[t.code] = t;
        }

        const toInsert = [];
        const toUpdate = [];
        const toDelete = [];

        function rowFromAppShape(t) {
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
          };
        }

        for (const code of Object.keys(newByCode)) {
          const newT = newByCode[code];
          const oldT = oldByCode[code];
          if (!oldT) {
            toInsert.push(rowFromAppShape(newT));
          } else if (JSON.stringify(oldT) !== JSON.stringify(newT)) {
            toUpdate.push(rowFromAppShape(newT));
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

        // Refresh cache from server to keep snapshot accurate.
        const { data: refreshed } = await supabase
          .from('time_off_types')
          .select('*')
          .eq('company_id', companyId);
        const refreshedShape = (refreshed || []).map(t => {
          const obj = {
            code: t.code,
            label: t.label,
            poolDays: t.pool_days,
            hoursPerDay: t.hours_per_day,
            countsAgainstPool: t.counts_against_pool,
            sharedPoolWith: t.shared_pool_with,
            unpaid: t.unpaid,
            additive: t.additive,
          };
          if (t.pool_by_year && Object.keys(t.pool_by_year).length > 0) {
            obj.poolByYear = t.pool_by_year;
          }
          return obj;
        });
        writeCache['ts:timeOffTypes'] = {
          snapshot: JSON.parse(JSON.stringify(refreshedShape)),
          companyId,
        };

        return true;
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
            ' advanced_anchor_date, advanced_cycle_days'
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
