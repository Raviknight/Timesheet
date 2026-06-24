/**
 * src/modals/estimateModal.js
 *
 * Paycheck estimator modal. Personal-planning tool. Computes federal + FICA +
 * state + local + payroll add-ons from a per-paycheck gross plus the user's
 * deductions. Never stores the gross, hourly rate, hours, or any other dollar
 * amount; only structural inputs persist.
 *
 * Pay types:
 *   - 'salary'   : one gross amount, marked as either per-period or annual
 *   - 'hourly'   : regular hrs + OT hrs (1.5x) + double-time hrs (2x) at a rate
 *   - 'multiple' : list of salary or hourly income sources, summed
 *
 * The result is clearly labeled an estimate. This is NOT actual payroll
 * withholding and must not be relied on for tax filing.
 */

import { estimatePaycheck, periodsPerYear } from '../core/estimator.js';
import { listStates, requiresUserRate } from '../core/tax.js';
import { formatMoney, formatMoneyDecimal, escapeHtml } from '../core/format.js';
import {
  getEstimatorSettings,
  saveEstimatorSettings,
  appendEstimateHistory,
  loadEstimateHistory,
  deleteEstimateHistory,
} from '../data/storage.js';
import { toast } from '../ui/toast.js';

let work = null;
let lastResult = null;

const FREQ_OPTIONS = [
  { value: 52, label: 'Weekly (52)' },
  { value: 26, label: 'Biweekly (26)' },
  { value: 24, label: 'Semi-monthly (24)' },
  { value: 12, label: 'Monthly (12)' },
];

const FILING_OPTIONS = [
  { value: 'single', label: 'Single' },
  { value: 'mfj',    label: 'Married Filing Jointly' },
  { value: 'hoh',    label: 'Head of Household' },
];

const DEDUCTION_TYPES = [
  { value: 'pre-tax-401k',       label: '401(k) / 403(b) (pre-tax, federal+state)' },
  { value: 'pre-tax-section125', label: 'HSA / FSA / health premium (Section 125, all taxes)' },
  { value: 'post-tax',           label: 'Roth or other post-tax' },
];

// Preset menu next to "+ Blank row". Picking a preset adds a new row pre-filled
// with name + tax-treatment type, leaving the amount for the user to fill.
const DEDUCTION_PRESETS = {
  health:     { name: 'Health insurance premium',   type: 'pre-tax-section125' },
  dental:     { name: 'Dental insurance premium',   type: 'pre-tax-section125' },
  vision:     { name: 'Vision insurance premium',   type: 'pre-tax-section125' },
  hsa:        { name: 'HSA contribution',           type: 'pre-tax-section125' },
  fsa:        { name: 'FSA contribution',           type: 'pre-tax-section125' },
  '401k':     { name: '401(k) contribution',        type: 'pre-tax-401k' },
  '403b':     { name: '403(b) contribution',        type: 'pre-tax-401k' },
  roth401k:   { name: 'Roth 401(k) contribution',   type: 'post-tax' },
  life:       { name: 'Life insurance (over $50K)', type: 'post-tax' },
  disability: { name: 'Disability insurance',       type: 'post-tax' },
};

