/**
 * src/ui/paychecks.js
 *
 * Paychecks view. Lists pay records with YTD totals (gross, take-home,
 * hours, implied taxes). Click any row to edit.
 */

import { formatMoney, formatMoneyDecimal } from '../core/format.js';
import { openPayModal } from '../modals/payModal.js';
import { openEstimateModal } from '../modals/estimateModal.js';

export function renderPaychecks(state) {
  renderPayYears(state);
  const yrFilter = state.ui.payYearFilter;
  const list = document.getElementById('paysList');
  const filtered = state.pays.filter(p =>
    yrFilter === 'all' || p.date.startsWith(yrFilter));
  const sorted = [...filtered].sort((a, b) => b.date.localeCompare(a.date));

  // YTD totals: current year unless a specific year is selected
  const ytdYear = yrFilter === 'all' ? (new Date().getFullYear() + '') : yrFilter;
  const ytd = state.pays.filter(p => p.date.startsWith(ytdYear));
  const gross = ytd.reduce((s, p) => s + (+p.gross || 0), 0);
  const net = ytd.reduce((s, p) => s + (+p.takeHome || 0), 0);
  const hrs = ytd.reduce((s, p) => s + (+p.hours || 0), 0);

  document.getElementById('ytdGross').textContent = formatMoney(gross);
  document.getElementById('ytdNet').textContent = formatMoney(net);
  document.getElementById('ytdHours').textContent = hrs.toFixed(0);
  document.getElementById('ytdTax').textContent = formatMoney(gross - net);

  if (sorted.length === 0) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">💵</div>No paychecks yet.</div>';
    return;
  }

  let html = '';
  for (const p of sorted) {
    const realIdx = state.pays.indexOf(p);
    html += `<div class="pay-row" data-idx="${realIdx}" style="cursor:pointer">
      <div class="date">${p.date.slice(5)}/${p.date.slice(2, 4)}
        <div class="muted" style="font-size:11px">${p.company || ''}</div></div>
      <div class="num">${formatMoneyDecimal(p.gross)}</div>
      <div class="num">${formatMoneyDecimal(p.takeHome)}</div>
      <div class="num">${(+p.hours || 0).toFixed(1)}</div>
    </div>`;
  }
  list.innerHTML = html;

  list.querySelectorAll('.pay-row[data-idx]').forEach(el => {
    el.onclick = () => openPayModal(+el.dataset.idx, state);
  });
}

function renderPayYears(state) {
  const sel = document.getElementById('payYearFilter');
  const years = new Set();
  state.pays.forEach(p => years.add(p.date.slice(0, 4)));
  const sorted = [...years].sort().reverse();
  sel.innerHTML = '<option value="all">All years</option>'
    + sorted.map(y => `<option value="${y}">${y}</option>`).join('');
  sel.value = state.ui.payYearFilter;
  sel.onchange = () => { state.ui.payYearFilter = sel.value; renderPaychecks(state); };
}

export function wirePaychecks(state) {
  document.getElementById('btnAddPay').onclick = () => openPayModal(null, state);
  document.getElementById('btnEstimate').onclick = () => openEstimateModal();
}
