/**
 * src/ui/settings.js
 *
 * Settings view. Five sections:
 *   1. Pay period system (weekly/biweekly/semi/monthly/advanced)
 *   2. Time-off types and pools
 *   3. Companies
 *   4. Profile (name, role)
 *   5. Data (export/import/reset)
 */

import { Store } from '../data/storage.js';
import { saveKey, ensureTimeOffForCompany, syncActiveTimeOff } from '../app.js';
import {
  SK, SCHEMA_VERSION, DEFAULT_PROFILE, DEFAULT_SETTINGS,
  DEFAULT_TIME_OFF_TYPES, migrateEntries, migrateCompanies, timeOffKeyFor,
} from '../data/schema.js';
import { getPayPeriodFor, periodLengthDays } from '../core/payPeriod.js';
import { escapeHtml, formatLong } from '../core/format.js';
import { computeHours, computeSegmentHours, entrySegments, dayShort, fmtDate, resolveBreakMinutes } from '../core/time.js';
import { setSyncIdle, renderTopBar } from './topbar.js';
import { toast } from './toast.js';
import { resolveStandardDay, computeStandardDayHours } from '../data/standardDay.js';
import { createCompany, deleteCompany } from '../data/bootstrap.js';
import { activeCompany } from '../data/activeCompany.js';
import { supabase } from '../data/supabase.js';

export function renderSettings(state) {
  renderPerCompanyPayPeriod(state);
  setVal('setName', state.profile.name || '');
  setVal('setRole', state.profile.role || 'owner');
  renderCompaniesList(state);
}

function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v;
}

// Module-level so the Settings card and the new-company setup modal render the
// SAME field set from one source (no fork).
const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FREQ_OPTIONS = [
  ['weekly',      'Weekly'],
  ['biweekly',    'Bi-weekly'],
  ['semimonthly', 'Semi-monthly'],
  ['monthly',     'Monthly'],
  ['advanced',    'Advanced'],
];

