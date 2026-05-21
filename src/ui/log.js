/**
 * src/ui/log.js
 *
 * Daily Log view. Shows all entries for a chosen year, grouped by month,
 * with monthly hour totals. Click any row to edit.
 */

import { computeHours, entrySegments, dayShort, fmtDate } from '../core/time.js';
import { escapeHtml, monthName } from '../core/format.js';
import { openEntryModal } from '../modals/entryModal.js';

export function renderLog(state) {
  renderLogYears(state);
  const year = state.ui.logYear + '';
  const search = (document.getElementById('logSearch').value || '').toLowerCase().trim();
  const list = document.getElementById('entriesList');

  const all = Object.values(state.entries)
    .filter(e => e.date.startsWith(year))
    .filter(e => {
      if (!search) return true;
      return (e.notes || '').toLowerCase().includes(search)
        || (e.timeOff || '').toLowerCase().includes(search)
        || e.date.includes(search);
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  document.getElementById('logCount').textContent =
    all.length + (all.length === 1 ? ' entry' : ' entries');

  if (all.length === 0) {
    list.innerHTML = `<div class="empty"><div class="empty-icon">📅</div>
      No entries for ${year}. Tap "+ New Entry" to start.</div>`;
    return;
  }

  // Group by month
  const byMonth = {};
  for (const e of all) {
    const m = e.date.slice(0, 7);
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(e);
  }

  let html = '';
  for (const m of Object.keys(byMonth).sort().reverse()) {
    const [y, mo] = m.split('-');
    let monthTotal = 0;
    for (const e of byMonth[m]) {
      if (!e.timeOff || e.timeOff === 'HOLIDAY') {
        monthTotal += computeHours(e, state.settings, state.timeOffTypes);
      }
    }
    html += `<div style="margin-top:14px;margin-bottom:6px;font-size:12px;font-weight:600;
      color:var(--text-2);text-transform:uppercase;letter-spacing:0.04em">
      ${monthName(+mo - 1)} ${y}
      <span class="muted" style="font-weight:400">· ${monthTotal.toFixed(1)} h</span>
    </div>`;
    for (const e of byMonth[m]) {
      const h = computeHours(e, state.settings, state.timeOffTypes);
      const dn = dayShort(e.date);
      const day = e.date.slice(8, 10);
      const timeOffPill = e.timeOff
        ? `<span class="pill pill-${e.timeOff.toLowerCase()}">${e.timeOff}</span> `
        : '';
      const noteSnip = e.notes
        ? `<div class="muted" style="font-size:11px;margin-top:2px">${escapeHtml(e.notes.slice(0, 60))}</div>`
        : '';
      const segs = entrySegments(e);
      const firstIn = segs.length ? (segs[0].clockIn || '—') : '—';
      const lastOut = segs.length ? (segs[segs.length - 1].clockOut || '—') : '—';
      const multiBadge = segs.length > 1
        ? ` <span class="badge">${segs.length} segments</span>`
        : '';
      const timeStr = `${firstIn} → ${lastOut}`;
      html += `<div class="entry-row" data-date="${e.date}">
        <div class="entry-date"><div class="day">${dn}</div><div>${day}</div></div>
        <div>${timeOffPill}<span class="entry-times">${timeStr}</span>${multiBadge}${noteSnip}</div>
        <div class="entry-hours">${h > 0 ? h.toFixed(2) : '—'}</div>
      </div>`;
    }
  }

  list.innerHTML = html;
  list.querySelectorAll('.entry-row').forEach(el => {
    el.onclick = () => openEntryModal(el.dataset.date, state);
  });
}

function renderLogYears(state) {
  const sel = document.getElementById('logYear');
  const years = new Set();
  Object.keys(state.entries).forEach(d => years.add(d.slice(0, 4)));
  years.add(new Date().getFullYear() + '');
  years.add((new Date().getFullYear() - 1) + '');
  const sorted = [...years].sort().reverse();
  sel.innerHTML = sorted.map(y => `<option value="${y}">${y}</option>`).join('');
  sel.value = state.ui.logYear;
  sel.onchange = () => { state.ui.logYear = +sel.value; renderLog(state); };
}

export function wireLog(state) {
  document.getElementById('btnAddEntry').onclick =
    () => openEntryModal(fmtDate(new Date()), state);
  document.getElementById('logSearch').oninput = () => renderLog(state);
}
