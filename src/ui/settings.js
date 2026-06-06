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
import { computeHours, computeSegmentHours, entrySegments, dayShort, fmtDate, timeToMinutes } from '../core/time.js';
import { setSyncIdle, renderTopBar } from './topbar.js';
import { toast } from './toast.js';
import { resolveStandardDay, computeStandardDayHours } from '../data/standardDay.js';
import { createCompany, deleteCompany } from '../data/bootstrap.js';
import { activeCompany } from '../data/activeCompany.js';
import { supabase } from '../data/supabase.js';

// UI state for the per-year override draft form.
// null when no draft is active. When active:
//   { companyId: string, typeIndex: number, year: string, days: string,
//     error: string|null }
// companyId scopes the draft to one company's time-off card so it never bleeds
// across tabs.
let pbyDraft = null;

export function renderSettings(state) {
  renderPerCompanyPayPeriod(state);
  const s = state.settings;
  setVal('setHoursBreak', s.breakMinutes);
  setVal('setName', state.profile.name || '');
  setVal('setRole', state.profile.role || 'owner');
  const sd = resolveStandardDay(s);
  setVal('setSdSeg1Start', sd.seg1Start || '');
  setVal('setSdSeg1End', sd.seg1End || '');
  setVal('setSdSeg2Start', sd.seg2Start || '');
  setVal('setSdSeg2End', sd.seg2End || '');
  refreshStandardDayUI();
  renderCompaniesList(state);
}

function readStandardDayForm() {
  return {
    seg1Start: document.getElementById('setSdSeg1Start').value || null,
    seg1End: document.getElementById('setSdSeg1End').value || null,
    seg2Start: document.getElementById('setSdSeg2Start').value || null,
    seg2End: document.getElementById('setSdSeg2End').value || null,
  };
}

function validateStandardDay(sd) {
  const segPair = (s, e, name) => {
    if (!!s !== !!e) return `${name} needs both start and end.`;
    if (s && e && timeToMinutes(e) <= timeToMinutes(s)) {
      return `${name} end must be after start.`;
    }
    return null;
  };
  const e1 = segPair(sd.seg1Start, sd.seg1End, 'Segment 1');
  if (e1) return e1;
  const e2 = segPair(sd.seg2Start, sd.seg2End, 'Segment 2');
  if (e2) return e2;
  return null;
}

function refreshStandardDayUI() {
  const sd = readStandardDayForm();
  const err = validateStandardDay(sd);
  const totalEl = document.getElementById('setSdTotal');
  const errEl = document.getElementById('setSdError');
  const btn = document.getElementById('btnSaveStandardDay');
  // Source break minutes from the Hours card input live, so edits there
  // reflect in the Standard Day total immediately.
  const breakMin = parseFloat(document.getElementById('setHoursBreak')?.value);
  totalEl.textContent = err ? '—' : computeStandardDayHours(sd, breakMin).toFixed(2);
  if (err) {
    errEl.textContent = err;
    errEl.style.display = '';
    btn.disabled = true;
  } else {
    errEl.textContent = '';
    errEl.style.display = 'none';
    btn.disabled = false;
  }
}

