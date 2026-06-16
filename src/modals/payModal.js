/**
 * src/modals/payModal.js
 *
 * Paycheck add/edit modal. Pulls hours from time log if requested.
 */

import { SK } from '../data/schema.js';
import { saveKey } from '../app.js';
import { getPayPeriodFor } from '../core/payPeriod.js';
import { companyByName } from '../data/activeCompany.js';
import { fmtDate, addDays } from '../core/time.js';
import { computeCompanyPools, coverageFromPools, paidHoursWithCoverage } from '../core/coverage.js';
import { escapeHtml } from '../core/format.js';
import { setSyncIdle } from '../ui/topbar.js';
import { toast } from '../ui/toast.js';

let editingIdx = null;
let stateRef = null;
let rerender = () => {};

export function initPayModal(state, onAfterSave) {
  stateRef = state;
  rerender = onAfterSave;

  document.getElementById('btnCancelPay').onclick = closePayModal;
  document.getElementById('btnSavePay').onclick = savePay;
  document.getElementById('btnDeletePay').onclick = deletePay;
  document.getElementById('btnPullHours').onclick = pullHoursFromLog;
  document.getElementById('payModal').onclick = (e) => {
    if (e.target.id === 'payModal') closePayModal();
  };
}

export function openPayModal(idx, state) {
  if (state) stateRef = state;
  fillCompanySelect();
  editingIdx = idx;
  const isNew = idx === null || idx === undefined || idx < 0;
  document.getElementById('payModalTitle').textContent =
    isNew ? 'Add Paycheck' : 'Edit Paycheck';
  const p = isNew
    ? {
        date: fmtDate(new Date()),
        gross: '', takeHome: '', hours: '',
        company: stateRef.companies[0]?.name || '',
      }
    : stateRef.pays[idx];
  document.getElementById('pDate').value = p.date;
  document.getElementById('pCompany').value = p.company || '';
  document.getElementById('pGross').value = p.gross || '';
  document.getElementById('pNet').value = p.takeHome || '';
  document.getElementById('pHours').value = p.hours || '';
  document.getElementById('btnDeletePay').style.display =
    isNew ? 'none' : 'inline-flex';
  document.getElementById('payModal').classList.add('show');
}

function closePayModal() {
  document.getElementById('payModal').classList.remove('show');
  editingIdx = null;
}

function fillCompanySelect() {
  const sel = document.getElementById('pCompany');
  sel.innerHTML = stateRef.companies.map(c =>
    `<option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>`
  ).join('') + '<option value="">— Other —</option>';
}

function pullHoursFromLog() {
  const payDate = document.getElementById('pDate').value;
  if (!payDate) { toast('Pick a pay date first'); return; }
  // Resolve which company's pay-period schedule applies. The selected
  // dropdown value is a name; companyByName falls back to the active
  // company when the value is empty ("— Other —") or unknown.
  const selectedName = document.getElementById('pCompany').value;
  const company = companyByName(stateRef, selectedName);
  // Pay date is usually a few days after period end; back off a bit
  const pp = getPayPeriodFor('other', addDays(payDate, -3), company);
  // Pull paid hours from every entry in the period, excluding only types
  // flagged as unpaid (which the user isn't paid for).
  const inPP = Object.values(stateRef.entries).filter(e => {
    if (e.date < pp.start || e.date > pp.end) return false;
    if (!e.timeOff) return true;
    const type = stateRef.timeOffTypes.find(t => t.code === e.timeOff);
    return !type || type.unpaid !== true;
  });
  // Honor pool coverage so the prefill matches the period totals: an over-pool
  // or pending day pulls 0, covered days pull as before. Coverage is built from
  // the same entries/types being summed.
  const coverage = coverageFromPools(computeCompanyPools({
    company, timeOffTypes: stateRef.timeOffTypes, entries: stateRef.entries,
    settings: stateRef.settings, companies: stateRef.companies, asOf: fmtDate(new Date()),
  }));
  const hrs = inPP.reduce((s, e) => s + paidHoursWithCoverage(e, stateRef.settings, stateRef.timeOffTypes, stateRef.companies, coverage), 0);
  document.getElementById('pHours').value = hrs.toFixed(2);
  toast(`Pulled ${hrs.toFixed(2)} h from ${pp.start} → ${pp.end}`);
}

async function savePay() {
  const rec = {
    date: document.getElementById('pDate').value,
    company: document.getElementById('pCompany').value,
    gross: parseFloat(document.getElementById('pGross').value) || 0,
    takeHome: parseFloat(document.getElementById('pNet').value) || 0,
    hours: parseFloat(document.getElementById('pHours').value) || 0,
  };
  if (!rec.date) { toast('Pick a date'); return; }
  if (editingIdx !== null && editingIdx >= 0) {
    stateRef.pays[editingIdx] = rec;
  } else {
    stateRef.pays.push(rec);
  }
  if (!await saveKey(SK.pays, stateRef.pays, 'Paycheck')) return;
  setSyncIdle();
  closePayModal();
  rerender();
  toast('Saved');
}

async function deletePay() {
  if (editingIdx === null || editingIdx < 0) return;
  if (!confirm('Delete this paycheck?')) return;
  stateRef.pays.splice(editingIdx, 1);
  if (!await saveKey(SK.pays, stateRef.pays, 'Paycheck')) return;
  setSyncIdle();
  closePayModal();
  rerender();
  toast('Deleted');
}