// Build the inner pay-period + OT + break + Standard Day fields for one company.
// Returns just the fields (no card wrapper, name header, Save button, or
// time-off section) so the Settings card and the setup modal share this markup
// and all the [data-pp-field]/[data-pp-group] helpers operate on it identically.
function ppCardFieldsHtml(c) {
  const freq = c.payFrequency || 'biweekly';
  const wsd = c.weekStartDow ?? 1;
  const otPeriod = c.otPeriod || 'weekly';
  const otThreshold = c.otThreshold ?? 40;
  // Per-company break + Standard Day. A blank break defaults to 30; a blank
  // Standard Day uses the hardcoded default. Break preserves a stored 0.
  const brkVal = c.breakMinutes != null ? c.breakMinutes : '';
  const sd1s = c.stdSeg1Start ?? '';
  const sd1e = c.stdSeg1End ?? '';
  const sd2s = c.stdSeg2Start ?? '';
  const sd2e = c.stdSeg2End ?? '';

  const freqHtml = FREQ_OPTIONS.map(([v, label]) =>
    `<option value="${v}"${v === freq ? ' selected' : ''}>${label}</option>`
  ).join('');
  const dowHtml = DOW_LABELS.map((label, i) =>
    `<option value="${i}"${i === wsd ? ' selected' : ''}>${label}</option>`
  ).join('');

  // All conditional groups are always rendered; only the one matching the
  // current frequency is visible. Visibility + defaults are toggled in the
  // wiring (wirePpCard) as the frequency changes. Values render stored-or-empty;
  // empty visible fields are filled with defaults at wire time.
  const parity = c.biweeklyStartParity || 'odd';
  const grpStyle = (g) => freq === g ? '' : ' style="display:none"';
  const extraHtml = `
        <div class="grow" data-pp-group="biweekly"${grpStyle('biweekly')}>
          <label>Week parity</label>
          <select data-pp-field="biweeklyStartParity">
            <option value="odd"${parity === 'odd' ? ' selected' : ''}>Odd weeks</option>
            <option value="even"${parity === 'even' ? ' selected' : ''}>Even weeks</option>
          </select>
        </div>
        <div class="grow" data-pp-group="semimonthly"${grpStyle('semimonthly')}>
          <div class="row">
            <div class="grow">
              <label>First day (1-15)</label>
              <input type="number" min="1" max="15" data-pp-field="semiFirstDay" value="${c.semiFirstDay ?? ''}">
            </div>
            <div class="grow">
              <label>Second day (16-31)</label>
              <input type="number" min="16" max="31" data-pp-field="semiSecondDay" value="${c.semiSecondDay ?? ''}">
            </div>
          </div>
        </div>
        <div class="grow" data-pp-group="monthly"${grpStyle('monthly')}>
          <label>Anchor day (1-31)</label>
          <input type="number" min="1" max="31" data-pp-field="monthlyStartDay" value="${c.monthlyStartDay ?? ''}">
        </div>
        <div class="grow" data-pp-group="advanced"${grpStyle('advanced')}>
          <div class="row">
            <div class="grow">
              <label>Anchor date</label>
              <input type="date" data-pp-field="advancedAnchorDate" value="${escapeHtml(c.advancedAnchorDate || '')}">
            </div>
            <div class="grow">
              <label>Cycle days</label>
              <input type="number" min="1" max="60" step="1" data-pp-field="advancedCycleDays" value="${c.advancedCycleDays ?? ''}">
            </div>
          </div>
        </div>`;

  let previewText;
  try {
    const pp = getPayPeriodFor('current', null, c);
    const days = periodLengthDays(pp.start, pp.end);
    previewText = `${formatLong(pp.start)} → ${formatLong(pp.end)} (${days} days)`;
  } catch (err) {
    previewText = 'Complete the fields to preview';
  }

  return `
      <div class="row">
        <div class="grow">
          <label>Pay frequency</label>
          <select data-pp-field="payFrequency">${freqHtml}</select>
        </div>
        <div class="grow">
          <label>Week start day</label>
          <select data-pp-field="weekStartDow">${dowHtml}</select>
        </div>
        ${extraHtml}
      </div>
      <div class="row" style="margin-top:8px">
        <div class="grow">
          <label>OT period</label>
          <select data-pp-field="otPeriod">
            <option value="weekly"${otPeriod === 'weekly' ? ' selected' : ''}>Weekly</option>
            <option value="biweekly"${otPeriod === 'biweekly' ? ' selected' : ''}>Bi-weekly</option>
            <option value="semimonthly"${otPeriod === 'semimonthly' ? ' selected' : ''}>Semi-monthly</option>
            <option value="monthly"${otPeriod === 'monthly' ? ' selected' : ''}>Monthly</option>
          </select>
        </div>
        <div class="grow">
          <label>OT threshold (hours per OT period, e.g. 40 weekly / 80 bi-weekly)</label>
          <input type="number" min="0" step="0.5" data-pp-field="otThreshold" value="${otThreshold}">
        </div>
      </div>
      <div class="stat" style="margin-top:8px;background:var(--surface-2)">
        <div class="stat-label">Current period preview</div>
        <div data-pp-preview style="font-size:14px;font-weight:500;margin-top:4px">${previewText}</div>
      </div>
      <div style="margin-top:10px; padding-top:10px; border-top:1px dashed var(--border)">
        <div style="font-weight:600; margin-bottom:6px">Break &amp; Standard Day</div>
        <div class="row">
          <div class="grow">
            <label>Break minutes (blank defaults to 30)</label>
            <input type="number" min="0" step="1" data-pp-field="breakMinutes" value="${brkVal}" placeholder="30">
          </div>
          <div class="grow">
            <label>Standard Day total</label>
            <div class="stat" style="background:var(--surface-2);margin-top:0">
              <span data-sd-total style="font-weight:600">0.00</span> h
            </div>
          </div>
        </div>
        <div class="row" style="margin-top:6px">
          <div class="grow"><label>Std seg 1 start</label>
            <input type="time" data-pp-field="stdSeg1Start" value="${escapeHtml(sd1s)}"></div>
          <div class="grow"><label>Std seg 1 end</label>
            <input type="time" data-pp-field="stdSeg1End" value="${escapeHtml(sd1e)}"></div>
        </div>
        <div class="row" style="margin-top:6px">
          <div class="grow"><label>Std seg 2 start</label>
            <input type="time" data-pp-field="stdSeg2Start" value="${escapeHtml(sd2s)}"></div>
          <div class="grow"><label>Std seg 2 end</label>
            <input type="time" data-pp-field="stdSeg2End" value="${escapeHtml(sd2e)}"></div>
        </div>
        <div class="row" style="margin-top:6px">
          <div class="grow"><label>Hire date</label>
            <input type="date" data-pp-field="startDate" value="${escapeHtml(c.startDate ?? '')}">
            <div class="help">Drives the probation/waiting check and the anniversary cycle anchor. Blank uses Jan 1 this year with no probation.</div></div>
        </div>
      </div>`;
}

