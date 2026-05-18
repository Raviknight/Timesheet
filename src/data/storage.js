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
function getSignedInUserId() {
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
          .select('id, name');
        if (error) {
          console.error('[storage] companies read failed:', error);
          return fallback;
        }
        if (!data || data.length === 0) return fallback;
        return data.map(c => ({ id: c.id, name: c.name }));
      }

      if (key === 'ts:timeOffTypes') {
        // Get the user's active_company_id first, then fetch types
        // for that company. (Two-step because we don't have a JOIN
        // helper in postgrest-js for this case.)
        const { data: profile } = await supabase
          .from('profiles')
          .select('active_company_id')
          .maybeSingle();
        if (!profile?.active_company_id) return fallback;

        const { data, error } = await supabase
          .from('time_off_types')
          .select('*')
          .eq('company_id', profile.active_company_id);
        if (error) {
          console.error('[storage] time_off_types read failed:', error);
          return fallback;
        }
        if (!data || data.length === 0) return fallback;
        return data.map(t => ({
          code: t.code,
          label: t.label,
          poolDays: t.pool_days,
          hoursPerDay: t.hours_per_day,
          countsAgainstPool: t.counts_against_pool,
          sharedPoolWith: t.shared_pool_with,
          unpaid: t.unpaid,
        }));
      }

      if (key === 'ts:entries') {
        const { data, error } = await supabase
          .from('entries')
          .select('date, segments, time_off, notes');
        if (error) {
          console.error('[storage] entries read failed:', error);
          return fallback;
        }
        if (!data || data.length === 0) return fallback;
        // Convert array of rows to object keyed by date (legacy format)
        const out = {};
        for (const row of data) {
          out[row.date] = {
            date: row.date,
            segments: row.segments || [],
            timeOff: row.time_off,
            notes: row.notes,
          };
        }
        return out;
      }

      if (key === 'ts:pays') {
        const { data, error } = await supabase
          .from('pays')
          .select('date, gross, take_home, hours, company_name');
        if (error) {
          console.error('[storage] pays read failed:', error);
          return fallback;
        }
        if (!data || data.length === 0) return fallback;
        return data.map(row => ({
          date: row.date,
          gross: row.gross,
          takeHome: row.take_home,
          hours: row.hours,
          company: row.company_name,
        }));
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

      // Skip writes for read-only or bootstrap-managed keys
      if (key === 'ts:companies' || key === 'ts:timeOffTypes' || key === 'ts:schemaVersion') {
        // No-op: these are managed by bootstrap, not client writes.
        // 5c.4 may revisit this if companies/types editing is needed.
        return true;
      }

      // Entries and pays still pending (5c.2 and 5c.3)
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
