/**
 * src/ui/dashboard.js
 *
 * Pay Period view. Default landing tab. Shows:
 *   - Period selector (Current / Last / Other date)
 *   - Period totals (Total / Regular / OT / Time off)
 *   - Week-by-week breakdown of entries
 *   - Time-off pool balances (Taken / Scheduled / Remaining)
 */

import { getPayPeriodFor, splitPayPeriodIntoWeeks } from '../core/payPeriod.js';
import { computeHoursPaid, computeHoursWorked, entrySegments, dayShort, addDays } from '../core/time.js';
import { escapeHtml, formatLong } from '../core/format.js';
import { computePoolBalance, countDaysForCode, sumHoursForCode } from '../core/balances.js';
import { openEntryModal } from '../modals/entryModal.js';
import { activeCompany } from '../data/activeCompany.js';

/**
 * Which company the Pay Period landing is showing. state.ui.ppCompanyId names
 * the selected tab; when unset (or pointing at a now-inactive company) we fall
 * back to the active company, so single-company use and the default render are
 * output-identical.
 */
function selectedDashboardCompany(state) {
  const id = state?.ui?.ppCompanyId;
  if (id != null) {
    const list = Array.isArray(state.companies) ? state.companies : [];
    const found = list.find(c => String(c.id ?? '') === String(id) && c.isActive !== false);
    if (found) return found;
  }
  return activeCompany(state);
}

/**
 * Render the per-company tab strip at the top of the Pay Period landing, one
 * tab per ACTIVE company, highlighting `company`. With a single active company
 * there is no strip (single-company use looks exactly as before). Selecting a
 * tab re-renders the dashboard for that company via renderDashboard.
 */
function renderCompanyTabs(state, company) {
  const host = document.getElementById('ppCompanyTabs');
  if (!host) return;
  const actives = Array.isArray(state.companies)
    ? state.companies.filter(c => c.isActive !== false)
    : [];
  if (actives.length <= 1) {
    host.innerHTML = '';
    return;
  }
  const selId = String(company.id ?? '');
  host.innerHTML = '<div class="pp-subtabs">' + actives.map(c => {
    const id = String(c.id ?? '');
    const isSel = id === selId ? ' active' : '';
    return `<button type="button" class="pp-subtab${isSel}" data-pp-company="${escapeHtml(id)}">${escapeHtml(c.name)}</button>`;
  }).join('') + '</div>';

  host.querySelectorAll('[data-pp-company]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.ppCompany;
      const target = actives.find(c => String(c.id ?? '') === id);
      if (target) renderDashboard(state, target);
    };
  });
}

export function renderDashboard(state, selectedCompany = selectedDashboardCompany(state)) {
  const company = selectedCompany;
  // Remember which company the landing is showing so the period buttons
  // (which re-render with no explicit company) keep the same tab.
  state.ui.ppCompanyId = company.id ?? null;
  renderCompanyTabs(state, company);

  const cid = String(company.id ?? '');
  // Time-off types are per-company. Prefer the selected company's set; fall
  // back to state.timeOffTypes (which is the active company's set, and is the
  // SAME array reference held under its id in timeOffByCompany).
  const timeOffTypes = state.timeOffByCompany?.[cid] || state.timeOffTypes;
  // Entries are per-company. Prefer the selected company's set; fall back to
  // state.entries (the active company's set, which is the SAME object held
  // under its id in entriesByCompany).
  const entries = state.entriesByCompany?.[cid] || state.entries;
  const pp = getPayPeriodFor(state.ui.ppMode, state.ui.ppOtherDate, company);
  document.getElementById('ppRange').textContent =
    `${formatLong(pp.start)} — ${formatLong(pp.end)}`;
  document.getElementById('ppOtherPicker').style.display =
    state.ui.ppMode === 'other' ? 'block' : 'none';

  const inPP = Object.values(entries)
    .filter(e => e.date >= pp.start && e.date <= pp.end);
  // OT threshold is per-company now. Fall back to 40 only when missing
  // (null/undefined/NaN); a deliberately stored value, including 0, is kept.
  const otThreshold = Number.isFinite(company.otThreshold) ? company.otThreshold : 40;

  // Week breakdown. The legacy module gave us pre-labeled chunks; the new
  // module returns raw {start, end} so we relabel here to keep the UI
  // identical: a single chunk reads "Period", otherwise "Week N".
  const wkContainer = document.getElementById('weekBreakdown');
  wkContainer.innerHTML = '';
  const weekStartDow = company.weekStartDow ?? 1;
  const rawWeeks = splitPayPeriodIntoWeeks(pp.start, pp.end, weekStartDow);
  const weeks = rawWeeks.length === 1
    ? [{ ...rawWeeks[0], label: 'Period' }]
    : rawWeeks.map((w, i) => ({ ...w, label: 'Week ' + (i + 1) }));
  for (const w of weeks) {
    wkContainer.appendChild(renderWeekCard(w, state, company, timeOffTypes, entries));
  }

  // Totals. Mirrors the per-week card buckets so they reconcile:
  //   - HOLIDAY day: workedH counts toward Regular/OT; additive bonus
  //     (paidH - workedH) counts toward Holiday.
  //   - Non-HOLIDAY time-off: paidH counts toward Time off.
  //   - Worked-only day: workedH counts toward Regular/OT.
  // Total is the sum across all buckets — equivalent to summing
  // computeHoursPaid over the period.
  let ppRegular = 0;
  let ppOT = 0;
  let ppHoliday = 0;
  let ppTimeOff = 0;

  for (const e of inPP) {
    if (e.timeOff === 'HOLIDAY') {
      const workedH = computeHoursWorked(e, state.settings, state.companies);
      const paidH = computeHoursPaid(e, state.settings, timeOffTypes, state.companies);
      ppHoliday += paidH - workedH;
    } else if (e.timeOff) {
      ppTimeOff += computeHoursPaid(e, state.settings, timeOffTypes, state.companies);
    }
  }

  // Regular vs OT per OT WINDOW, computed on WORKED hours only. Holiday and
  // PTO/SICK do not push the worked total over the OT threshold. The window
  // size follows the company's otPeriod:
  //   - weekly:   one window per split week (as before).
  //   - biweekly: consecutive split weeks paired into 2-week blocks; a
  //               leftover single week is its own block.
  //   - semimonthly: half-month windows split at semiSecondDay (default 16),
  //               keyed by YYYY-MM plus which half.
  //   - monthly:  entries grouped by calendar month (YYYY-MM).
  const otPeriod = company.otPeriod || 'weekly';
  let otWindowGroups;
  if (otPeriod === 'biweekly') {
    otWindowGroups = [];
    for (let i = 0; i < weeks.length; i += 2) {
      const start = weeks[i].start;
      const end = (weeks[i + 1] || weeks[i]).end;
      otWindowGroups.push(inPP.filter(e => e.date >= start && e.date <= end));
    }
  } else if (otPeriod === 'semimonthly') {
    const splitDay = Number.isFinite(company.semiSecondDay) ? company.semiSecondDay : 16;
    const byHalf = new Map();
    for (const e of inPP) {
      const dom = parseInt(e.date.slice(8, 10), 10);
      const key = e.date.slice(0, 7) + (dom < splitDay ? '-A' : '-B');
      if (!byHalf.has(key)) byHalf.set(key, []);
      byHalf.get(key).push(e);
    }
    otWindowGroups = [...byHalf.values()];
  } else if (otPeriod === 'monthly') {
    const byMonth = new Map();
    for (const e of inPP) {
      const key = e.date.slice(0, 7);
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(e);
    }
    otWindowGroups = [...byMonth.values()];
  } else {
    otWindowGroups = weeks.map(w => inPP.filter(e => e.date >= w.start && e.date <= w.end));
  }

  for (const grp of otWindowGroups) {
    const windowWorked = grp.reduce((s, e) => s + computeHoursWorked(e, state.settings, state.companies), 0);
    ppRegular += Math.min(windowWorked, otThreshold);
    ppOT += Math.max(0, windowWorked - otThreshold);
  }

  const ppTotal = ppRegular + ppOT + ppHoliday + ppTimeOff;

  document.getElementById('ppTotal').textContent = ppTotal.toFixed(2);
  document.getElementById('ppRegular').textContent = ppRegular.toFixed(2);
  document.getElementById('ppOT').textContent = ppOT.toFixed(2);
  document.getElementById('ppTimeOff').textContent = ppTimeOff.toFixed(2);

  renderBalances(state, timeOffTypes, entries);
}

