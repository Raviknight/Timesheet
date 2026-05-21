/**
 * src/app.js
 *
 * Top-level entry. Boots the app:
 *   1. Load saved state from storage (or seed if first run)
 *   2. Render top bar
 *   3. Wire up tabs, modals, and per-view handlers
 *   4. Switch to the default landing view
 */

import { Store, STORAGE_MODE, getStorageMode } from './data/storage.js';
import {
  SK, SCHEMA_VERSION,
  DEFAULT_PROFILE, DEFAULT_SETTINGS, DEFAULT_TIME_OFF_TYPES,
  migrateEntries, migrateCompanies,
} from './data/schema.js';
import { SEED_ENTRIES, SEED_PAYS, SEED_COMPANIES } from './data/seed.js';
import { ensureBootstrapped } from './data/bootstrap.js';

import { renderTopBar, setSync, setSyncIdle } from './ui/topbar.js';
import { toast } from './ui/toast.js';
import { wireTabs, switchView } from './ui/tabs.js';
import { wireDashboard, renderDashboard } from './ui/dashboard.js';
import { wireLog, renderLog } from './ui/log.js';
import { wirePaychecks, renderPaychecks } from './ui/paychecks.js';
import { wireSettings, renderSettings } from './ui/settings.js';

import { initEntryModal } from './modals/entryModal.js';
import { initPayModal } from './modals/payModal.js';

import { onAuthChange, signOut } from './auth/session.js';
import { renderAuth, wireAuth } from './ui/auth.js';

// Captured at boot. True if the app started with a Supabase
// session. Used to detect mid-session token loss (e.g., user
// signed out in another tab) and avoid silent fallback to
// local storage.
let bootedRemote = false;

/** Single in-memory state object. UI modules read from here directly. */
const state = {
  profile: { ...DEFAULT_PROFILE },
  settings: { ...DEFAULT_SETTINGS },
  timeOffTypes: JSON.parse(JSON.stringify(DEFAULT_TIME_OFF_TYPES)),
  companies: [],
  entries: {},
  pays: [],
  ui: {
    currentView: 'dashboard',
    logYear: new Date().getFullYear(),
    payYearFilter: 'all',
    ppMode: 'current',
    ppOtherDate: null,
  },
};

async function saveAll() {
  if (bootedRemote && getStorageMode() === 'local') {
    await handleSessionExpired();
    return;
  }

  setSync('syncing', 'saving...');
  const writes = [
    { key: SK.profile,    value: state.profile },
    { key: SK.settings,   value: state.settings },
    { key: SK.timeOff,    value: state.timeOffTypes },
    { key: SK.companies,  value: state.companies },
    { key: SK.entries,    value: state.entries },
    { key: SK.pays,       value: state.pays },
    { key: SK.schema,     value: SCHEMA_VERSION },
  ];

  const results = await Promise.all(
    writes.map(async w => {
      try {
        const ok = await Store.set(w.key, w.value);
        return { key: w.key, ok };
      } catch (e) {
        console.error(`Store.set threw for ${w.key}:`, e);
        return { key: w.key, ok: false };
      }
    })
  );

  const failed = results.filter(r => r.ok === false).map(r => r.key);

  if (failed.length === 0) {
    setSyncIdle();
    return;
  }

  // One or more writes failed. Show a toast and reload from store
  // so the UI reflects what is actually persisted.
  setSync('error', 'save error');
  const friendlyNames = failed.map(k => {
    if (k === SK.profile) return 'profile';
    if (k === SK.settings) return 'settings';
    if (k === SK.timeOff) return 'time off types';
    if (k === SK.companies) return 'companies';
    if (k === SK.entries) return 'entries';
    if (k === SK.pays) return 'paychecks';
    if (k === SK.schema) return 'schema';
    return k;
  });
  toast('Save failed for: ' + friendlyNames.join(', ') + '. Reloading from server.');

  try {
    await loadAll();
    rerender();
    setSyncIdle();
  } catch (e) {
    console.error('Revert reload failed:', e);
    setSync('error', 'reload failed');
  }
}

/**
 * Save one state key to the store. If the write fails, show a toast
 * naming what failed, reload from the store, and re-render so the UI
 * matches what is actually persisted.
 *
 * Returns true on success, false on failure. Callers should check
 * the return and skip their own success toast / close logic if false.
 */
async function saveKey(key, value, friendlyName) {
  // Detect mid-session token loss before writing. If the app
  // booted remote but storage now reports local, the Supabase
  // session was cleared (e.g., signed out in another tab).
  // Do not silently fall back to localStorage.
  if (bootedRemote && getStorageMode() === 'local') {
    await handleSessionExpired();
    return false;
  }

  const ok = await Store.set(key, value);
  if (!ok) {
    toast(`${friendlyName} save failed. Reloading from server.`);
    try {
      await loadAll();
      rerender();
      setSyncIdle();
    } catch (e) {
      console.error('Revert reload failed:', e);
      setSync('error', 'reload failed');
    }
    return false;
  }
  return true;
}

export { saveKey };

/**
 * Called when we detect that the user's Supabase session was lost
 * mid-session (e.g. signed out in another tab). Shows a toast,
 * signs out cleanly to clear any zombie auth state, and routes
 * to the auth view. The pending save that triggered this is
 * discarded.
 */
