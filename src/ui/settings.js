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
import {
  SK, SCHEMA_VERSION, DEFAULT_PROFILE, DEFAULT_SETTINGS,
  DEFAULT_TIME_OFF_TYPES, migrateEntries,
} from '../data/schema.js';
import { getPayPeriodFor } from '../core/period.js';
import { clampDom } from '../core/period.js';
import { escapeHtml, formatLong } from '../core/format.js';
import { computeHours, computeSegmentHours, entrySegments, dayShort, fmtDate } from '../core/time.js';
import { setSyncIdle, renderTopBar } from './topbar.js';
import { toast } from './toast.js';

export function renderSettings(state) {
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
  refreshPPSettingsUI(state);
  renderTOTypes(state);
  renderCompaniesList(state);
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
  const sys = document.getElementById('setSystem').value;
  const tmp = {
    ...state.settings,
    system: sys,
    startDow: +document.getElementById('setStartDow').value,
    biweeklyRef: document.getElementById('setBiweeklyRef').value
      || state.settings.biweeklyRef || '2025-12-29',
    semi1: clampDom(document.getElementById('setSemi1').value),
    semi2: clampDom(document.getElementById('setSemi2').value),
    monthlyStart: clampDom(document.getElementById('setMonthlyStart').value),
    anchorDate: document.getElementById('setAnchor').value
      || state.settings.anchorDate || '2025-12-29',
    cycleDays: +document.getElementById('setCycleDays').value || 14,
  };
  try {
    const pp = getPayPeriodFor('current', null, tmp);
    document.getElementById('setPreview').textContent =
      `${formatLong(pp.start)} → ${formatLong(pp.end)} (${pp.cycleDays} days)`;
  } catch (err) {
    document.getElementById('setPreview').textContent =
      'Invalid configuration: ' + err.message;
  }
}

function renderTOTypes(state) {
  const list = document.getElementById('timeOffTypesList');
  let html = '';
  state.timeOffTypes.forEach((t, i) => {
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
        <div class="grow"><label>Shares pool with</label>
          <select data-i="${i}" data-f="sharedPoolWith">
            <option value="">— None —</option>
            ${state.timeOffTypes.filter((x, j) => j !== i).map(x =>
              `<option value="${x.code}" ${t.sharedPoolWith === x.code ? 'selected' : ''}>${x.code}</option>`
            ).join('')}
          </select></div>
      </div>
      <div class="row" style="margin-top:6px;justify-content:flex-end">
        <button class="btn btn-sm btn-danger" data-del="${i}">Remove</button>
      </div>
    </div>`;
  });
  list.innerHTML = html;

  list.querySelectorAll('input,select').forEach(inp => {
    inp.onchange = () => {
      const i = +inp.dataset.i;
      const f = inp.dataset.f;
      let v = inp.value;
      if (f === 'poolDays' || f === 'hoursPerDay') v = +v;
      else if (f === 'countsAgainstPool') v = v === 'true';
      state.timeOffTypes[i][f] = v;
      Store.set(SK.timeOff, state.timeOffTypes).then(() => setSyncIdle());
    };
  });
  list.querySelectorAll('button[data-del]').forEach(btn => {
    btn.onclick = () => {
      if (!confirm(`Remove ${state.timeOffTypes[+btn.dataset.del].label}?`)) return;
      state.timeOffTypes.splice(+btn.dataset.del, 1);
      Store.set(SK.timeOff, state.timeOffTypes).then(() => setSyncIdle());
      renderTOTypes(state);
    };
  });
}

function renderCompaniesList(state) {
  const list = document.getElementById('companiesList');
  list.innerHTML = state.companies.length
    ? state.companies.map((c, i) => `
      <div class="row" style="margin-bottom:6px;padding:6px 10px;background:var(--surface-2);border-radius:var(--radius)">
        <span class="grow">${escapeHtml(c.name)}</span>
        <button class="btn btn-sm btn-danger" data-del="${i}">Remove</button>
      </div>
    `).join('')
    : '<div class="muted">No companies yet.</div>';

  list.querySelectorAll('button[data-del]').forEach(b => {
    b.onclick = () => {
      const idx = +b.dataset.del;
      if (!confirm(`Remove ${state.companies[idx].name}?`)) return;
      state.companies.splice(idx, 1);
      Store.set(SK.companies, state.companies).then(() => setSyncIdle());
      renderCompaniesList(state);
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
    await Store.set(SK.settings, state.settings);
    setSyncIdle();
    toast('Pay-period settings saved');
  };

  document.getElementById('btnSaveProfile').onclick = async () => {
    state.profile.name = document.getElementById('setName').value.trim() || 'You';
    state.profile.role = document.getElementById('setRole').value;
    await Store.set(SK.profile, state.profile);
    setSyncIdle();
    renderTopBar(state.profile);
    toast('Profile saved');
  };

  document.getElementById('btnAddTOType').onclick = () => {
    state.timeOffTypes.push({
      code: 'NEW', label: 'New Type',
      poolDays: 0, hoursPerDay: 8, countsAgainstPool: false,
    });
    Store.set(SK.timeOff, state.timeOffTypes).then(() => setSyncIdle());
    renderTOTypes(state);
  };

  document.getElementById('btnAddCompany').onclick = () => {
    const name = document.getElementById('newCompany').value.trim();
    if (!name) return;
    state.companies.push({ id: name.toLowerCase().replace(/\s+/g, '-'), name });
    document.getElementById('newCompany').value = '';
    Store.set(SK.companies, state.companies).then(() => setSyncIdle());
    renderCompaniesList(state);
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
    const rows = [['Date', 'Day', 'Segment', 'Clock In', 'Break Start',
      'Break End', 'Clock Out', 'Segment Hours', 'Day Total', 'Time Off', 'Notes']];
    const sorted = Object.values(state.entries).sort((a, b) => a.date.localeCompare(b.date));
    for (const e of sorted) {
      const segs = entrySegments(e);
      const dayTotal = computeHours(e, state.settings).toFixed(2);
      if (segs.length === 0) {
        rows.push([e.date, dayShort(e.date), '', '', '', '', '', '',
          dayTotal, e.timeOff || '', (e.notes || '').replace(/"/g, '""')]);
        continue;
      }
      segs.forEach((s, i) => {
        const sh = computeSegmentHours(s, e.date, state.settings).toFixed(2);
        rows.push([
          e.date, dayShort(e.date), i + 1,
          s.clockIn || '', s.breakStart || '', s.breakEnd || '', s.clockOut || '',
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
      if (data.companies) state.companies = data.companies;
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
