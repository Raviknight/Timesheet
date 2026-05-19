/**
 * src/app.js
 *
 * Top-level entry. Boots the app:
 *   1. Load saved state from storage (or seed if first run)
 *   2. Render top bar
 *   3. Wire up tabs, modals, and per-view handlers
 *   4. Switch to the default landing view
 */

console.log('app.js: module loading');

import { Store, STORAGE_MODE, getStorageMode } from './data/storage.js';
import {
  SK, SCHEMA_VERSION,
  DEFAULT_PROFILE, DEFAULT_SETTINGS, DEFAULT_TIME_OFF_TYPES,
  migrateEntries,
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

import { getCurrentSession, onAuthChange, signOut } from './auth/session.js';
import { renderAuth, wireAuth } from './ui/auth.js';

window.addEventListener('unhandledrejection', (e) => {
  console.error('UNHANDLED REJECTION:', e.reason);
});

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
  setSync('syncing', 'saving…');
  try {
    await Promise.all([
      Store.set(SK.profile, state.profile),
      Store.set(SK.settings, state.settings),
      Store.set(SK.timeOff, state.timeOffTypes),
      Store.set(SK.companies, state.companies),
      Store.set(SK.entries, state.entries),
      Store.set(SK.pays, state.pays),
      Store.set(SK.schema, SCHEMA_VERSION),
    ]);
    setSyncIdle();
  } catch (e) {
    setSync('error', 'save error');
    console.error(e);
  }
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
  state.timeOffTypes = timeOff || JSON.parse(JSON.stringify(DEFAULT_TIME_OFF_TYPES));
  state.companies = companies || [...SEED_COMPANIES];

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
  console.log('init: entered');
  // Wire the auth view first so it works whether or not we're logged in
  wireAuth();

  // Check current session
  const session = await getCurrentSession();
  console.log('init: session?', !!session);
  if (!session) {
    showAuthView();
    return;
  }

  // Logged in: boot the app
  await bootApp();
}

async function bootApp() {
  console.log('bootApp called');
  console.log('bootApp: step 1 - getCurrentSession');
  const session = await getCurrentSession();
  if (!session) {
    console.log('bootApp: no session, redirecting to auth');
    showAuthView();
    return;
  }
  console.log('bootApp: step 2 - ensureBootstrapped');
  try {
    const profile = await ensureBootstrapped(session.user.id, session.user.email);
    console.log('User profile ready:', profile);
  } catch (e) {
    console.error('Bootstrap failed:', e);
    toast('Failed to set up account: ' + e.message);
    return;
  }
  console.log('bootApp: step 3 - loadAll');
  await loadAll();
  console.log('bootApp: step 4 - renderTopBar');
  renderTopBar(state.profile);
  updateSignOutVisibility(true);
  console.log('bootApp: step 5 - wire views');
  wireTabs(state);
  wireDashboard(state);
  wireLog(state);
  wirePaychecks(state);
  wireSettings(state, { saveAll });
  console.log('bootApp: step 6 - wire modals');
  initEntryModal(state, rerender);
  initPayModal(state, rerender);
  console.log('bootApp: step 7 - switchView');
  switchView('dashboard', state);
  console.log('bootApp: complete, currentView=', state.ui.currentView);
}

function showAuthView() {
  console.log('showAuthView called');
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

// Listen for auth state changes
onAuthChange(async (event, session) => {
  console.log('Auth event:', event, 'session?', !!session);
  if (event === 'SIGNED_IN' && session) {
    // User just signed in: boot the app
    await bootApp();
  } else if (event === 'SIGNED_OUT') {
    // User signed out: show the auth view
    showAuthView();
  }
  // TOKEN_REFRESHED and other events: no action needed
});

init().catch(err => {
  console.error('Failed to initialize:', err);
  toast('Initialization error: ' + err.message);
});
