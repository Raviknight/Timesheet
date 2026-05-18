/**
 * src/app.js
 *
 * Top-level entry. Boots the app:
 *   1. Load saved state from storage (or seed if first run)
 *   2. Render top bar
 *   3. Wire up tabs, modals, and per-view handlers
 *   4. Switch to the default landing view
 */

import { Store, STORAGE_MODE } from './data/storage.js';
import {
  SK, SCHEMA_VERSION,
  DEFAULT_PROFILE, DEFAULT_SETTINGS, DEFAULT_TIME_OFF_TYPES,
  migrateEntries,
} from './data/schema.js';
import { SEED_ENTRIES, SEED_PAYS, SEED_COMPANIES } from './data/seed.js';

import { renderTopBar, setSync, setSyncIdle } from './ui/topbar.js';
import { toast } from './ui/toast.js';
import { wireTabs, switchView } from './ui/tabs.js';
import { wireDashboard, renderDashboard } from './ui/dashboard.js';
import { wireLog, renderLog } from './ui/log.js';
import { wirePaychecks, renderPaychecks } from './ui/paychecks.js';
import { wireSettings, renderSettings } from './ui/settings.js';

import { initEntryModal } from './modals/entryModal.js';
import { initPayModal } from './modals/payModal.js';

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

  const isFirstRun = !schema && !entries && !pays;

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
  await loadAll();
  renderTopBar(state.profile);

  // Wire each view
  wireTabs(state);
  wireDashboard(state);
  wireLog(state);
  wirePaychecks(state);
  wireSettings(state, { saveAll });

  // Wire modals
  initEntryModal(state, rerender);
  initPayModal(state, rerender);

  // Land on Pay Period
  switchView('dashboard', state);
}

init().catch(err => {
  console.error('Failed to initialize:', err);
  toast('Initialization error: ' + err.message);
});
