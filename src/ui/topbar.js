/**
 * src/ui/topbar.js
 *
 * Top bar: name + role + sync indicator. Sync indicator state is updated
 * from data/storage.js via the public functions here.
 */

import { STORAGE_MODE, isServingStaleData } from '../data/storage.js';

export function renderTopBar(profile) {
  const nameEl = document.getElementById('userName');
  const roleEl = document.getElementById('userRole');
  if (nameEl) nameEl.textContent = profile.name || 'You';
  if (roleEl) roleEl.textContent = profile.role || 'owner';
}

/** @param {'syncing'|'error'|''} status */
export function setSync(status, text) {
  const el = document.getElementById('syncStatus');
  const txt = document.getElementById('syncText');
  if (!el || !txt) return;
  el.className = 'sync-status' + (status ? ' ' + status : '');
  txt.textContent = text;
}

export function setSyncIdle() {
  // A remote session serving data from the offline mirror must not read as
  // "synced". The data on screen is the last known good copy, and writes are
  // refused until a fresh read succeeds, so say so plainly.
  if (STORAGE_MODE === 'remote' && isServingStaleData()) {
    setSync('error', 'offline, showing saved copy');
    return;
  }
  setSync('', STORAGE_MODE === 'remote' ? 'synced' : 'saved locally');
}