function renderWeekCard(week, state, company, timeOffTypes, entriesMap) {
  const card = document.createElement('div');
  card.className = 'card week-card';

  const entries = Object.values(entriesMap)
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
    const workedH = dd.empty ? 0 : computeHoursWorked(dd, state.settings, state.companies);
    const paidH = dd.empty ? 0 : computeHoursPaid(dd, state.settings, timeOffTypes, state.companies);
    if (dd.timeOff === 'HOLIDAY') {
      worked += workedH;
      holiday += paidH - workedH;
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

  // The per-week regular/OT split only makes sense when the OT window IS the
  // week (otPeriod weekly). For any other window (biweekly/semimonthly/
  // monthly) the window does not align to a single week, so we can't split it
  // here; show worked hours only and let the pay-period total carry OT.
  const otPeriod = company.otPeriod || 'weekly';
  let breakdownHtml;
  if (otPeriod === 'weekly') {
    const otThreshold = Number.isFinite(company.otThreshold) ? company.otThreshold : 40;
    const ot = Math.max(0, worked - otThreshold);
    const reg = Math.min(worked, otThreshold);
    breakdownHtml = `<span>Regular: <strong>${reg.toFixed(2)}</strong></span>`
      + (ot > 0 ? `<span>OT: <strong style="color:var(--success)">${ot.toFixed(2)}</strong></span>` : '');
  } else {
    breakdownHtml = `<span>Worked: <strong>${worked.toFixed(2)}</strong></span>`;
  }
  html += `<div class="week-totals">
    <span>Total: <strong>${(worked + holiday + timeOff).toFixed(2)}</strong></span>
    ${breakdownHtml}
    ${holiday > 0 ? `<span>Holiday: <strong>${holiday.toFixed(2)}</strong></span>` : ''}
    ${timeOff > 0 ? `<span>Time off: <strong>${timeOff.toFixed(2)}</strong></span>` : ''}
  </div>`;

  card.innerHTML = html;
  card.querySelectorAll('tr[data-date]').forEach(tr => {
    tr.onclick = () => openEntryModal(tr.dataset.date, state, company.id);
  });
  return card;
}

function renderBalances(state, timeOffTypes = state.timeOffTypes, entriesMap = state.entries) {
  const container = document.getElementById('balancesList');
  const entries = Object.values(entriesMap);
  let html = '';

  for (const t of timeOffTypes) {
    if (!t.countsAgainstPool) {
      const usedHours = sumHoursForCode(entries, t.code, 'all', state.settings, timeOffTypes, state.companies);
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

    const b = computePoolBalance(t, timeOffTypes, entries, state.settings, state.companies);
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
        const u = sumHoursForCode(entries, bt.code, 'all', state.settings, timeOffTypes, state.companies);
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