function setVal(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v;
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

  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const FREQ_OPTIONS = [
    ['weekly',      'Weekly'],
    ['biweekly',    'Bi-weekly'],
    ['semimonthly', 'Semi-monthly'],
    ['monthly',     'Monthly'],
    ['advanced',    'Advanced'],
  ];

  let html = '';
  for (const c of activeCompanies) {
    const freq = c.payFrequency || 'biweekly';
    const wsd = c.weekStartDow ?? 1;
    const otPeriod = c.otPeriod || 'weekly';
    const otThreshold = c.otThreshold ?? 40;

    const freqHtml = FREQ_OPTIONS.map(([v, label]) =>
      `<option value="${v}"${v === freq ? ' selected' : ''}>${label}</option>`
    ).join('');
    const dowHtml = DOW_LABELS.map((label, i) =>
      `<option value="${i}"${i === wsd ? ' selected' : ''}>${label}</option>`
    ).join('');

    // All conditional groups are always rendered; only the one matching the
    // current frequency is visible. Visibility + defaults are toggled in the
    // wiring below as the frequency changes. Values render stored-or-empty;
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

    const cardHidden = String(c.id ?? '') === selectedId ? '' : 'display:none;';
    html += `<div data-company-id="${escapeHtml(c.id ?? '')}" style="${cardHidden}border:1px solid var(--border); border-radius:var(--radius); padding:10px; margin-bottom:8px">
      <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:6px">
        <div style="font-weight:600">${escapeHtml(c.name)}</div>
      </div>
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
    const freqSel = ppFieldEl(card, 'payFrequency');
    if (!freqSel) return;
    freqSel.onchange = () => {
      showPpGroupFor(card, freqSel.value);
      applyPpGroupDefaults(card, freqSel.value);
      updatePpCardPreview(card);
    };
    card.querySelectorAll('[data-pp-field]').forEach(el => {
      if (el === freqSel) return;
      el.onchange = () => updatePpCardPreview(card);
    });
    // Fill empty fields in the initially-visible group so its preview is valid.
    applyPpGroupDefaults(card, freqSel.value);

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
  };
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
// key). The per-year draft form is scoped to this company via pbyDraft.companyId.
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
    let pbyHtml = '';
    if (t.countsAgainstPool && !t.sharedPoolWith) {
      const overrides = t.poolByYear || {};
      const years = Object.keys(overrides).sort();
      const rowsHtml = years.length === 0
        ? `<div class="muted" style="font-size:0.85em; margin-bottom:6px">No overrides. Default pool of ${t.poolDays || 0} days applies to all years.</div>`
        : years.map(y => `
          <div class="row" style="margin-bottom:4px; align-items:flex-end; gap:6px">
            <div style="flex:0 0 90px"><label>Year</label>
              <input type="number" data-pby-i="${i}" data-pby-year="${y}" data-pby-f="year" min="2000" max="2100" step="1" value="${y}"></div>
            <div style="flex:0 0 110px"><label>Days</label>
              <input type="number" data-pby-i="${i}" data-pby-year="${y}" data-pby-f="days" min="0" step="0.5" value="${overrides[y]}"></div>
            <button class="btn btn-sm" data-pby-del="${i}:${y}">Remove</button>
          </div>`).join('');
      const isDraftHere = pbyDraft && pbyDraft.companyId === cid && pbyDraft.typeIndex === i;
      let pbyAddSection = '';
      if (isDraftHere) {
        const errHtml = pbyDraft.error
          ? `<div class="muted" style="font-size:0.8em; color:var(--danger); margin-top:4px">${pbyDraft.error}</div>`
          : '';
        pbyAddSection = `
          <div style="margin-top:8px; padding:8px; border:1px dashed var(--border); border-radius:var(--radius)">
            <div class="muted" style="font-size:0.85em; margin-bottom:6px">Add new override</div>
            <div class="row" style="align-items:flex-end; gap:6px">
              <div style="flex:0 0 90px"><label>Year</label>
                <input type="number" id="pbyDraftYear" min="2000" max="2100" step="1" value="${pbyDraft.year}" placeholder="e.g. 2025"></div>
              <div style="flex:0 0 110px"><label>Days</label>
                <input type="number" id="pbyDraftDays" min="0" step="0.5" value="${pbyDraft.days}" placeholder="e.g. 6"></div>
              <button class="btn btn-sm btn-primary" id="pbyDraftAdd">Add</button>
              <button class="btn btn-sm" id="pbyDraftCancel">Cancel</button>
            </div>
            ${errHtml}
          </div>`;
      } else {
        pbyAddSection = `<button class="btn btn-sm" data-pby-add="${i}" style="margin-top:8px">Add year override</button>`;
      }
      pbyHtml = `<div style="margin-top:8px; padding-top:8px; border-top:1px dashed var(--border)">
        <div class="muted" style="font-size:0.85em; margin-bottom:2px">Per-year overrides</div>
        <div class="muted" style="font-size:0.75em; margin-bottom:6px; font-style:italic">Applies to this company's policy only.</div>
        ${rowsHtml}
        ${pbyAddSection}
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
      ${pbyHtml}
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
      types[i][f] = v;
      persist();
    };
  });
  list.querySelectorAll('input[data-pby-i]').forEach(inp => {
    inp.onchange = () => {
      const i = +inp.dataset.pbyI;
      const oldYear = inp.dataset.pbyYear;
      const f = inp.dataset.pbyF;
      const t = types[i];
      if (!t.poolByYear) t.poolByYear = {};
      if (f === 'year') {
        const parsed = parseInt(inp.value, 10);
        if (!Number.isFinite(parsed) || parsed < 2000 || parsed > 2100) {
          rerenderHere();
          return;
        }
        const newYear = String(parsed);
        if (newYear === oldYear) return;
        const existingDays = t.poolByYear[oldYear];
        delete t.poolByYear[oldYear];
        t.poolByYear[newYear] = existingDays;
      } else if (f === 'days') {
        t.poolByYear[oldYear] = +inp.value;
      }
      if (Object.keys(t.poolByYear).length === 0) delete t.poolByYear;
      persist();
      rerenderHere();
    };
  });
  list.querySelectorAll('button[data-pby-del]').forEach(btn => {
    btn.onclick = () => {
      const [iStr, y] = btn.dataset.pbyDel.split(':');
      const t = types[+iStr];
      if (t.poolByYear) {
        delete t.poolByYear[y];
        if (Object.keys(t.poolByYear).length === 0) delete t.poolByYear;
      }
      persist();
      rerenderHere();
    };
  });
  list.querySelectorAll('button[data-pby-add]').forEach(btn => {
    btn.onclick = () => {
      pbyDraft = {
        companyId: cid,
        typeIndex: +btn.dataset.pbyAdd,
        year: '',
        days: '',
        error: null,
      };
      rerenderHere();
    };
  });

  const draftYearInput = list.querySelector('#pbyDraftYear');
  const draftDaysInput = list.querySelector('#pbyDraftDays');
  const draftAddBtn = list.querySelector('#pbyDraftAdd');
  const draftCancelBtn = list.querySelector('#pbyDraftCancel');

  if (draftYearInput) {
    draftYearInput.oninput = () => { pbyDraft.year = draftYearInput.value; };
  }
  if (draftDaysInput) {
    draftDaysInput.oninput = () => { pbyDraft.days = draftDaysInput.value; };
  }
  if (draftCancelBtn) {
    draftCancelBtn.onclick = () => {
      pbyDraft = null;
      rerenderHere();
    };
  }
  if (draftAddBtn) {
    draftAddBtn.onclick = () => {
      const yr = parseInt(pbyDraft.year, 10);
      const days = parseFloat(pbyDraft.days);
      if (!Number.isFinite(yr) || yr < 2000 || yr > 2100) {
        pbyDraft.error = 'Year must be between 2000 and 2100.';
        rerenderHere();
        return;
      }
      if (!Number.isFinite(days) || days < 0) {
        pbyDraft.error = 'Days must be 0 or greater.';
        rerenderHere();
        return;
      }
      const t = types[pbyDraft.typeIndex];
      if (!t.poolByYear) t.poolByYear = {};
      const yrKey = String(yr);
      if (t.poolByYear[yrKey] != null) {
        pbyDraft.error = `Override for ${yrKey} already exists. Edit the existing row instead.`;
        rerenderHere();
        return;
      }
      t.poolByYear[yrKey] = days;
      pbyDraft = null;
      persist();
      rerenderHere();
    };
  }
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

  document.getElementById('btnSaveHours').onclick = async () => {
    state.settings.breakMinutes = parseFloat(document.getElementById('setHoursBreak').value) || 0;
    if (!await saveKey(SK.settings, state.settings, 'Settings')) return;
    setSyncIdle();
    toast('Hours settings saved');
  };

  document.getElementById('btnSaveProfile').onclick = async () => {
    state.profile.name = document.getElementById('setName').value.trim() || 'You';
    state.profile.role = document.getElementById('setRole').value;
    if (!await saveKey(SK.profile, state.profile, 'Profile')) return;
    setSyncIdle();
    renderTopBar(state.profile);
    toast('Profile saved');
  };

  // setHoursBreak lives on the Hours card but feeds Standard Day's live
  // total, so re-render that card when it changes too.
  ['setSdSeg1Start', 'setSdSeg1End', 'setSdSeg2Start', 'setSdSeg2End', 'setHoursBreak']
    .forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', refreshStandardDayUI);
    });

  document.getElementById('btnSaveStandardDay').onclick = async () => {
    const sd = readStandardDayForm();
    if (validateStandardDay(sd)) return;
    state.settings.standard_day = sd;
    if (!await saveKey(SK.settings, state.settings, 'Settings')) return;
    setSyncIdle();
    toast('Standard day saved');
  };

  document.getElementById('btnAddCompany').onclick = async () => {
    const input = document.getElementById('newCompany');
    const btn = document.getElementById('btnAddCompany');
    const name = input.value.trim();
    if (!name) return;
    btn.disabled = true;
    try {
      await createCompany(name);
      // Re-read from the store so state.companies reflects the persisted
      // rows (and the write-path snapshot is refreshed for future diffs).
      const companies = await Store.get(SK.companies, null);
      state.companies = migrateCompanies(companies || []);
      input.value = '';
      setSyncIdle();
      renderCompaniesList(state);
      renderPerCompanyPayPeriod(state);
      toast('Company added');
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
    const breakMin = state.settings.breakMinutes || 0;
    for (const e of sorted) {
      const segs = entrySegments(e);
      const dayTotal = computeHours(e, state.settings, state.timeOffTypes).toFixed(2);
      if (segs.length === 0) {
        rows.push([e.date, dayShort(e.date), '', '', '', '', '',
          dayTotal, e.timeOff || '', (e.notes || '').replace(/"/g, '""')]);
        continue;
      }
      segs.forEach((s, i) => {
        const sh = computeSegmentHours(s, e.date, state.settings).toFixed(2);
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
