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
  migrateEntries, migrateCompanies, timeOffKeyFor, entriesKeyFor,
} from './data/schema.js';
import { SEED_ENTRIES, SEED_PAYS, SEED_COMPANIES } from './data/seed.js';
import { ensureBootstrapped } from './data/bootstrap.js';
import { activeCompany } from './data/activeCompany.js';
import { HARDCODED_FALLBACK } from './data/standardDay.js';

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
  // Per-company time-off types, keyed by company_id, for the Settings editor.
  // The ACTIVE company's entry shares the same array reference as
  // state.timeOffTypes above, so edits to it flow to the pay math; every other
  // active company keeps its own array and is persisted under its own key.
  // Remote (Supabase) only; in local mode this holds just the active company.
  timeOffByCompany: {},
  companies: [],
  entries: {},
  // Per-company entries, keyed by company_id, each a {date: entry} map. The
  // ACTIVE company's entry shares the same object reference as state.entries
  // above, so every existing reader of state.entries stays correct and the
  // active company's output is unchanged. Other active companies keep their own
  // map and are persisted under their own key. Remote (Supabase) only; in local
  // mode this holds just the active company.
  entriesByCompany: {},
  pays: [],
  ui: {
    currentView: 'dashboard',
    logYear: new Date().getFullYear(),
    payYearFilter: 'all',
    ppMode: 'current',
    ppOtherDate: null,
    // Which company's Pay Period the landing tab strip is showing. null means
    // the active company (the default, output-identical to single-company use).
    ppCompanyId: null,
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
 * Build state.timeOffByCompany for every active company. The active company's
 * entry is the SAME array reference as state.timeOffTypes, so the Settings
 * editor and the pay math stay in sync for it. Other active companies are read
 * by their own key (remote only), priming each one's write-cache snapshot.
 *
 * In local mode (unauthenticated) there is only the single active company, so
 * we map just that one and never touch the per-company keyed paths.
 */
async function loadTimeOffByCompany() {
  state.timeOffByCompany = {};
  const activeId = String(activeCompany(state).id ?? '');
  state.timeOffByCompany[activeId] = state.timeOffTypes;

  if (getStorageMode() !== 'remote') return;

  const actives = Array.isArray(state.companies)
    ? state.companies.filter(c => c.isActive !== false)
    : [];
  for (const c of actives) {
    const cid = String(c.id ?? '');
    if (!cid || cid === activeId) continue;
    const types = await Store.get(timeOffKeyFor(cid), null);
    state.timeOffByCompany[cid] = types || JSON.parse(JSON.stringify(DEFAULT_TIME_OFF_TYPES));
  }
}

/**
 * Load one company's time-off types into state.timeOffByCompany if missing.
 * Used by the Settings editor when a company is added or activated after boot.
 * The active company is never overwritten here (it shares state.timeOffTypes).
 */
export async function ensureTimeOffForCompany(companyId) {
  const cid = String(companyId ?? '');
  if (!cid || state.timeOffByCompany[cid]) return;
  if (getStorageMode() !== 'remote') {
    state.timeOffByCompany[cid] = state.timeOffTypes;
    return;
  }
  const types = await Store.get(timeOffKeyFor(cid), null);
  state.timeOffByCompany[cid] = types || JSON.parse(JSON.stringify(DEFAULT_TIME_OFF_TYPES));
}

/**
 * Re-point the active company's per-company entry at the current
 * state.timeOffTypes array. Call after anything replaces that array wholesale
 * (import), so the shared-reference invariant for the active company holds.
 */
export function syncActiveTimeOff() {
  const activeId = String(activeCompany(state).id ?? '');
  state.timeOffByCompany[activeId] = state.timeOffTypes;
}

/**
 * Build state.entriesByCompany for every active company. The active company's
 * entry is the SAME object reference as state.entries, so every existing reader
 * of state.entries stays correct and its output is unchanged. Other active
 * companies are read by their own key (remote only), priming each one's
 * write-cache snapshot.
 *
 * In local mode (unauthenticated) there is only the single active company, so
 * we map just that one and never touch the per-company keyed paths. Mirrors
 * loadTimeOffByCompany.
 */
async function loadEntriesByCompany() {
  state.entriesByCompany = {};
  const activeId = String(activeCompany(state).id ?? '');
  state.entriesByCompany[activeId] = state.entries;

  if (getStorageMode() !== 'remote') return;

  const actives = Array.isArray(state.companies)
    ? state.companies.filter(c => c.isActive !== false)
    : [];
  for (const c of actives) {
    const cid = String(c.id ?? '');
    if (!cid || cid === activeId) continue;
    const entries = await Store.get(entriesKeyFor(cid), null);
    state.entriesByCompany[cid] = entries || {};
  }
}

/**
 * Load one company's entries into state.entriesByCompany if missing. Used when
 * a company is edited/activated after boot. The active company is never
 * overwritten here (it shares state.entries). Mirrors ensureTimeOffForCompany.
 */
export async function ensureEntriesForCompany(companyId) {
  const cid = String(companyId ?? '');
  if (!cid || state.entriesByCompany[cid]) return;
  const activeId = String(activeCompany(state).id ?? '');
  if (cid === activeId || getStorageMode() !== 'remote') {
    state.entriesByCompany[cid] = state.entries;
    return;
  }
  const entries = await Store.get(entriesKeyFor(cid), null);
  state.entriesByCompany[cid] = entries || {};
}

/**
 * Re-point the active company's per-company entry at the current state.entries
 * object. Call after anything replaces that object wholesale (import/reload),
 * so the shared-reference invariant for the active company holds. Mirrors
 * syncActiveTimeOff.
 */
export function syncActiveEntries() {
  const activeId = String(activeCompany(state).id ?? '');
  state.entriesByCompany[activeId] = state.entries;
}

/**
 * Persist one company's entries to the right key: the active company goes
 * through SK.entries (the set state.entries feeds); any other company goes
 * through its own company-scoped key. Returns the saveKey result.
 */
export function saveEntriesForCompany(companyId) {
  const cid = String(companyId ?? '');
  const entries = state.entriesByCompany[cid];
  if (!entries) return Promise.resolve(false);
  const activeId = String(activeCompany(state).id ?? '');
  const key = cid === activeId ? SK.entries : entriesKeyFor(cid);
  return saveKey(key, entries, 'Entry');
}

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

/**
 * Seed each company's break + Standard Day from the user-level settings that
 * the resolvers used to inherit, so retiring that inherit is output-identical.
 * Mutates state.companies in place. Returns true if anything changed.
 *
 * Idempotent: only fills fields that are still null. Existing companies keep
 * exactly the hours (break) and prefill (Standard Day) they have today; brand
 * new companies are left null on purpose (they resolve to break 30 / blank).
 *
 *   break:  prior effective = settings.breakMinutes (or 0 when unset, matching
 *           the old computeSegmentHours `|| 0` fallback).
 *   std:    prior effective = settings.standard_day, else the hardcoded
 *           fallback. Only seeded when that effective day has at least one
 *           segment set, so a degenerate all-blank user standard day is left
 *           alone (the one case that would otherwise re-seed every load).
 */
function seedPerCompanyBreakAndStandardDay() {
  const s = state.settings || {};
  const effBreak = s.breakMinutes != null ? s.breakMinutes : 0;
  const effStd = s.standard_day || HARDCODED_FALLBACK;
  const effStdHasAny = !!effStd && (effStd.seg1Start != null || effStd.seg1End != null
    || effStd.seg2Start != null || effStd.seg2End != null);

  let changed = false;
  for (const c of state.companies) {
    if (c.breakMinutes == null) {
      c.breakMinutes = effBreak;
      changed = true;
    }
    const stdAllNull = c.stdSeg1Start == null && c.stdSeg1End == null
      && c.stdSeg2Start == null && c.stdSeg2End == null;
    if (stdAllNull && effStdHasAny) {
      c.stdSeg1Start = effStd.seg1Start ?? null;
      c.stdSeg1End   = effStd.seg1End   ?? null;
      c.stdSeg2Start = effStd.seg2Start ?? null;
      c.stdSeg2End   = effStd.seg2End   ?? null;
      changed = true;
    }
  }
  return changed;
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
  state.companies = migrateCompanies(companies || [...SEED_COMPANIES]);
  // One-time migration: copy each company's PRIOR effective break + Standard
  // Day (which used to inherit from user settings) onto the company itself, so
  // existing companies keep identical hours and prefill now that the resolvers
  // no longer inherit. Gated by a persisted flag so it runs exactly ONCE: a
  // plain fill-nulls-every-load would wrongly re-capture brand-new companies
  // (which must stay blank → break 30 / blank Standard Day).
  if (!state.settings.perCompanyBreakStdMigrated) {
    const seeded = seedPerCompanyBreakAndStandardDay();
    state.settings.perCompanyBreakStdMigrated = true;
    // First-run local persists via the trailing saveAll(); otherwise persist
    // the flag (and any seeded company changes) now.
    if (!isFirstRun) {
      await saveKey(SK.settings, state.settings, 'Settings');
      if (seeded) await saveKey(SK.companies, state.companies, 'Companies');
    }
  }
  await loadTimeOffByCompany();

  if (entries) {
    state.entries = migrateEntries(entries);
  } else if (isFirstRun) {
    state.entries = {};
    for (const e of SEED_ENTRIES) state.entries[e.date] = e;
  } else {
    state.entries = {};
  }
  await loadEntriesByCompany();

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