// Wire a card element (Settings card or setup modal body): conditional-group
// visibility on frequency change, live pay-period preview, and Standard Day
// total. Shared so the two surfaces stay in sync.
function wirePpCard(card, state) {
  const freqSel = ppFieldEl(card, 'payFrequency');
  if (!freqSel) return;
  freqSel.onchange = () => {
    showPpGroupFor(card, freqSel.value);
    applyPpGroupDefaults(card, freqSel.value);
    updatePpCardPreview(card);
    updateSdCardTotal(card, state);
  };
  card.querySelectorAll('[data-pp-field]').forEach(el => {
    if (el === freqSel) return;
    el.onchange = () => { updatePpCardPreview(card); updateSdCardTotal(card, state); };
  });
  // Fill empty fields in the initially-visible group so its preview is valid,
  // then seed the Standard Day total from the current values.
  applyPpGroupDefaults(card, freqSel.value);
  updateSdCardTotal(card, state);
}

// New-company setup modal. Opens right after Add Company, titled with the new
// company's name. Reuses ppCardFieldsHtml + wirePpCard + buildPpCompanyFromCard,
// so it shares the Settings card's fields, validation, and per-company Save.
function openCompanySetupModal(state, companyId) {
  const company = state.companies.find(c => String(c.id ?? '') === String(companyId));
  if (!company) return;
  const bg = document.getElementById('companySetupModal');
  if (!bg) return;

  document.getElementById('companySetupTitle').textContent = `Set up ${company.name}`;
  const body = document.getElementById('companySetupBody');
  // Show 30 in the break field as the default for the setup flow; everything
  // else comes from the freshly-created company (biweekly / Mon / OT 40 /
  // weekly, blank Standard Day).
  const display = { ...company, breakMinutes: company.breakMinutes ?? 30 };
  body.innerHTML = `<div data-company-id="${escapeHtml(company.id ?? '')}">${ppCardFieldsHtml(display)}</div>`;
  const card = body.querySelector('[data-company-id]');
  wirePpCard(card, state);

  const close = () => bg.classList.remove('show');

  // Set up later: keep the company's blank defaults; just close.
  document.getElementById('btnCompanySetupSkip').onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };

  const saveBtn = document.getElementById('btnCompanySetupSave');
  saveBtn.onclick = async () => {
    const built = buildPpCompanyFromCard(card);
    try {
      getPayPeriodFor('current', null, built);
    } catch (err) {
      toast('Complete the required fields before saving.');
      return;
    }
    Object.assign(company, built);
    saveBtn.disabled = true;
    const ok = await saveKey(SK.companies, state.companies, 'Companies');
    saveBtn.disabled = false;
    if (!ok) {
      toast('Could not save setup');
      return;
    }
    setSyncIdle();
    close();
    renderCompaniesList(state);
    renderPerCompanyPayPeriod(state);
    toast('Company set up');
  };

  bg.classList.add('show');
}

