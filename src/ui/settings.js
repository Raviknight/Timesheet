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
import { saveKey } from '../app.js';
import {
  SK, SCHEMA_VERSION, DEFAULT_PROFILE, DEFAULT_SETTINGS,
  DEFAULT_TIME_OFF_TYPES, migrateEntries, migrateCompanies,
} from '../data/schema.js';
import { getPayPeriodFor, periodLengthDays } from '../core/payPeriod.js';
import { clampDom } from '../core/period.js';
import { activeCompany } from '../data/activeCompany.js';
import { escapeHtml, formatLong } from '../core/format.js';
import { computeHours, computeSegmentHours, entrySegments, dayShort, fmtDate, timeToMinutes } from '../core/time.js';
import { setSyncIdle, renderTopBar } from './topbar.js';
import { toast } from './toast.js';
import { resolveStandardDay, computeStandardDayHours } from '../data/standardDay.js';
import { createCompany, deleteCompany } from '../data/bootstrap.js';
import { supabase } from '../data/supabase.js';

// UI state for the per-year override draft form.
// null when no draft is active. When active:
//   { typeIndex: number, year: string, days: string, error: string|null }
let pbyDraft = null;

export function renderSettings(state) {
  renderPerCompanyPayPeriod(state);
  const s = state.settings;
  setVal('setSystem', s.system || 'biweekly');
  setVal('setStartDow', s.startDow ?? 1);
  setVal('setBiweeklyRef', s.biweeklyRef || s.anchorDate || '');
  setVal('setSemi1', s.semi1 || 1);
  setVal('setSemi2', s.semi2 || 16);
  setVal('setMonthlyStart', s.monthlyStart || 1);
  setVal('setAnchor', s.anchorDate || '');
  setVal('setCycleDays', s.cycleDays || 14);
  setVal('setOTThreshold', s.otThreshold);
  setVal('setBreakMin', s.breakMinutes);
  setVal('setName', state.profile.name || '');
  setVal('setRole', state.profile.role || 'owner');
  const sd = resolveStandardDay(s);
  setVal('setSdSeg1Start', sd.seg1Start || '');
  setVal('setSdSeg1End', sd.seg1End || '');
  setVal('setSdSeg2Start', sd.seg2Start || '');
  setVal('setSdSeg2End', sd.seg2End || '');
  refreshStandardDayUI();
  refreshPPSettingsUI(state);
  renderTOTypes(state);
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
  // Source break minutes from the Pay Period form input live, so edits
  // to either card reflect in the Standard Day total immediately.
  const breakMin = parseFloat(document.getElementById('setBreakMin')?.value);
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

function refreshPPSettingsUI(state) {
  const sys = document.getElementById('setSystem').value;
  document.getElementById('setStartDowRow').style.display =
    (sys === 'weekly' || sys === 'biweekly') ? 'flex' : 'none';
  document.getElementById('setBiweeklyRefRow').style.display =
    sys === 'biweekly' ? 'block' : 'none';
  document.getElementById('setSemiMonthlyRow').style.display =
    sys === 'semimonthly' ? 'flex' : 'none';
  document.getElementById('setMonthlyRow').style.display =
    sys === 'monthly' ? 'flex' : 'none';
  document.getElementById('setAdvancedRow').style.display =
    sys === 'advanced' ? 'block' : 'none';

  const helps = {
    weekly: 'Each pay period is one week, starting on the selected day.',
    biweekly: 'Two-week cycle. Pick the start day and any past period-start date.',
    semimonthly: 'Two periods per month at fixed days-of-month (e.g. 1st and 16th).',
    monthly: 'One period per month starting on the chosen day.',
    advanced: 'Periods of any length, anchored to a custom start date.',
  };
  document.getElementById('systemHelp').textContent = helps[sys] || '';
  refreshPPPreview(state);
}

function refreshPPPreview(state) {
  // Per 3e.3: the preview reads from the active company, not the form.
  // The Pay Period card's old inputs still bind to legacy settings keys
  // that the new payPeriod module no longer consults; per-company form
  // editing lands in 3e.5.
  const company = activeCompany(state);
  try {
    const pp = getPayPeriodFor('current', null, company);
    const days = periodLengthDays(pp.start, pp.end);
    document.getElementById('setPreview').textContent =
      `${formatLong(pp.start)} → ${formatLong(pp.end)} (${days} days)`;
  } catch (err) {
    document.getElementById('setPreview').textContent =
      'Invalid configuration: ' + err.message;
  }
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

    html += `<div data-company-id="${escapeHtml(c.id ?? '')}" style="border:1px solid var(--border); border-radius:var(--radius); padding:10px; margin-bottom:8px">
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
      <div class="stat" style="margin-top:8px;background:var(--surface-2)">
        <div class="stat-label">Current period preview</div>
        <div data-pp-preview style="font-size:14px;font-weight:500;margin-top:4px">${previewText}</div>
      </div>
    </div>`;
  }
  list.innerHTML = html;

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
  });
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
  const freq = ppFieldEl(card, 'payFrequency').value;
  const temp = {
    payFrequency: freq,
    weekStartDow: +ppFieldEl(card, 'weekStartDow').value,
  };
  if (freq === 'biweekly') {
    temp.biweeklyStartParity = ppFieldEl(card, 'biweeklyStartParity').value;
  } else if (freq === 'semimonthly') {
    temp.semiFirstDay = +ppFieldEl(card, 'semiFirstDay').value;
    temp.semiSecondDay = +ppFieldEl(card, 'semiSecondDay').value;
  } else if (freq === 'monthly') {
    temp.monthlyStartDay = +ppFieldEl(card, 'monthlyStartDay').value;
  } else if (freq === 'advanced') {
    temp.advancedAnchorDate = ppFieldEl(card, 'advancedAnchorDate').value || null;
    temp.advancedCycleDays = +ppFieldEl(card, 'advancedCycleDays').value;
  }
  try {
    const pp = getPayPeriodFor('current', null, temp);
    const days = periodLengthDays(pp.start, pp.end);
    out.textContent = `${formatLong(pp.start)} → ${formatLong(pp.end)} (${days} days)`;
  } catch (err) {
    out.textContent = 'Complete the fields to preview';
  }
}