export function initEstimateModal() {
  document.getElementById('btnCloseEstimate').onclick    = closeEstimateModal;
  document.getElementById('btnSaveEstimateTemplate').onclick = onSaveTemplate;
  document.getElementById('btnSaveEstimateHistory').onclick  = onSaveHistory;
  document.getElementById('btnAddDeduction').onclick     = onAddBlankDeduction;
  document.getElementById('btnAddSource').onclick        = onAddSource;
  document.getElementById('btnViewEstimateHistory').onclick  = onToggleHistory;

  document.getElementById('estimateModal').onclick = (e) => {
    if (e.target.id === 'estimateModal') closeEstimateModal();
  };

  // Pay-type and salary-mode toggles drive UI visibility AND recompute.
  document.getElementById('estPayType').addEventListener('change', (ev) => {
    work.payType = ev.target.value;
    updatePayTypeVisibility();
    recompute();
  });
  document.getElementById('estSalaryMode').addEventListener('change', (ev) => {
    work.salaryMode = ev.target.value;
    recompute();
  });

  // Salary / hourly numeric inputs — never persisted, transient only.
  numericInput('estSalaryAmount', 'salaryAmount');
  numericInput('estHourlyRate',   'hourlyRate');
  numericInput('estRegHours',     'regHours');
  numericInput('estOtHours',      'otHours');
  numericInput('estDtHours',      'dtHours');

  // Top-level fields that DO persist on save.
  document.getElementById('estFrequency').addEventListener('input', (ev) => {
    work.payPeriodsPerYear = parseInt(ev.target.value, 10) || 26;
    recompute();
  });
  document.getElementById('estState').addEventListener('input', (ev) => {
    work.state = ev.target.value || null;
    updateLocalityVisibility();
    recompute();
  });
  document.getElementById('estFiling').addEventListener('input', (ev) => {
    work.filingStatus = ev.target.value;
    updateLocalityVisibility();
    recompute();
  });
  document.getElementById('estStateRate').addEventListener('input', (ev) => {
    const n = parseFloat(ev.target.value);
    work.stateEffectiveRate = Number.isFinite(n) ? n / 100 : null;
    recompute();
  });

  // Locality + deductions + sources use event delegation.
  document.getElementById('estLocalityBody').addEventListener('input', onLocalityInput);
  document.getElementById('estLocalityBody').addEventListener('change', onLocalityInput);

  document.getElementById('estDeductionsList').addEventListener('input', onDeductionInput);
  document.getElementById('estDeductionsList').addEventListener('change', onDeductionInput);
  document.getElementById('estDeductionsList').addEventListener('click', onDeductionClick);
  document.getElementById('estDeductionPreset').addEventListener('change', onPresetPick);

  document.getElementById('estSourcesList').addEventListener('input', onSourceInput);
  document.getElementById('estSourcesList').addEventListener('change', onSourceInput);
  document.getElementById('estSourcesList').addEventListener('click', onSourceClick);
}

// Helper: bind a numeric input to a work.* numeric field with recompute.
function numericInput(elId, workKey) {
  document.getElementById(elId).addEventListener('input', (ev) => {
    work[workKey] = parseFloat(ev.target.value) || 0;
    recompute();
  });
}

export async function openEstimateModal() {
  const persisted = await getEstimatorSettings();
  work = {
    // Pay-type config: persisted
    payType:    persisted.payType || 'salary',
    salaryMode: persisted.salaryMode || 'period',

    // Numeric income inputs: never persisted
    salaryAmount: 0,
    hourlyRate: 0,
    regHours: 0,
    otHours: 0,
    dtHours: 0,
    sources: [],

    // Top-level config (persisted via settings)
    payPeriodsPerYear:  persisted.payPeriodsPerYear || 26,
    state:              persisted.state || null,
    filingStatus:       persisted.filingStatus || 'single',
    locality:           { ...(persisted.locality || {}) },
    deductions:         Array.isArray(persisted.deductions) ? [...persisted.deductions] : [],
    stateEffectiveRate: persisted.stateEffectiveRate ?? null,
  };

  fillFrequencyOptions();
  fillStateOptions();
  fillFilingOptions();
  populateFromWork();
  renderDeductions();
  renderSources();
  updatePayTypeVisibility();
  updateLocalityVisibility();

  document.getElementById('estimateHistoryPanel').style.display = 'none';
  document.getElementById('btnViewEstimateHistory').textContent = 'Show history';

  recompute();
  document.getElementById('estimateModal').classList.add('show');
}

function closeEstimateModal() {
  document.getElementById('estimateModal').classList.remove('show');
}