function renderPerCompanyPayPeriod(state) {
  const list = document.getElementById('ppPerCompanyList');
  if (!list) return;
  const activeCompanies = Array.isArray(state.companies)
    ? state.companies.filter(c => c.isActive !== false)
    : [];
  if (activeCompanies.length === 0) {
    list.innerHTML = '<div class="muted">No active companies.</div>';
    return;
  }

  // Default the visible tab to the user's active company; fall back to the
  // first active company when that one is inactive or unset.
  const active = activeCompany(state);
  const selectedId = activeCompanies.some(c => String(c.id ?? '') === String(active.id ?? ''))
    ? String(active.id ?? '')
    : String(activeCompanies[0].id ?? '');

  let html = '';
  for (const c of activeCompanies) {
    const cardHidden = String(c.id ?? '') === selectedId ? '' : 'display:none;';
    html += `<div data-company-id="${escapeHtml(c.id ?? '')}" style="${cardHidden}border:1px solid var(--border); border-radius:var(--radius); padding:10px; margin-bottom:8px">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:6px">
        <div style="font-weight:600">${escapeHtml(c.name)}</div>
      </div>
      ${ppCardFieldsHtml(c)}
      <div class="row" style="justify-content:flex-end; margin-top:8px">
        <button class="btn btn-sm btn-primary" data-pp-save>Save</button>
      </div>
      <div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--border)">
        <div style="font-weight:600; margin-bottom:8px">Time-Off Types &amp; Pools</div>
        <div data-toc-for="${escapeHtml(c.id ?? '')}"></div>
        <button class="btn btn-sm" data-to-add="${escapeHtml(c.id ?? '')}" style="margin-top:8px">+ Add type</button>
      </div>
    </div>`;
  }
  // Tab strip: one tab per active company. With a single company there is no
  // strip; its card just renders on its own.
  let tabsHtml = '';
  if (activeCompanies.length > 1) {
    const tabs = activeCompanies.map(c => {
      const id = String(c.id ?? '');
      const isSel = id === selectedId ? ' active' : '';
      return `<button type="button" class="pp-subtab${isSel}" data-pp-tab="${escapeHtml(id)}">${escapeHtml(c.name)}</button>`;
    }).join('');
    tabsHtml = `<div class="pp-subtabs">${tabs}</div>`;
  }
  list.innerHTML = tabsHtml + html;

  // Wire the tab strip: switching tabs swaps which company's card is visible.
  const tabBtns = list.querySelectorAll('[data-pp-tab]');
  const cards = list.querySelectorAll('[data-company-id]');
  tabBtns.forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.ppTab;
      tabBtns.forEach(b => b.classList.toggle('active', b.dataset.ppTab === id));
      cards.forEach(card => {
        card.style.display = card.dataset.companyId === id ? '' : 'none';
      });
    };
  });

  // Wire each card: editing toggles conditional visibility and recomputes the
  // preview from the current inputs. No persistence here (save is a later chunk).
  list.querySelectorAll('[data-company-id]').forEach(card => {
    if (!ppFieldEl(card, 'payFrequency')) return;
    // Shared wiring: conditional-group visibility, preview, and Standard Day
    // total. Same call the setup modal uses, so the two never drift.
    wirePpCard(card, state);

    const saveBtn = card.querySelector('[data-pp-save]');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        const built = buildPpCompanyFromCard(card);
        // Validate by reusing the preview's logic: an incomplete or invalid
        // config for the chosen frequency throws.
        try {
          getPayPeriodFor('current', null, built);
        } catch (err) {
          toast('Complete the required fields before saving.');
          return;
        }
        const cid = card.dataset.companyId;
        const company = state.companies.find(c => String(c.id ?? '') === cid);
        if (!company) return;
        Object.assign(company, built);
        saveBtn.disabled = true;
        const ok = await saveKey(SK.companies, state.companies, 'Companies');
        saveBtn.disabled = false;
        if (ok) {
          setSyncIdle();
          toast('Pay period saved');
        } else {
          toast('Could not save pay period');
        }
      };
    }

    // Time-off types for this company, rendered under its tab next to the
    // pay-period fields. CRUD is scoped to this company_id.
    const cid = card.dataset.companyId;
    const toContainer = card.querySelector('[data-toc-for]');
    if (toContainer) renderTOTypesForCompany(state, cid, toContainer);

    const addBtn = card.querySelector('[data-to-add]');
    if (addBtn) {
      addBtn.onclick = () => {
        const types = state.timeOffByCompany[cid];
        if (!types) return;
        types.push({
          code: 'NEW', label: 'New Type',
          poolDays: 0, hoursPerDay: 8, countsAgainstPool: false, additive: false,
        });
        saveTimeOff(state, cid).then(ok => { if (ok) setSyncIdle(); });
        renderTOTypesForCompany(state, cid, toContainer);
      };
    }
  });
}

// Persist one company's time-off types to the right key: the active company
// goes through SK.timeOff (the same path that feeds the pay math); any other
// company goes through its own company-scoped key.
function saveTimeOff(state, companyId) {
  const types = state.timeOffByCompany[companyId];
  const activeId = String(activeCompany(state).id ?? '');
  const key = String(companyId) === activeId ? SK.timeOff : timeOffKeyFor(companyId);
  return saveKey(key, types, 'Time off');
}

// Build a clean, DB-appropriate company object from a card's current inputs.
// Empty strings become null; numeric fields are parsed to numbers;
// advancedAnchorDate stays a date string or null. Shared by preview + save.
function buildPpCompanyFromCard(card) {
  const numField = (name) => {
    const v = ppFieldEl(card, name).value;
    if (v == null || v === '') return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  };
  const strField = (name) => {
    const v = ppFieldEl(card, name).value;
    return v == null || v === '' ? null : v;
  };
  return {
    payFrequency: ppFieldEl(card, 'payFrequency').value,
    weekStartDow: parseInt(ppFieldEl(card, 'weekStartDow').value, 10),
    biweeklyStartParity: strField('biweeklyStartParity'),
    semiFirstDay: numField('semiFirstDay'),
    semiSecondDay: numField('semiSecondDay'),
    monthlyStartDay: numField('monthlyStartDay'),
    advancedAnchorDate: strField('advancedAnchorDate'),
    advancedCycleDays: numField('advancedCycleDays'),
    otPeriod: ppFieldEl(card, 'otPeriod').value,
    otThreshold: (() => {
      const n = parseFloat(ppFieldEl(card, 'otThreshold').value);
      return Number.isFinite(n) ? n : 40;
    })(),
    // Per-company break + Standard Day. Blank → null (inherit). numField keeps
    // a deliberate 0 break; strField keeps "HH:MM" times or null.
    breakMinutes: numField('breakMinutes'),
    stdSeg1Start: strField('stdSeg1Start'),
    stdSeg1End: strField('stdSeg1End'),
    stdSeg2Start: strField('stdSeg2Start'),
    stdSeg2End: strField('stdSeg2End'),
    // Per-company cycle anchor for PTO accrual. Blank → null (engine then
    // defaults to Jan 1 of the current year).
    startDate: strField('startDate'),
  };
}