async function handleSessionExpired() {
  toast('Your session ended. Please sign in again.');
  try {
    await signOut();
  } catch (e) {
    console.error('signOut during session-expired handler failed:', e);
  }
  // The onAuthChange listener will fire SIGNED_OUT and call
  // showAuthView, which resets bootedRemote and clears the UI.
  // But call it directly too so the UI updates immediately even
  // if the listener is delayed.
  showAuthView();
}

async function loadAll() {
  setSync('syncing', 'loading…');
  const schema    = await Store.get(SK.schema, null);
  const profile   = await Store.get(SK.profile, null);
  const settings  = await Store.get(SK.settings, null);
  const timeOff   = await Store.get(SK.timeOff, null);
  const companies = await Store.get(SK.companies, null);
  const entries   = await Store.get(SK.entries, null);
  const pays      = await Store.get(SK.pays, null);

  // First-run seed should ONLY happen in local mode (no auth).
  // Signed-in (remote) users get a clean empty workspace; their data
  // comes from Supabase or via explicit import.
  const storageMode = getStorageMode();
  const isFirstRun = storageMode === 'local' && !schema && !entries && !pays;

  state.profile = profile || { ...DEFAULT_PROFILE };
  state.settings = settings || { ...DEFAULT_SETTINGS };
  // One-time read-side cleanup: standard_day previously carried its own
  // breakMinutes. That value now lives on settings.breakMinutes (Pay Period).
  // Strip the stale key so it doesn't survive the next save.
  if (state.settings.standard_day && 'breakMinutes' in state.settings.standard_day) {
    delete state.settings.standard_day.breakMinutes;
  }
  state.timeOffTypes = timeOff || JSON.parse(JSON.stringify(DEFAULT_TIME_OFF_TYPES));
  state.companies = migrateCompanies(companies || [...SEED_COMPANIES], state.settings);

  if (entries) {
    state.entries = migrateEntries(entries);
  } else if (isFirstRun) {
    state.entries = {};
    for (const e of SEED_ENTRIES) state.entries[e.date] = e;
  } else {
    state.entries = {};
  }

  if (pays) {
    state.pays = pays;
  } else if (isFirstRun) {
    state.pays = SEED_PAYS.map(p => ({ ...p }));
  } else {
    state.pays = [];
  }

  if (isFirstRun) {
    await saveAll();
    toast('Welcome — loaded your existing data');
  } else {
    setSyncIdle();
  }
}

/** Re-render whichever view is currently visible. */
function rerender() {
  const name = state.ui.currentView;
  if (name === 'dashboard') renderDashboard(state);
  else if (name === 'log') renderLog(state);
  else if (name === 'paychecks') renderPaychecks(state);
  else if (name === 'settings') renderSettings(state);
}

async function init() {
  wireAuth();
  // The onAuthChange listener below handles routing on both
  // fresh load and after sign-in/sign-out. No need to call
  // getCurrentSession here — Supabase will fire INITIAL_SESSION
  // when ready.
}

async function bootApp(session) {
  bootedRemote = true;
  try {
    await ensureBootstrapped(session.user.id, session.user.email);
  } catch (e) {
    console.error('Bootstrap failed:', e);
    toast('Failed to set up account: ' + e.message);
    return;
  }
  await loadAll();
  renderTopBar(state.profile);
  updateSignOutVisibility(true);
  wireTabs(state);
  wireDashboard(state);
  wireLog(state);
  wirePaychecks(state);
  wireSettings(state, { saveAll });
  initEntryModal(state, rerender);
  initPayModal(state, rerender);
  switchView('dashboard', state);
}

function showAuthView() {
  bootedRemote = false;
  // Hide all normal views, show the auth view
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('view-auth').classList.add('active');
  renderAuth();
  updateSignOutVisibility(false);
}

function updateSignOutVisibility(loggedIn) {
  const btn = document.getElementById('btnSignOut');
  if (btn) btn.style.display = loggedIn ? 'inline-flex' : 'none';

  // Also hide the tabs and topbar user badge when on auth view
  const tabs = document.querySelector('.tabs');
  const userBadge = document.querySelector('.user-badge');
  if (tabs) tabs.style.display = loggedIn ? 'flex' : 'none';
  if (userBadge) userBadge.style.display = loggedIn ? 'inline-flex' : 'none';
}

// Global sign-out handler
window.handleSignOut = async function () {
  if (!confirm('Sign out?')) return;
  await signOut();
  // onAuthChange below will catch the SIGNED_OUT event and re-render
};

// Guard against double-boot if INITIAL_SESSION and a later
// SIGNED_IN both fire (rare, but possible)
let appBooted = false;

onAuthChange(async (event, session) => {
  if ((event === 'INITIAL_SESSION' || event === 'SIGNED_IN') && session) {
    if (appBooted) return;
    appBooted = true;
    // Defer one frame to let Supabase finish wiring its DB client
    // with the auth token before we make queries.
    requestAnimationFrame(() => { bootApp(session); });
  } else if ((event === 'INITIAL_SESSION' || event === 'SIGNED_OUT') && !session) {
    appBooted = false;
    showAuthView();
  }
});

init().catch(err => {
  console.error('Failed to initialize:', err);
  toast('Initialization error: ' + err.message);
});