function renderTOTypes(state) {
  const list = document.getElementById('timeOffTypesList');
  let html = '';
  state.timeOffTypes.forEach((t, i) => {
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
      const isDraftHere = pbyDraft && pbyDraft.typeIndex === i;
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
            ${state.timeOffTypes.filter((x, j) => j !== i).map(x =>
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

  list.querySelectorAll('input[data-i],select[data-i]').forEach(inp => {
    inp.onchange = () => {
      const i = +inp.dataset.i;
      const f = inp.dataset.f;
      let v = inp.value;
      if (f === 'poolDays' || f === 'hoursPerDay') v = +v;
      else if (f === 'countsAgainstPool' || f === 'additive') v = v === 'true';
      state.timeOffTypes[i][f] = v;
      saveKey(SK.timeOff, state.timeOffTypes, 'Time off').then(ok => { if (ok) setSyncIdle(); });
    };
  });
  list.querySelectorAll('input[data-pby-i]').forEach(inp => {
    inp.onchange = () => {
      const i = +inp.dataset.pbyI;
      const oldYear = inp.dataset.pbyYear;
      const f = inp.dataset.pbyF;
      const t = state.timeOffTypes[i];
      if (!t.poolByYear) t.poolByYear = {};
      if (f === 'year') {
        const parsed = parseInt(inp.value, 10);
        if (!Number.isFinite(parsed) || parsed < 2000 || parsed > 2100) {
          renderTOTypes(state);
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
      saveKey(SK.timeOff, state.timeOffTypes, 'Time off').then(ok => { if (ok) setSyncIdle(); });
      renderTOTypes(state);
    };
  });
  list.querySelectorAll('button[data-pby-del]').forEach(btn => {
    btn.onclick = () => {
      const [iStr, y] = btn.dataset.pbyDel.split(':');
      const t = state.timeOffTypes[+iStr];
      if (t.poolByYear) {
        delete t.poolByYear[y];
        if (Object.keys(t.poolByYear).length === 0) delete t.poolByYear;
      }
      saveKey(SK.timeOff, state.timeOffTypes, 'Time off').then(ok => { if (ok) setSyncIdle(); });
      renderTOTypes(state);
    };
  });
  list.querySelectorAll('button[data-pby-add]').forEach(btn => {
    btn.onclick = () => {
      pbyDraft = {
        typeIndex: +btn.dataset.pbyAdd,
        year: '',
        days: '',
        error: null,
      };
      renderTOTypes(state);
    };
  });

  const draftYearInput = document.getElementById('pbyDraftYear');
  const draftDaysInput = document.getElementById('pbyDraftDays');
  const draftAddBtn = document.getElementById('pbyDraftAdd');
  const draftCancelBtn = document.getElementById('pbyDraftCancel');

  if (draftYearInput) {
    draftYearInput.oninput = () => { pbyDraft.year = draftYearInput.value; };
  }
  if (draftDaysInput) {
    draftDaysInput.oninput = () => { pbyDraft.days = draftDaysInput.value; };
  }
  if (draftCancelBtn) {
    draftCancelBtn.onclick = () => {
      pbyDraft = null;
      renderTOTypes(state);
    };
  }
  if (draftAddBtn) {
    draftAddBtn.onclick = () => {
      const yr = parseInt(pbyDraft.year, 10);
      const days = parseFloat(pbyDraft.days);
      if (!Number.isFinite(yr) || yr < 2000 || yr > 2100) {
        pbyDraft.error = 'Year must be between 2000 and 2100.';
        renderTOTypes(state);
        return;
      }
      if (!Number.isFinite(days) || days < 0) {
        pbyDraft.error = 'Days must be 0 or greater.';
        renderTOTypes(state);
        return;
      }
      const t = state.timeOffTypes[pbyDraft.typeIndex];
      if (!t.poolByYear) t.poolByYear = {};
      const yrKey = String(yr);
      if (t.poolByYear[yrKey] != null) {
        pbyDraft.error = `Override for ${yrKey} already exists. Edit the existing row instead.`;
        renderTOTypes(state);
        return;
      }
      t.poolByYear[yrKey] = days;
      pbyDraft = null;
      saveKey(SK.timeOff, state.timeOffTypes, 'Time off').then(ok => { if (ok) setSyncIdle(); });
      renderTOTypes(state);
    };
  }
  list.querySelectorAll('button[data-del]').forEach(btn => {
    btn.onclick = () => {
      if (!confirm(`Remove ${state.timeOffTypes[+btn.dataset.del].label}?`)) return;
      state.timeOffTypes.splice(+btn.dataset.del, 1);
      saveKey(SK.timeOff, state.timeOffTypes, 'Time off').then(ok => { if (ok) setSyncIdle(); });
      renderTOTypes(state);
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
      state.companies = migrateCompanies(companies || [], state.settings);
      setSyncIdle();
      renderCompaniesList(state);
      renderPerCompanyPayPeriod(state);
      toast('Company deleted');
    };
  });
}

export function wireSettings(state, { saveAll }) {
  // Save handlers
  document.getElementById('btnSavePP').onclick = async () => {
    state.settings.system = document.getElementById('setSystem').value;
    state.settings.startDow = +document.getElementById('setStartDow').value;
    state.settings.biweeklyRef = document.getElementById('setBiweeklyRef').value
      || state.settings.biweeklyRef || '2025-12-29';
    state.settings.semi1 = clampDom(document.getElementById('setSemi1').value);
    state.settings.semi2 = clampDom(document.getElementById('setSemi2').value);
    state.settings.monthlyStart = clampDom(document.getElementById('setMonthlyStart').value);
    state.settings.anchorDate = document.getElementById('setAnchor').value
      || state.settings.anchorDate || '2025-12-29';
    state.settings.cycleDays = +document.getElementById('setCycleDays').value || 14;
    state.settings.otThreshold = parseFloat(document.getElementById('setOTThreshold').value) || 40;
    state.settings.breakMinutes = parseFloat(document.getElementById('setBreakMin').value) || 0;
    if (!await saveKey(SK.settings, state.settings, 'Settings')) return;
    setSyncIdle();
    toast('Pay-period settings saved');
  };

  document.getElementById('btnSaveProfile').onclick = async () => {
    state.profile.name = document.getElementById('setName').value.trim() || 'You';
    state.profile.role = document.getElementById('setRole').value;
    if (!await saveKey(SK.profile, state.profile, 'Profile')) return;
    setSyncIdle();
    renderTopBar(state.profile);
    toast('Profile saved');
  };

  // setBreakMin lives on the Pay Period card but feeds Standard Day's
  // live total, so re-render that card when it changes too.
  ['setSdSeg1Start', 'setSdSeg1End', 'setSdSeg2Start', 'setSdSeg2End', 'setBreakMin']
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

  document.getElementById('btnAddTOType').onclick = () => {
    state.timeOffTypes.push({
      code: 'NEW', label: 'New Type',
      poolDays: 0, hoursPerDay: 8, countsAgainstPool: false, additive: false,
    });
    saveKey(SK.timeOff, state.timeOffTypes, 'Time off').then(ok => { if (ok) setSyncIdle(); });
    renderTOTypes(state);
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
      state.companies = migrateCompanies(companies || [], state.settings);
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

  // Live preview of pay period changes
  ['setSystem', 'setStartDow', 'setBiweeklyRef', 'setSemi1', 'setSemi2',
    'setMonthlyStart', 'setAnchor', 'setCycleDays'].forEach(id => {
    document.addEventListener('change', ev => {
      if (ev.target?.id === id) refreshPPSettingsUI(state);
    });
    document.addEventListener('input', ev => {
      if (ev.target?.id === id) refreshPPPreview(state);
    });
  });

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
      if (data.companies) state.companies = migrateCompanies(data.companies, state.settings);
      if (data.entries) state.entries = migrateEntries(data.entries);
      if (data.pays) state.pays = data.pays;
      await saveAll();
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