// Refresh a card's Standard Day total from its CURRENT inputs, resolved against
// this company (its own Standard Day + break when set, else the user setting).
function updateSdCardTotal(card, state) {
  const out = card.querySelector('[data-sd-total]');
  if (!out) return;
  const built = buildPpCompanyFromCard(card);
  const sd = resolveStandardDay(state.settings, built);
  const breakMin = resolveBreakMinutes(state.settings, built);
  out.textContent = computeStandardDayHours(sd, breakMin).toFixed(2);
}

// Default values for conditional pay-period fields (advancedAnchorDate is
// intentionally left blank). Used when a group becomes visible with an empty
// field. Values match getPayPeriodFor's own fallbacks so preview is consistent.
const PP_FIELD_DEFAULTS = {
  biweeklyStartParity: 'odd',
  semiFirstDay: '1',
  semiSecondDay: '16',
  monthlyStartDay: '1',
  advancedCycleDays: '14',
};
const PP_GROUP_FIELDS = {
  weekly: [],
  biweekly: ['biweeklyStartParity'],
  semimonthly: ['semiFirstDay', 'semiSecondDay'],
  monthly: ['monthlyStartDay'],
  advanced: ['advancedAnchorDate', 'advancedCycleDays'],
};

function ppFieldEl(card, name) {
  return card.querySelector(`[data-pp-field="${name}"]`);
}

function showPpGroupFor(card, freq) {
  card.querySelectorAll('[data-pp-group]').forEach(g => {
    g.style.display = g.dataset.ppGroup === freq ? '' : 'none';
  });
}

function applyPpGroupDefaults(card, freq) {
  for (const name of PP_GROUP_FIELDS[freq] || []) {
    const el = ppFieldEl(card, name);
    if (!el) continue;
    if ((el.value == null || el.value === '') && name in PP_FIELD_DEFAULTS) {
      el.value = PP_FIELD_DEFAULTS[name];
    }
  }
}

// Recompute a card's preview from its CURRENT input values, not the saved
// company. Incomplete config (unknown freq, missing advanced anchor) throws,
// in which case we show a neutral placeholder.
function updatePpCardPreview(card) {
  const out = card.querySelector('[data-pp-preview]');
  if (!out) return;
  const temp = buildPpCompanyFromCard(card);
  try {
    const pp = getPayPeriodFor('current', null, temp);
    const days = periodLengthDays(pp.start, pp.end);
    out.textContent = `${formatLong(pp.start)} → ${formatLong(pp.end)} (${days} days)`;
  } catch (err) {
    out.textContent = 'Complete the fields to preview';
  }
}