function fillFrequencyOptions() {
  const sel = document.getElementById('estFrequency');
  sel.innerHTML = FREQ_OPTIONS.map(o =>
    `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('');
}

function fillFilingOptions() {
  const sel = document.getElementById('estFiling');
  sel.innerHTML = FILING_OPTIONS.map(o =>
    `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('');
}

function fillStateOptions() {
  const sel = document.getElementById('estState');
  const states = listStates();
  sel.innerHTML =
    '<option value="">— Pick a state —</option>' +
    states.map(s => `<option value="${s.code}">${escapeHtml(s.name)} (${s.code})</option>`).join('');
}

function populateFromWork() {
  document.getElementById('estPayType').value    = work.payType;
  document.getElementById('estSalaryMode').value = work.salaryMode;
  document.getElementById('estFrequency').value  = String(work.payPeriodsPerYear);
  document.getElementById('estState').value      = work.state || '';
  document.getElementById('estFiling').value     = work.filingStatus;
  document.getElementById('estStateRate').value  = (work.stateEffectiveRate != null)
    ? (work.stateEffectiveRate * 100).toString()
    : '';
  // Numeric income fields stay blank on open (never persisted).
  document.getElementById('estSalaryAmount').value = '';
  document.getElementById('estHourlyRate').value   = '';
  document.getElementById('estRegHours').value     = '';
  document.getElementById('estOtHours').value      = '';
  document.getElementById('estDtHours').value      = '';
}

// =====================================================================
// Pay-type visibility: show only the input block for the active pay type.
// =====================================================================

function updatePayTypeVisibility() {
  document.getElementById('estSalaryRow').style.display    = work.payType === 'salary'   ? '' : 'none';
  document.getElementById('estHourlyBlock').style.display  = work.payType === 'hourly'   ? '' : 'none';
  document.getElementById('estSourcesBlock').style.display = work.payType === 'multiple' ? '' : 'none';
}

// =====================================================================
// Gross derivation: convert the pay-type-specific inputs to a per-period
// gross. This is the only place the inputs get combined; the engine itself
// always takes a per-period gross.
// =====================================================================

function computePerPeriodGross() {
  if (work.payType === 'salary') {
    const amt = work.salaryAmount || 0;
    return work.salaryMode === 'annual' ? (amt / work.payPeriodsPerYear) : amt;
  }
  if (work.payType === 'hourly') {
    return hourlyGross(work.hourlyRate, work.regHours, work.otHours, work.dtHours);
  }
  if (work.payType === 'multiple') {
    return work.sources.reduce((sum, src) => sum + sourceGross(src), 0);
  }
  return 0;
}

function hourlyGross(rate, reg, ot, dt) {
  const r = rate || 0;
  return (reg || 0) * r + (ot || 0) * r * 1.5 + (dt || 0) * r * 2;
}

function sourceGross(src) {
  if (!src) return 0;
  if (src.type === 'hourly') {
    return hourlyGross(src.rate, src.regHours, src.otHours, src.dtHours);
  }
  // salary
  const amt = src.amount || 0;
  return src.mode === 'annual' ? (amt / work.payPeriodsPerYear) : amt;
}

// =====================================================================
// Income sources (multi-source pay type)
// =====================================================================

function onAddSource() {
  work.sources.push({
    id: 'src-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    label: '',
    type: 'salary',
    mode: 'period',
    amount: 0,
    rate: 0,
    regHours: 0,
    otHours: 0,
    dtHours: 0,
  });
  renderSources();
  recompute();
}

function renderSources() {
  const list = document.getElementById('estSourcesList');
  if (!work.sources.length) {
    list.innerHTML = '<div class="muted" style="font-size:13px;padding:4px 0">No sources yet. Add one per job/company.</div>';
    document.getElementById('estSourcesTotal').textContent = '';
    return;
  }
  let html = '';
  for (const src of work.sources) {
    const sid = escapeHtml(src.id);
    html += `
      <div class="card" data-sid="${sid}" style="padding:8px;margin-bottom:6px;background:var(--surface-2)">
        <div class="row" style="align-items:flex-end;gap:6px">
          <div class="grow"><label style="font-size:12px">Label (optional)</label>
            <input type="text" data-fld="label" value="${escapeHtml(src.label||'')}" placeholder="e.g. Ferry Machine"></div>
          <div style="width:130px"><label style="font-size:12px">Type</label>
            <select data-fld="type">
              <option value="salary" ${src.type==='salary'?'selected':''}>Salary</option>
              <option value="hourly" ${src.type==='hourly'?'selected':''}>Hourly</option>
            </select></div>
          <button class="btn btn-sm btn-danger" data-action="remove-source" type="button">Remove</button>
        </div>
        ${src.type === 'salary' ? renderSourceSalary(src) : renderSourceHourly(src)}
        <div class="help" style="margin-top:4px;color:var(--text-2)">
          This source: ${formatMoneyDecimal(sourceGross(src))} per period
        </div>
      </div>
    `;
  }
  list.innerHTML = html;
  const total = work.sources.reduce((s, src) => s + sourceGross(src), 0);
  document.getElementById('estSourcesTotal').textContent =
    `Combined per-period gross: ${formatMoneyDecimal(total)}`;
}

function renderSourceSalary(src) {
  return `
    <div class="row" style="margin-top:6px">
      <div class="grow"><label style="font-size:12px">Amount ($)</label>
        <input type="number" data-fld="amount" step="0.01" min="0" value="${src.amount||''}" placeholder="e.g. 2500 or 65000"></div>
      <div class="grow"><label style="font-size:12px">Amount is</label>
        <select data-fld="mode">
          <option value="period" ${src.mode==='period'?'selected':''}>per pay period</option>
          <option value="annual" ${src.mode==='annual'?'selected':''}>per year</option>
        </select></div>
    </div>
  `;
}

function renderSourceHourly(src) {
  return `
    <div class="row" style="margin-top:6px">
      <div class="grow"><label style="font-size:12px">Rate ($/hr)</label>
        <input type="number" data-fld="rate" step="0.01" min="0" value="${src.rate||''}"></div>
      <div class="grow"><label style="font-size:12px">Regular hrs</label>
        <input type="number" data-fld="regHours" step="0.25" min="0" value="${src.regHours||''}"></div>
    </div>
    <div class="row" style="margin-top:6px">
      <div class="grow"><label style="font-size:12px">OT hrs (1.5x)</label>
        <input type="number" data-fld="otHours" step="0.25" min="0" value="${src.otHours||''}"></div>
      <div class="grow"><label style="font-size:12px">DT hrs (2x)</label>
        <input type="number" data-fld="dtHours" step="0.25" min="0" value="${src.dtHours||''}"></div>
    </div>
  `;
}

function onSourceInput(ev) {
  const row = ev.target.closest('[data-sid]');
  if (!row) return;
  const sid = row.dataset.sid;
  const src = work.sources.find(s => s.id === sid);
  if (!src) return;
  const fld = ev.target.dataset.fld;
  if (!fld) return;
  if (fld === 'type') {
    src.type = ev.target.value;
    renderSources();   // input shape changed
  } else if (fld === 'label' || fld === 'mode') {
    src[fld] = ev.target.value;
    // Update only the running total without full re-render to keep focus.
    const total = work.sources.reduce((s, x) => s + sourceGross(x), 0);
    document.getElementById('estSourcesTotal').textContent =
      `Combined per-period gross: ${formatMoneyDecimal(total)}`;
  } else {
    src[fld] = parseFloat(ev.target.value) || 0;
    const total = work.sources.reduce((s, x) => s + sourceGross(x), 0);
    document.getElementById('estSourcesTotal').textContent =
      `Combined per-period gross: ${formatMoneyDecimal(total)}`;
    // Per-source readout
    const help = row.querySelector('.help');
    if (help) help.textContent = `This source: ${formatMoneyDecimal(sourceGross(src))} per period`;
  }
  recompute();
}

function onSourceClick(ev) {
  if (ev.target.dataset.action !== 'remove-source') return;
  const row = ev.target.closest('[data-sid]');
  if (!row) return;
  const sid = row.dataset.sid;
  work.sources = work.sources.filter(s => s.id !== sid);
  renderSources();
  recompute();
}

// =====================================================================
// Locality (state-conditional)
// =====================================================================

function updateLocalityVisibility() {
  const state = work.state;
  const userRate = state && requiresUserRate(state, work.filingStatus);
  document.getElementById('estStateRateRow').style.display = userRate ? '' : 'none';
  const body = document.getElementById('estLocalityBody');
  body.innerHTML = renderLocalityFor(state);
}

function renderLocalityFor(state) {
  if (!state) return '<div class="muted" style="font-size:13px">Pick a state to see local options.</div>';
  const L = work.locality || {};
  if (state === 'NY') {
    return `
      <div class="row" style="align-items:flex-start">
        <div class="grow">
          <label><input type="checkbox" data-loc="nyc" ${L.nyc ? 'checked' : ''}> NYC resident</label>
          <div style="margin-top:6px"><label style="font-size:12px">NYC rate (effective %)</label>
            <input type="number" data-loc="nycRate" step="0.01" min="0" value="${pctStr(L.nycRate)}" placeholder="e.g. 3.8"></div>
        </div>
        <div class="grow">
          <label>Yonkers</label>
          <select data-loc="yonkers">
            <option value="no"          ${(L.yonkers||'no')==='no'?'selected':''}>Not in Yonkers</option>
            <option value="resident"    ${L.yonkers==='resident'?'selected':''}>Resident (16.75% surcharge)</option>
            <option value="nonresident" ${L.yonkers==='nonresident'?'selected':''}>Non-resident (0.5% earnings)</option>
          </select>
        </div>
      </div>
      <div class="help">NY SDI and PFL are added automatically.</div>
    `;
  }
  if (state === 'PA') {
    return `
      <div class="row" style="align-items:flex-start">
        <div class="grow">
          <label>Philadelphia</label>
          <select data-loc="philadelphia">
            <option value="no"          ${(L.philadelphia||'no')==='no'?'selected':''}>Not in Philly</option>
            <option value="resident"    ${L.philadelphia==='resident'?'selected':''}>Resident (3.74%)</option>
            <option value="nonresident" ${L.philadelphia==='nonresident'?'selected':''}>Non-resident (3.43%)</option>
          </select>
        </div>
        <div class="grow">
          <label>Other PA local EIT rate (%)</label>
          <input type="number" data-loc="paLocalEitRate" step="0.01" min="0" value="${pctStr(L.paLocalEitRate)}" placeholder="e.g. 1.0">
          <div class="help">Ignored when Philadelphia is set.</div>
        </div>
      </div>
    `;
  }
  if (state === 'DE') {
    return `
      <div class="row"><div class="grow">
        <label><input type="checkbox" data-loc="wilmington" ${L.wilmington ? 'checked' : ''}> Wilmington (1.25%)</label>
      </div></div>
    `;
  }
  if (state === 'MD') {
    return `
      <div class="row"><div class="grow">
        <label>Maryland county rate (%)</label>
        <input type="number" data-loc="mdCountyRate" step="0.01" min="0" value="${pctStr(L.mdCountyRate)}" placeholder="e.g. 3.2">
        <div class="help">Range 2.25% (Allegany) to 3.20% (Montgomery, PG, Howard, Baltimore City).</div>
      </div></div>
    `;
  }
  if (state === 'NJ') {
    return '<div class="muted" style="font-size:13px">NJ FLI is added automatically. No additional locality inputs.</div>';
  }
  if (state === 'CT' || state === 'MA' || state === 'RI') {
    return '<div class="muted" style="font-size:13px">State PFML/TDI is added automatically. No additional locality inputs.</div>';
  }
  return '<div class="muted" style="font-size:13px">No local taxes configured for this state.</div>';
}

function pctStr(decimal) {
  if (decimal == null || decimal === '') return '';
  return (Number(decimal) * 100).toFixed(2);
}

function onLocalityInput(ev) {
  const key = ev.target.dataset.loc;
  if (!key) return;
  if (key === 'nyc' || key === 'wilmington') {
    work.locality[key] = !!ev.target.checked;
  } else if (key === 'yonkers' || key === 'philadelphia') {
    work.locality[key] = ev.target.value;
  } else {
    const n = parseFloat(ev.target.value);
    work.locality[key] = Number.isFinite(n) ? n / 100 : null;
  }
  recompute();
}

// =====================================================================
// Deductions
// =====================================================================

function renderDeductions() {
  const list = document.getElementById('estDeductionsList');
  if (!work.deductions.length) {
    list.innerHTML = '<div class="muted" style="font-size:13px;padding:4px 0">No deductions yet. Use the quick-add menu or "+ Blank row".</div>';
    return;
  }
  let html = '';
  for (let i = 0; i < work.deductions.length; i++) {
    const d = work.deductions[i];
    html += `
      <div class="row" data-idx="${i}" style="align-items:flex-end;gap:6px;margin-bottom:6px">
        <div class="grow"><label style="font-size:12px">Name</label>
          <input type="text" data-fld="name" value="${escapeHtml(d.name||'')}" placeholder="e.g. 401(k)"></div>
        <div style="width:110px"><label style="font-size:12px">Per period ($)</label>
          <input type="number" data-fld="amountPerPeriod" step="0.01" min="0" value="${d.amountPerPeriod||''}"></div>
        <div style="flex:1.4"><label style="font-size:12px">Type</label>
          <select data-fld="type">
            ${DEDUCTION_TYPES.map(t =>
              `<option value="${t.value}" ${d.type===t.value?'selected':''}>${escapeHtml(t.label)}</option>`).join('')}
          </select></div>
        <button class="btn btn-sm btn-danger" data-action="remove" type="button">Remove</button>
      </div>
    `;
  }
  list.innerHTML = html;
}

function onAddBlankDeduction() {
  work.deductions.push({ name: '', amountPerPeriod: 0, type: 'pre-tax-401k' });
  renderDeductions();
  recompute();
}

function onPresetPick(ev) {
  const key = ev.target.value;
  if (!key) return;
  const preset = DEDUCTION_PRESETS[key];
  if (preset) {
    work.deductions.push({ name: preset.name, amountPerPeriod: 0, type: preset.type });
    renderDeductions();
    recompute();
  }
  ev.target.value = '';   // reset back to "+ Quick add ..."
}

function onDeductionInput(ev) {
  const row = ev.target.closest('[data-idx]');
  if (!row) return;
  const idx = parseInt(row.dataset.idx, 10);
  const fld = ev.target.dataset.fld;
  if (!fld) return;
  if (fld === 'amountPerPeriod') {
    work.deductions[idx][fld] = parseFloat(ev.target.value) || 0;
  } else {
    work.deductions[idx][fld] = ev.target.value;
  }
  recompute();
}

function onDeductionClick(ev) {
  if (ev.target.dataset.action !== 'remove') return;
  const row = ev.target.closest('[data-idx]');
  if (!row) return;
  const idx = parseInt(row.dataset.idx, 10);
  work.deductions.splice(idx, 1);
  renderDeductions();
  recompute();
}

// =====================================================================
// Recompute the breakdown
// =====================================================================

function recompute() {
  const out = document.getElementById('estResult');
  const grossHelp = document.getElementById('estHourlyGross');
  if (grossHelp) {
    if (work.payType === 'hourly') {
      const g = computePerPeriodGross();
      grossHelp.textContent = g > 0 ? `Computed gross this period: ${formatMoneyDecimal(g)}` : '';
    } else {
      grossHelp.textContent = '';
    }
  }
  try {
    if (!work.state) {
      out.innerHTML = '<div class="muted" style="font-size:13px">Pick a state to see the breakdown.</div>';
      lastResult = null;
      return;
    }
    if (requiresUserRate(work.state, work.filingStatus) && work.stateEffectiveRate == null) {
      out.innerHTML = '<div class="muted" style="font-size:13px">Enter your effective state rate to see the breakdown.</div>';
      lastResult = null;
      return;
    }
    const gross = computePerPeriodGross();
    const result = estimatePaycheck({
      grossPerPeriod: gross,
      payPeriodsPerYear: work.payPeriodsPerYear,
      state: work.state,
      filingStatus: work.filingStatus,
      locality: work.locality,
      deductions: work.deductions,
      stateEffectiveRate: work.stateEffectiveRate,
    });
    lastResult = result;
    out.innerHTML = renderResult(result);
  } catch (e) {
    out.innerHTML = `<div class="help" style="color:var(--danger)">Cannot compute: ${escapeHtml(e.message)}</div>`;
    lastResult = null;
  }
}

function renderResult(r) {
  const periods = periodsPerYear(work.payPeriodsPerYear);
  const row = (label, perPeriod, annual, extraClass = '') =>
    `<tr class="${extraClass}">
      <td>${escapeHtml(label)}</td>
      <td class="num">${formatMoneyDecimal(perPeriod)}</td>
      <td class="num muted">${formatMoney(annual)}</td>
    </tr>`;

  return `
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-top:6px">
      <thead>
        <tr style="border-bottom:1px solid var(--border);text-align:left">
          <th></th><th class="num">Per period</th><th class="num">Annual</th>
        </tr>
      </thead>
      <tbody>
        ${row('Gross', r.gross, r.annual.gross, 'gross')}
        ${row('Federal income tax', -r.federalIncomeTax, -r.annual.federalIncomeTax)}
        ${row('Social Security (6.2%)', -r.socialSecurity, -r.annual.socialSecurity)}
        ${row('Medicare (1.45%)', -r.medicare, -r.annual.medicare)}
        ${r.additionalMedicare > 0 ? row('Additional Medicare (0.9%)', -r.additionalMedicare, -r.annual.additionalMedicare) : ''}
        ${row('State income tax', -r.stateTax, -r.annual.stateTax)}
        ${r.payrollAddons.map(a => row(a.name, -a.amount, -a.amount * periods)).join('')}
        ${r.localTax > 0 ? r.localItems.map(i => row(i.name, -i.amount, -i.amount * periods)).join('') : ''}
        ${r.preTaxDeductions > 0 ? row('Pre-tax deductions', -r.preTaxDeductions, -r.annual.preTaxDeductions) : ''}
        ${r.postTaxDeductions > 0 ? row('Post-tax deductions', -r.postTaxDeductions, -r.annual.postTaxDeductions) : ''}
        <tr style="border-top:2px solid var(--border);font-weight:600">
          <td>Take-home</td>
          <td class="num">${formatMoneyDecimal(r.takeHome)}</td>
          <td class="num muted">${formatMoney(r.annual.takeHome)}</td>
        </tr>
      </tbody>
    </table>
    <div class="row" style="margin-top:8px;font-size:12px;color:var(--text-2)">
      <span class="grow">Effective tax rate: <strong>${(r.effectiveTaxRate * 100).toFixed(1)}%</strong></span>
      <span>Marginal federal rate: <strong>${(r.marginalFederalRate * 100).toFixed(0)}%</strong></span>
    </div>
  `;
}

// =====================================================================
// Persistence
// =====================================================================

async function onSaveTemplate() {
  // Persisted fields only: pay type + salary mode + structural defaults.
  // Dollar amounts, hours, rates, and per-source values are NEVER saved.
  const settings = {
    payType:    work.payType,
    salaryMode: work.salaryMode,
    state: work.state,
    filingStatus: work.filingStatus,
    payPeriodsPerYear: work.payPeriodsPerYear,
    locality: work.locality,
    deductions: work.deductions,
    stateEffectiveRate: work.stateEffectiveRate,
  };
  const ok = await saveEstimatorSettings(settings);
  toast(ok ? 'Defaults saved' : 'Save failed');
}

async function onSaveHistory() {
  if (!lastResult) { toast('Nothing to save yet'); return; }
  const note = prompt('Optional note for this estimate:', '') || null;
  // Snapshot the full work shape so history rows remain interpretable
  // even after engine constants change. Includes pay-type-specific inputs.
  const inputs = JSON.parse(JSON.stringify(work));
  const ok = await appendEstimateHistory({ inputs, result: lastResult, note });
  toast(ok ? 'Saved to history' : 'Save failed');
  if (ok && document.getElementById('estimateHistoryPanel').style.display !== 'none') {
    renderHistory();
  }
}

async function onToggleHistory() {
  const panel = document.getElementById('estimateHistoryPanel');
  const btn = document.getElementById('btnViewEstimateHistory');
  if (panel.style.display === 'none') {
    panel.style.display = '';
    btn.textContent = 'Hide history';
    await renderHistory();
  } else {
    panel.style.display = 'none';
    btn.textContent = 'Show history';
  }
}

async function renderHistory() {
  const list = document.getElementById('estimateHistoryList');
  list.innerHTML = '<div class="muted" style="font-size:13px">Loading...</div>';
  const rows = await loadEstimateHistory({ limit: 20 });
  if (!rows.length) {
    list.innerHTML = '<div class="muted" style="font-size:13px">No saved estimates yet.</div>';
    return;
  }
  let html = '';
  for (const r of rows) {
    const ts = new Date(r.createdAt).toLocaleString();
    const take = r.result?.takeHome ?? 0;
    const gross = r.result?.gross ?? 0;
    const st = r.inputs?.state || '';
    const note = r.note ? escapeHtml(r.note) : '';
    html += `
      <div class="row" data-id="${escapeHtml(r.id)}" style="border-bottom:1px solid var(--border);padding:6px 0;align-items:center">
        <div class="grow">
          <div style="font-size:13px"><strong>${formatMoneyDecimal(take)}</strong> take-home on ${formatMoneyDecimal(gross)} ${escapeHtml(st)}</div>
          <div class="muted" style="font-size:11px">${escapeHtml(ts)}${note ? ' · ' + note : ''}</div>
        </div>
        <button class="btn btn-sm btn-danger" data-action="delete-history" type="button">Delete</button>
      </div>
    `;
  }
  list.innerHTML = html;

  list.onclick = async (ev) => {
    if (ev.target.dataset.action !== 'delete-history') return;
    const row = ev.target.closest('[data-id]');
    if (!row) return;
    const id = row.dataset.id;
    if (!confirm('Delete this estimate?')) return;
    const ok = await deleteEstimateHistory(id);
    if (ok) {
      toast('Deleted');
      await renderHistory();
    } else {
      toast('Delete failed');
    }
  };
}
