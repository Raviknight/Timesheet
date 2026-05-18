/**
 * src/data/storage.js
 *
 * Persistence abstraction. The rest of the app calls Store.get / Store.set
 * and doesn't care whether the data lives in:
 *   - Anthropic's `window.storage` (cross-device sync via Claude.ai)
 *   - The browser's `localStorage` (when opened as a plain file)
 *   - Eventually: a remote API for the multi-tenant version
 *
 * All values are JSON-serialized before storage and parsed on read.
 */

const HAS_REMOTE = typeof window !== 'undefined'
  && window.storage
  && typeof window.storage.get === 'function';

export const STORAGE_MODE = HAS_REMOTE ? 'remote' : 'local';

export const Store = {
  /** Returns `fallback` if the key doesn't exist or any error occurs. */
  async get(key, fallback) {
    if (HAS_REMOTE) {
      try {
        const r = await window.storage.get(key);
        if (r && typeof r.value === 'string') return JSON.parse(r.value);
        return fallback;
      } catch (e) {
        return fallback;
      }
    }
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  },

  async set(key, value) {
    const s = JSON.stringify(value);
    if (HAS_REMOTE) {
      try {
        await window.storage.set(key, s);
        return true;
      } catch (e) {
        console.error('storage.set failed:', key, e);
        return false;
      }
    }
    try {
      localStorage.setItem(key, s);
      return true;
    } catch (e) {
      return false;
    }
  },

  async del(key) {
    if (HAS_REMOTE) {
      try { await window.storage.delete(key); } catch (e) { /* noop */ }
    }
    try { localStorage.removeItem(key); } catch (e) { /* noop */ }
  },
};