// Render one company's time-off types into `container`. All CRUD operates on
// state.timeOffByCompany[companyId] and persists via saveTimeOff (which routes
// the active company through the math-feeding key and others through their own
// key).
function renderTOTypesForCompany(state, companyId, container) {
  const cid = String(companyId);
  const list = container;
  const types = state.timeOffByCompany[cid];
  if (!types) {
    list.innerHTML = '<div class="muted">Loading…</div>';
    ensureTimeOffForCompany(cid).then(() => renderTOTypesForCompany(state, cid, container));
    return;
  }
  let html = '';
  types.forEach((t, i) => {
    let accrualHtml = '';
    if (t.countsAgainstPool && !t.sharedPoolWith) {
      // Accrual config (chunk 4a). Every field at its default is null-equivalent,
      // so a flat pool reads exactly like before. Conditional inputs (anchor
      // date, carry cap) appear only for their option.
      const gs = t.grantStyle || 'upfront';
      const anchor = t.accrualAnchor || 'calendar';
      const cmode = t.carryoverMode || 'none';
      accrualHtml = `<div style="margin-top:8px; padding-top:8px; border-top:1px dashed var(--border)">
        <div class="muted" style="font-size:0.85em; margin-bottom:6px">Accrual</div>
        <div class="row" style="gap:6px; flex-wrap:wrap; align-items:flex-end">
          <div style="flex:0 0 120px"><label>Grant style</label>
            <select data-i="${i}" data-f="grantStyle">
              <option value="upfront" ${gs === 'upfront' ? 'selected' : ''}>Up front</option>
              <option value="accrued" ${gs === 'accrued' ? 'selected' : ''}>Accrued</option>
            </select></div>
          <div style="flex:0 0 130px"><label>Cycle anchor</label>
            <select data-i="${i}" data-f="accrualAnchor">
              <option value="calendar" ${anchor === 'calendar' ? 'selected' : ''}>Calendar</option>
              <option value="anniversary" ${anchor === 'anniversary' ? 'selected' : ''}>Anniversary</option>
              <option value="fiscal" ${anchor === 'fiscal' ? 'selected' : ''}>Fiscal</option>
            </select></div>
          ${anchor === 'fiscal' ? `<div style="flex:0 0 150px"><label>Anchor date</label>
            <input type="date" data-i="${i}" data-f="anchorDate" value="${escapeHtml(t.anchorDate ?? '')}"></div>` : ''}
          <div style="flex:0 0 110px"><label title="Probation before eligibility">Waiting days</label>
            <input type="number" data-i="${i}" data-f="waitingDays" min="0" step="1" value="${t.waitingDays ?? ''}" placeholder="0"></div>
          <div style="flex:0 0 120px"><label>Carry-over</label>
            <select data-i="${i}" data-f="carryoverMode">
              <option value="none" ${cmode === 'none' ? 'selected' : ''}>None</option>
              <option value="cap" ${cmode === 'cap' ? 'selected' : ''}>Cap</option>
              <option value="unlimited" ${cmode === 'unlimited' ? 'selected' : ''}>Unlimited</option>
            </select></div>
          ${cmode === 'cap' ? `<div style="flex:0 0 110px"><label>Cap (days)</label>
            <input type="number" data-i="${i}" data-f="carryoverCap" min="0" step="0.5" value="${t.carryoverCap ?? ''}" placeholder="0"></div>` : ''}
        </div>
      </div>`;
    }
    html += `<div style="border:1px solid var(--border); border-radius:var(--radius); padding:10px; margin-bottom:8px">
      <div class="row" style="margin-bottom:6px">
        <div style="flex:0 0 90px"><label>Code</label>
          <input data-i="${i}" data-f="code" value="${escapeHtml(t.code)}"></div>
        <div class="grow"><label>Label</label>
          <input data-i="${i}" data-f="label" value="${escapeHtml(t.label)}"></div>
      </div>
      <div class="row">
        <div style="flex:0 0 110px"><label>Pool (days)</label>
          <input type="number" data-i="${i}" data-f="poolDays" min="0" step="0.5" value="${t.poolDays || 0}"></div>
        <div style="flex:0 0 130px"><label>Hours / day</label>
          <input type="number" data-i="${i}" data-f="hoursPerDay" min="0" step="0.25" value="${t.hoursPerDay || 8}"></div>
        <div style="flex:0 0 130px"><label>Counts pool</label>
          <select data-i="${i}" data-f="countsAgainstPool">
            <option value="true" ${t.countsAgainstPool ? 'selected' : ''}>Yes</option>
            <option value="false" ${!t.countsAgainstPool ? 'selected' : ''}>No</option>
          </select></div>
        <div style="flex:0 0 130px"><label title="Pays in addition to worked hours">Additive</label>
          <select data-i="${i}" data-f="additive">
            <option value="true" ${t.additive ? 'selected' : ''}>Yes</option>
            <option value="false" ${!t.additive ? 'selected' : ''}>No</option>
          </select></div>
        <div class="grow"><label>Shares pool with</label>
          <select data-i="${i}" data-f="sharedPoolWith">
            <option value="">— None —</option>
            ${types.filter((x, j) => j !== i).map(x =>
              `<option value="${x.code}" ${t.sharedPoolWith === x.code ? 'selected' : ''}>${x.code}</option>`
            ).join('')}
          </select></div>
      </div>
      ${accrualHtml}
      <div class="row" style="margin-top:6px;justify-content:flex-end">
        <button class="btn btn-sm btn-danger" data-del="${i}">Remove</button>
      </div>
    </div>`;
  });
  list.innerHTML = html;

  const rerenderHere = () => renderTOTypesForCompany(state, cid, container);
  const persist = () => saveTimeOff(state, cid).then(ok => { if (ok) setSyncIdle(); });

  list.querySelectorAll('input[data-i],select[data-i]').forEach(inp => {
    inp.onchange = () => {
      const i = +inp.dataset.i;
      const f = inp.dataset.f;
      let v = inp.value;
      if (f === 'poolDays' || f === 'hoursPerDay') v = +v;
      else if (f === 'countsAgainstPool' || f === 'additive') v = v === 'true';
      // Accrual fields: numbers blank → null (engine treats null as 0); the
      // anchor date blank → null. grantStyle/accrualAnchor/carryoverMode stay
      // strings.
      else if (f === 'waitingDays' || f === 'carryoverCap') v = inp.value.trim() === '' ? null : +v;
      else if (f === 'anchorDate') v = inp.value.trim() === '' ? null : v;
      types[i][f] = v;
      persist();
      // Toggling the anchor or carry-over mode shows/hides a conditional input.
      if (f === 'accrualAnchor' || f === 'carryoverMode') rerenderHere();
    };
  });
  list.querySelectorAll('button[data-del]').forEach(btn => {
    btn.onclick = () => {
      if (!confirm(`Remove ${types[+btn.dataset.del].label}?`)) return;
      types.splice(+btn.dataset.del, 1);
      persist();
      rerenderHere();
    };
  });
}

