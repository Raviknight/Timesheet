/**
 * src/ui/log.js
 *
 * Daily Log view. Shows all entries for a chosen year, grouped by month,
 * with monthly hour totals. Click any row to edit.
 */

import { entrySegments, dayShort, fmtDate } from '../core/time.js';
import { computeCompanyPools, coverageFromPools, paidHoursWithCoverage } from '../core/coverage.js';
import { escapeHtml, monthName } from '../core/format.js';
import { openEntryModal } from '../modals/entryModal.js';
import { activeCompany } from '../data/activeCompany.js';

/**
 * Flatten every active company's entries into one list, tagging each with the
 * company it belongs to (_companyId / _companyName) so a row can be labeled and
 * edited against the right company. The active company's set is state.entries;
 * the rest come from state.entriesByCompany. With a single company this is just
 * that company's entries, as before, plus the label.
 */
/**
 * The {cid, company, set} for every company whose entries the log shows: the
 * active company's set is state.entries, the rest come from entriesByCompany.
 * Shared by allCompanyEntries and the per-company coverage build so the two
 * iterate the same companies.
 */
function companyEntrySets(state) {
  const companies = Array.isArray(state.companies) ? state.companies : [];
  const byCompany = state.entriesByCompany || {};
  const activeId = String(activeCompany(state).id ?? '');
  // Seed with the active company so single-company / local mode always works
  // even before entriesByCompany is populated.
  const ids = new Set([activeId]);
  for (const c of companies.filter(c => c.isActive !== false)) ids.add(String(c.id ?? ''));

  const out = [];
  for (const cid of ids) {
    const set = byCompany[cid] || (cid === activeId ? state.entries : null);
    if (!set) continue;
    out.push({ cid, company: companies.find(c => String(c.id ?? '') === cid) || null, set });
  }
  return out;
}

function allCompanyEntries(state) {
  const nameById = {};
  for (const c of (Array.isArray(state.companies) ? state.companies : [])) {
    nameById[String(c.id ?? '')] = c.name;
  }
  const out = [];
  for (const { cid, set } of companyEntrySets(state)) {
    for (const e of Object.values(set)) {
      out.push({ ...e, _companyId: cid, _companyName: nameById[cid] || '' });
    }
  }
  return out;
}

/**
 * Pool coverage per company (date -> coverage), so a per-day paid figure reads
 * the same as the dashboard. Current-cycle days honor coverage; out-of-scope
 * dates (e.g. a prior log year) pay base, so historical rows are unchanged.
 */
function coverageByCompany(state) {
  const asOf = fmtDate(new Date());
  const map = {};
  for (const { cid, company, set } of companyEntrySets(state)) {
    const pools = computeCompanyPools({
      company, timeOffTypes: timeOffTypesFor(state, cid), entries: set,
      settings: state.settings, companies: state.companies, asOf,
    });
    map[cid] = coverageFromPools(pools);
  }
  return map;
}

/** Time-off types for a given company id, falling back to the active set. */
function timeOffTypesFor(state, companyId) {
  return (state.timeOffByCompany || {})[String(companyId ?? '')] || state.timeOffTypes;
}

export function renderLog(state) {
  renderLogYears(state);
  const year = state.ui.logYear + '';
  const search = (document.getElementById('logSearch').value || '').toLowerCase().trim();
  const list = document.getElementById('entriesList');
  // Label rows with the company only when more than one active company exists.
  const multiCompany = (Array.isArray(state.companies)
    ? state.companies.filter(c => c.isActive !== false)
    : []).length > 1;

  const all = allCompanyEntries(state)
    .filter(e => e.date.startsWith(year))
    .filter(e => {
      if (!search) return true;
      return (e.notes || '').toLowerCase().includes(search)
        || (e.timeOff || '').toLowerCase().includes(search)
        || (e._companyName || '').toLowerCase().includes(search)
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

  // Pool coverage per company, so per-day paid hours match the dashboard.
  const covByCo = coverageByCompany(state);

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
        monthTotal += paidHoursWithCoverage(e, state.settings, timeOffTypesFor(state, e._companyId), state.companies, covByCo[e._companyId]);
      }
    }
    html += `<div style="margin-top:14px;margin-bottom:6px;font-size:12px;font-weight:600;
      color:var(--text-2);text-transform:uppercase;letter-spacing:0.04em">
      ${monthName(+mo - 1)} ${y}
      <span class="muted" style="font-weight:400">· ${monthTotal.toFixed(1)} h</span>
    </div>`;
    for (const e of byMonth[m]) {
      const h = paidHoursWithCoverage(e, state.settings, timeOffTypesFor(state, e._companyId), state.companies, covByCo[e._companyId]);
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
      const companyTag = multiCompany && e._companyName
        ? ` <span class="badge">${escapeHtml(e._companyName)}</span>`
        : '';
      html += `<div class="entry-row" data-date="${e.date}" data-company-id="${escapeHtml(e._companyId || '')}">
        <div class="entry-date"><div class="day">${dn}</div><div>${day}</div></div>
        <div>${timeOffPill}<span class="entry-times">${timeStr}</span>${multiBadge}${companyTag}${noteSnip}</div>
        <div class="entry-hours">${h > 0 ? h.toFixed(2) : '—'}</div>
      </div>`;
    }
  }

  list.innerHTML = html;
  list.querySelectorAll('.entry-row').forEach(el => {
    el.onclick = () => openEntryModal(el.dataset.date, state, { companyId: el.dataset.companyId || undefined });
  });
}

function renderLogYears(state) {
  const sel = document.getElementById('logYear');
  const years = new Set();
  allCompanyEntries(state).forEach(e => years.add(e.date.slice(0, 4)));
  years.add(new Date().getFullYear() + '');
  years.add((new Date().getFullYear() - 1) + '');
  const sorted = [...years].sort().reverse();
  sel.innerHTML = sorted.map(y => `<option value="${y}">${y}</option>`).join('');
  sel.value = state.ui.logYear;
  sel.onchange = () => { state.ui.logYear = +sel.value; renderLog(state); };
}

export function wireLog(state) {
  document.getElementById('btnAddEntry').onclick =
    () => openEntryModal(fmtDate(new Date()), state, { source: 'log' });
  document.getElementById('logSearch').oninput = () => renderLog(state);
}
