/**
 * src/ui/topbar.js
 *
 * Top bar: name + role + sync indicator. Sync indicator state is updated
 * from data/storage.js via the public functions here.
 */

import { STORAGE_MODE } from '../data/storage.js';

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
  setSync('', STORAGE_MODE === 'remote' ? 'synced' : 'saved locally');
}
