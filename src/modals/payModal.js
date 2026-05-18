/**
 * src/modals/payModal.js
 *
 * Paycheck add/edit modal. Pulls hours from time log if requested.
 */

import { Store } from '../data/storage.js';
import { SK } from '../data/schema.js';
import { getPayPeriodFor } from '../core/period.js';
import { computeHours, fmtDate, addDays } from '../core/time.js';
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
  // Pay date is usually a few days after period end; back off a bit
  const pp = getPayPeriodFor('other', addDays(payDate, -3), stateRef.settings);
  const inPP = Object.values(stateRef.entries).filter(e =>
    e.date >= pp.start && e.date <= pp.end
    && (!e.timeOff || e.timeOff === 'HOLIDAY'));
  const hrs = inPP.reduce((s, e) => s + computeHours(e, stateRef.settings), 0);
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
  await Store.set(SK.pays, stateRef.pays);
  setSyncIdle();
  closePayModal();
  rerender();
  toast('Saved');
}

async function deletePay() {
  if (editingIdx === null || editingIdx < 0) return;
  if (!confirm('Delete this paycheck?')) return;
  stateRef.pays.splice(editingIdx, 1);
  await Store.set(SK.pays, stateRef.pays);
  setSyncIdle();
  closePayModal();
  rerender();
  toast('Deleted');
}
