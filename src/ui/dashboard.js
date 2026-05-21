/**
 * src/ui/dashboard.js
 *
 * Pay Period view. Default landing tab. Shows:
 *   - Period selector (Current / Last / Other date)
 *   - Period totals (Total / Regular / OT / Time off)
 *   - Week-by-week breakdown of entries
 *   - Time-off pool balances (Taken / Scheduled / Remaining)
 */

import { getPayPeriodFor, splitIntoWeeks } from '../core/period.js';
import { computeHoursPaid, computeHoursWorked, entrySegments, dayShort, addDays } from '../core/time.js';
import { escapeHtml, formatLong } from '../core/format.js';
import { computePoolBalance, countDaysForCode, sumHoursForCode } from '../core/balances.js';
import { openEntryModal } from '../modals/entryModal.js';

export function renderDashboard(state) {
  const pp = getPayPeriodFor(state.ui.ppMode, state.ui.ppOtherDate, state.settings);
  document.getElementById('ppRange').textContent =
    `${formatLong(pp.start)} — ${formatLong(pp.end)}`;
  document.getElementById('ppOtherPicker').style.display =
    state.ui.ppMode === 'other' ? 'block' : 'none';

  const inPP = Object.values(state.entries)
    .filter(e => e.date >= pp.start && e.date <= pp.end);
  const otThreshold = state.settings.otThreshold || 40;

  // Week breakdown
  const wkContainer = document.getElementById('weekBreakdown');
  wkContainer.innerHTML = '';
  const weeks = splitIntoWeeks(pp.start, pp.end);
  for (const w of weeks) {
    wkContainer.appendChild(renderWeekCard(w, state));
  }

  // Totals
  let ppTotal = 0;
  let ppRegular = 0;
  let ppOT = 0;
  let ppTimeOff = 0;

  for (const e of inPP) {
    const h = computeHoursPaid(e, state.settings, state.timeOffTypes);
    if (e.timeOff && e.timeOff !== 'HOLIDAY') {
      ppTimeOff += h;
    } else {
      ppTotal += h;
    }
  }

  // Regular vs OT per-week, computed on WORKED hours only. Holiday and
  // PTO/SICK do not push the worked total over the OT threshold.
  for (const w of weeks) {
    const wk = inPP.filter(e => e.date >= w.start && e.date <= w.end);
    const wkWorked = wk.reduce((s, e) => s + computeHoursWorked(e, state.settings), 0);
    if (wkWorked > otThreshold) {
      ppRegular += otThreshold;
      ppOT += wkWorked - otThreshold;
    } else {
      ppRegular += wkWorked;
    }
  }

  document.getElementById('ppTotal').textContent = ppTotal.toFixed(2);
  document.getElementById('ppRegular').textContent = ppRegular.toFixed(2);
  document.getElementById('ppOT').textContent = ppOT.toFixed(2);
  document.getElementById('ppTimeOff').textContent = ppTimeOff.toFixed(2);

  renderBalances(state);
}

function renderWeekCard(week, state) {
  const card = document.createElement('div');
  card.className = 'card week-card';

  const entries = Object.values(state.entries)
    .filter(e => e.date >= week.start && e.date <= week.end)
    .sort((a, b) => a.date.localeCompare(b.date));

  // Build full week (including empty days)
  const days = [];
  let d = week.start;
  while (d <= week.end) {
    const found = entries.find(e => e.date === d);
    days.push(found || { date: d, empty: true });
    d = addDays(d, 1);
  }

  let worked = 0;
  let holiday = 0;
  let timeOff = 0;
  let html = `<div class="week-head"><h3>${week.label} ·
    <span class="muted">${formatLong(week.start)}</span></h3></div>`;
  html += '<table><thead><tr><th>Day</th><th>In</th><th>Out</th>'
    + '<th class="num">Hrs</th><th>Off</th></tr></thead><tbody>';

  for (const dd of days) {
    const workedH = dd.empty ? 0 : computeHoursWorked(dd, state.settings);
    const paidH = dd.empty ? 0 : computeHoursPaid(dd, state.settings, state.timeOffTypes);
    if (dd.timeOff === 'HOLIDAY') {
      worked += workedH;
      if (workedH === 0) holiday += paidH;
    } else if (dd.timeOff) {
      timeOff += paidH;
    } else {
      worked += workedH;
    }
    const pill = dd.timeOff
      ? `<span class="pill pill-${dd.timeOff.toLowerCase()}">${dd.timeOff}</span>`
      : '';
    const segs = dd.empty ? [] : entrySegments(dd);
    const firstIn = segs.length ? (segs[0].clockIn || '') : '';
    const lastOut = segs.length ? (segs[segs.length - 1].clockOut || '') : '';
    const segBadge = segs.length > 1 ? ` <span class="badge">${segs.length}×</span>` : '';
    html += `<tr style="cursor:pointer" data-date="${dd.date}">
      <td>${dayShort(dd.date)} ${dd.date.slice(8, 10)}</td>
      <td>${firstIn}${segBadge}</td>
      <td>${lastOut}</td>
      <td class="num">${paidH > 0 ? paidH.toFixed(2) : '—'}</td>
      <td>${pill}</td>
    </tr>`;
  }
  html += '</tbody></table>';

  const otThreshold = state.settings.otThreshold || 40;
  const ot = Math.max(0, worked - otThreshold);
  const reg = Math.min(worked, otThreshold);
  html += `<div class="week-totals">
    <span>Total: <strong>${(worked + holiday + timeOff).toFixed(2)}</strong></span>
    <span>Regular: <strong>${reg.toFixed(2)}</strong></span>
    ${ot > 0 ? `<span>OT: <strong style="color:var(--success)">${ot.toFixed(2)}</strong></span>` : ''}
    ${holiday > 0 ? `<span>Holiday: <strong>${holiday.toFixed(2)}</strong></span>` : ''}
    ${timeOff > 0 ? `<span>Time off: <strong>${timeOff.toFixed(2)}</strong></span>` : ''}
  </div>`;

  card.innerHTML = html;
  card.querySelectorAll('tr[data-date]').forEach(tr => {
    tr.onclick = () => openEntryModal(tr.dataset.date, state);
  });
  return card;
}