function renderCompaniesList(state) {
  const list = document.getElementById('companiesList');
  list.innerHTML = state.companies.length
    ? state.companies.map((c, i) => {
        const inactive = c.isActive === false;
        return `
      <div class="row" style="margin-bottom:6px;padding:6px 10px;background:var(--surface-2);border-radius:var(--radius)${inactive ? ';opacity:0.6' : ''}">
        <span class="grow">${escapeHtml(c.name)}${inactive ? ' <span class="muted">(inactive)</span>' : ''}</span>
        <button class="btn btn-sm" data-toggle="${i}">${inactive ? 'Activate' : 'Deactivate'}</button>
        ${inactive ? `<button class="btn btn-sm btn-danger" data-del="${i}">Delete</button>` : ''}
      </div>
    `;
      }).join('')
    : '<div class="muted">No companies yet.</div>';

  list.querySelectorAll('button[data-toggle]').forEach(b => {
    b.onclick = () => {
      const idx = +b.dataset.toggle;
      const company = state.companies[idx];
      if (!company) return;
      company.isActive = company.isActive === false;
      saveKey(SK.companies, state.companies, 'Companies').then(ok => { if (ok) setSyncIdle(); });
      renderCompaniesList(state);
      renderPerCompanyPayPeriod(state);
    };
  });

  list.querySelectorAll('button[data-del]').forEach(b => {
    b.onclick = async () => {
      const idx = +b.dataset.del;
      const company = state.companies[idx];
      if (!company) return;
      b.disabled = true;

      // Block hard-delete for companies that still have data. Counts are
      // head + exact so no rows are fetched, and RLS scopes them to the
      // current user's own rows (one-user-per-company today).
      const { count: entryCount } = await supabase
        .from('entries').select('*', { count: 'exact', head: true }).eq('company_id', company.id);
      const { count: payCount } = await supabase
        .from('pays').select('*', { count: 'exact', head: true }).eq('company_id', company.id);
      if ((entryCount || 0) > 0 || (payCount || 0) > 0) {
        b.disabled = false;
        alert(
          `${company.name} has ${entryCount || 0} entries and ${payCount || 0} paychecks, ` +
          'so it cannot be deleted. It stays archived.'
        );
        return;
      }

      const ok = confirm(
        `Permanently delete ${company.name}?\n\n` +
        'This company has no entries or paychecks. This cannot be undone.'
      );
      if (!ok) {
        b.disabled = false;
        return;
      }
      const deleted = await deleteCompany(company.id);
      if (!deleted) {
        b.disabled = false;
        toast('Could not delete company');
        return;
      }
      // Re-read from the store so state.companies reflects the persisted
      // rows (and the write-path snapshot is refreshed for future diffs).
      const companies = await Store.get(SK.companies, null);
      state.companies = migrateCompanies(companies || []);
      setSyncIdle();
      renderCompaniesList(state);
      renderPerCompanyPayPeriod(state);
      toast('Company deleted');
    };
  });
}