function renderBalances(state) {
  const container = document.getElementById('balancesList');
  const entries = Object.values(state.entries);
  let html = '';

  for (const t of state.timeOffTypes) {
    if (!t.countsAgainstPool) {
      const usedHours = sumHoursForCode(entries, t.code, 'all', state.settings, state.timeOffTypes);
      const usedDays = countDaysForCode(entries, t.code, 'all');
      html += `<div style="margin-bottom:12px">
        <div class="row" style="justify-content:space-between">
          <strong>${escapeHtml(t.label)}</strong>
          <span class="muted">${usedDays} day${usedDays === 1 ? '' : 's'} · ${usedHours.toFixed(1)} h</span>
        </div>
        <div class="help">No pool tracked</div>
      </div>`;
      continue;
    }
    if (t.sharedPoolWith) continue;

    const b = computePoolBalance(t, state.timeOffTypes, entries, state.settings);
    const barClass = (b.taken + b.scheduled) / b.poolHours >= 0.9 ? 'danger'
      : (b.taken + b.scheduled) / b.poolHours >= 0.7 ? 'warn' : '';

    const sharedLabel = b.sharedTypes.length
      ? ' + ' + b.sharedTypes.map(x => escapeHtml(x.label)).join(' + ') + ' (shared)'
      : '';

    html += `<div style="margin-bottom:16px">
      <div class="row" style="justify-content:space-between;align-items:baseline">
        <strong>${escapeHtml(t.label)}${sharedLabel}</strong>
        <span style="font-variant-numeric: tabular-nums;font-size:13px">
          pool: ${t.poolDays || 0} days (${b.poolHours.toFixed(0)} h)
        </span>
      </div>
      <div class="progress" style="height:8px;display:flex">
        <div class="progress-bar ${barClass}" style="width:${b.pctTaken}%"></div>
        <div style="width:${b.pctScheduled}%;background:repeating-linear-gradient(45deg,var(--warn),var(--warn) 4px,var(--warn-bg) 4px,var(--warn-bg) 8px);height:100%"></div>
      </div>
      <div class="row" style="margin-top:8px;gap:10px;font-size:12px">
        <span><strong>${(b.taken / b.hoursPerDay).toFixed(2)}</strong> days
          <span class="muted">taken</span>
          <span class="muted">(${b.taken.toFixed(1)} h)</span></span>
        <span style="color:var(--warn)"><strong>${(b.scheduled / b.hoursPerDay).toFixed(2)}</strong> days
          <span style="opacity:0.7">scheduled</span>
          <span style="opacity:0.7">(${b.scheduled.toFixed(1)} h)</span></span>
        <span style="margin-left:auto;color:var(--success)"><strong>${(b.remaining / b.hoursPerDay).toFixed(2)}</strong> days
          <span style="opacity:0.7">remaining</span></span>
      </div>`;

    if (b.breakdownTypes.length > 1) {
      html += '<div class="help" style="margin-top:6px">';
      for (const bt of b.breakdownTypes) {
        const u = sumHoursForCode(entries, bt.code, 'all', state.settings, state.timeOffTypes);
        html += `<span class="badge" style="margin-right:6px">${escapeHtml(bt.label)}: ${u.toFixed(1)} h</span>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }

  container.innerHTML = html || '<div class="muted">No time-off pools configured.</div>';
}

export function wireDashboard(state) {
  document.querySelectorAll('.pp-selector button').forEach(b => {
    b.onclick = () => {
      state.ui.ppMode = b.dataset.pp;
      document.querySelectorAll('.pp-selector button').forEach(x =>
        x.classList.toggle('active', x === b));
      renderDashboard(state);
    };
  });
  document.getElementById('ppOtherDate').onchange = e => {
    state.ui.ppOtherDate = e.target.value;
    renderDashboard(state);
  };
}