export function wireSettings(state, { saveAll }) {
  // Save handlers

  document.getElementById('btnSaveProfile').onclick = async () => {
    state.profile.name = document.getElementById('setName').value.trim() || 'You';
    state.profile.role = document.getElementById('setRole').value;
    if (!await saveKey(SK.profile, state.profile, 'Profile')) return;
    setSyncIdle();
    renderTopBar(state.profile);
    toast('Profile saved');
  };

  document.getElementById('btnAddCompany').onclick = async () => {
    const input = document.getElementById('newCompany');
    const btn = document.getElementById('btnAddCompany');
    const name = input.value.trim();
    if (!name) return;
    btn.disabled = true;
    try {
      const newId = await createCompany(name);
      // Re-read from the store so state.companies reflects the persisted
      // rows (and the write-path snapshot is refreshed for future diffs).
      const companies = await Store.get(SK.companies, null);
      state.companies = migrateCompanies(companies || []);
      input.value = '';
      setSyncIdle();
      renderCompaniesList(state);
      renderPerCompanyPayPeriod(state);
      toast('Company added');
      // New companies start blank, so prompt to fill in the important metadata
      // (skippable). Defaults stay if they choose "Set up later".
      if (newId) openCompanySetupModal(state, newId);
    } catch (e) {
      console.error('Add company failed:', e);
      toast('Could not add company');
    } finally {
      btn.disabled = false;
    }
  };

  // Data import/export
  document.getElementById('btnExport').onclick = () => {
    const dump = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      profile: state.profile,
      settings: state.settings,
      timeOffTypes: state.timeOffTypes,
      companies: state.companies,
      entries: state.entries,
      pays: state.pays,
    };
    download(`timesheet-export-${fmtDate(new Date())}.json`,
      JSON.stringify(dump, null, 2), 'application/json');
  };

  document.getElementById('btnExportCSV').onclick = () => {
    const rows = [['Date', 'Day', 'Segment', 'Clock In', 'Clock Out',
      'Break Minutes', 'Segment Hours', 'Day Total', 'Time Off', 'Notes']];
    const sorted = Object.values(state.entries).sort((a, b) => a.date.localeCompare(b.date));
    for (const e of sorted) {
      const segs = entrySegments(e);
      // Resolve break per entry from its own company so the CSV matches pay.
      const company = (state.companies || [])
        .find(c => String(c.id ?? '') === String(e.companyId ?? ''));
      const breakMin = resolveBreakMinutes(state.settings, company || null) || 0;
      const dayTotal = computeHours(e, state.settings, state.timeOffTypes, state.companies).toFixed(2);
      if (segs.length === 0) {
        rows.push([e.date, dayShort(e.date), '', '', '', '', '',
          dayTotal, e.timeOff || '', (e.notes || '').replace(/"/g, '""')]);
        continue;
      }
      segs.forEach((s, i) => {
        const sh = computeSegmentHours(s, e.date, state.settings, breakMin).toFixed(2);
        rows.push([
          e.date, dayShort(e.date), i + 1,
          s.clockIn || '', s.clockOut || '',
          s.breakTaken ? breakMin : 0,
          sh,
          i === 0 ? dayTotal : '',
          i === 0 ? (e.timeOff || '') : '',
          i === 0 ? (e.notes || '').replace(/"/g, '""') : '',
        ]);
      });
    }
    const csv = rows.map(r =>
      r.map(x => { const s = String(x); return /[",\n]/.test(s) ? `"${s}"` : s; }).join(',')
    ).join('\n');
    download(`entries-${fmtDate(new Date())}.csv`, csv, 'text/csv');
  };

  document.getElementById('btnImport').onclick = () =>
    document.getElementById('importFile').click();

  document.getElementById('importFile').onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!confirm('This will REPLACE all current data. Continue?')) return;
      if (data.profile) state.profile = data.profile;
      if (data.settings) state.settings = data.settings;
      if (data.timeOffTypes) state.timeOffTypes = data.timeOffTypes;
      if (data.companies) state.companies = migrateCompanies(data.companies);
      if (data.entries) state.entries = migrateEntries(data.entries);
      if (data.pays) state.pays = data.pays;
      await saveAll();
      // Import replaced state.timeOffTypes wholesale; re-point the active
      // company's per-company entry at the new array so the Settings editor and
      // the pay math stay on the same reference.
      syncActiveTimeOff();
      renderTopBar(state.profile);
      renderSettings(state);
      toast('Imported');
    } catch (e) {
      toast('Import failed: ' + e.message);
    }
  };

  document.getElementById('btnClearAll').onclick = async () => {
    if (!confirm('Erase ALL data including entries, paychecks, and settings? This cannot be undone.')) return;
    if (!confirm('Are you absolutely sure?')) return;
    await Promise.all(Object.values(SK).map(k => Store.del(k)));
    state.profile = { ...DEFAULT_PROFILE };
    state.settings = { ...DEFAULT_SETTINGS };
    state.timeOffTypes = JSON.parse(JSON.stringify(DEFAULT_TIME_OFF_TYPES));
    state.timeOffByCompany = {};
    state.companies = [];
    state.entries = {};
    state.pays = [];
    renderTopBar(state.profile);
    toast('All data cleared');
    location.reload();
  };
}

function download(filename, contents, mime) {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
