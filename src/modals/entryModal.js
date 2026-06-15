/**
 * src/modals/entryModal.js
 *
 * Multi-segment entry editor. Each entry is for ONE date and contains:
 *   - 0+ work segments (each with clock in/out, optional break in/out)
 *   - Optional time-off code (PTO, Sick, Holiday, Unpaid)
 *   - Optional notes
 *
 * The modal owns its own working copy of segments[] (`modalSegments`) which
 * only gets committed to state.entries on Save.
 */

import { ensureEntriesForCompany, saveEntriesForCompany } from '../app.js';
import { computeHours, computeSegmentHours, entrySegments, fmtDate, padHM, parseDate, resolveBreakMinutes } from '../core/time.js';
import { resolveStandardDay } from '../data/standardDay.js';
import { activeCompany } from '../data/activeCompany.js';
import { escapeHtml } from '../core/format.js';
import { setSyncIdle } from '../ui/topbar.js';
import { toast } from '../ui/toast.js';

let modalSegments = [];
let editingDate = null;
// Which company's timesheet this modal session is editing. Set when the modal
// opens (from the Daily Log row, dashboard tab, or active company for a new
// entry). The form reads from and writes to THIS company's set; the company
// picker can still reassign the entry to another company on save.
let editingCompanyId = null;
// True only when the modal was opened from the Daily Log "+ Add Entry" button
// with no company chosen. In that mode the company picker is required and a
// company change re-scopes the session + applies the Standard Day prefill.
let newFromLog = false;
let stateRef = null;
let rerender = () => {};

/** The {date: entry} map for the company this modal session is editing. For
 *  the active company this is the SAME object as stateRef.entries. When no
 *  company is chosen yet (Daily Log "+ Add Entry"), there is no set to read,
 *  so an empty map is returned and the form stays blank until a pick. */
function editingEntries() {
  if (editingCompanyId == null) return {};
  const byCompany = stateRef.entriesByCompany || {};
  return byCompany[String(editingCompanyId)] || stateRef.entries;
}

export function initEntryModal(state, onAfterSave) {
  stateRef = state;
  rerender = onAfterSave;

  document.getElementById('btnAddSegment').onclick = () => {
    const isFirst = modalSegments.length === 0;
    modalSegments.push({ clockIn: null, clockOut: null, breakTaken: isFirst });
    renderSegments();
    updateComputedHours();
  };

  // Date change: reload the form for the newly selected date. If an entry
  // already exists for that date, load it; otherwise reset to defaults for
  // that day-of-week. Prevents Monday's draft values from bleeding into
  // Tuesday.
  document.getElementById('eDate').addEventListener('change', () => {
    const newDate = document.getElementById('eDate').value;
    if (!newDate) return;
    editingDate = newDate;
    fillCompanySelect();
    loadFormForDate(newDate);
    document.getElementById('btnDeleteEntry').style.display =
      editingEntries()[newDate] ? 'inline-flex' : 'none';
    renderSegments();
    updateComputedHours();
  });

  // Time-off selection: any code clears segments (implied hours come from
  // the type via computeHours). Clearing the code restores DOW defaults.
  document.getElementById('eTimeOff').addEventListener('change', (ev) => {
    if (ev.target.value) {
      modalSegments = [];
    } else {
      const date = document.getElementById('eDate').value || fmtDate(new Date());
      modalSegments = defaultSegmentsForDate(date);
    }
    renderSegments();
    updateComputedHours();
  });

  // Company change: the per-company break can differ, so refresh the live
  // segment/day hour previews. Does not touch the segments the user entered.
  // When opened from the Daily Log with no company yet, picking one also
  // re-scopes this session to that company and applies its Standard Day
  // prefill (or loads that company's existing entry for the date).
  document.getElementById('eCompany').addEventListener('change', () => {
    if (newFromLog) {
      const sel = document.getElementById('eCompany');
      const date = document.getElementById('eDate').value;
      editingCompanyId = sel.value || null;
      hideEntryError();
      loadFormForDate(date);
      document.getElementById('btnDeleteEntry').style.display =
        editingEntries()[date] ? 'inline-flex' : 'none';
    }
    renderSegments();
    updateComputedHours();
  });

  document.getElementById('btnCancelEntry').onclick = closeEntryModal;
  document.getElementById('btnSaveEntry').onclick = saveEntry;
  document.getElementById('btnDeleteEntry').onclick = deleteEntry;
  document.getElementById('entryModal').onclick = (e) => {
    if (e.target.id === 'entryModal') closeEntryModal();
  };
}

/**
 * Default segments for a brand-new entry on the given date.
 *
 * Weekday (Mon-Fri): one segment from the user's Standard Day (seg1Start
 * to seg1End), break taken by default.
 * Weekend (Sat/Sun): one segment 07:00 to 12:00, no break.
 */
function defaultSegmentsForDate(date) {
  // No company chosen yet (Daily Log "+ Add Entry"): no Standard Day prefill
  // until the user picks a company. The on-company-change handler fills it in.
  if (editingCompanyId == null) return [];
  const dow = parseDate(date).getDay();
  if (dow === 0 || dow === 6) {
    return [{ clockIn: '07:00', clockOut: '12:00', breakTaken: false }];
  }
  // Prefill seg1 from the company this modal is scoped to, falling back to the
  // user-level Standard Day, then the hardcoded default.
  const company = (stateRef.companies || [])
    .find(c => String(c.id ?? '') === String(editingCompanyId ?? ''));
  const sd = resolveStandardDay(stateRef.settings, company || null);
  return [{
    clockIn: padHM(sd.seg1Start),
    clockOut: padHM(sd.seg1End),
    breakTaken: true,
  }];
}

/**
 * Populate modalSegments + the time-off and notes fields for the given
 * date. Loads an existing entry if there is one; otherwise applies the
 * day-of-week defaults.
 */
function loadFormForDate(date) {
  const existing = editingEntries()[date];
  if (existing) {
    const segs = entrySegments(existing);
    modalSegments = segs.length ? JSON.parse(JSON.stringify(segs)) : [];
    document.getElementById('eTimeOff').value = existing.timeOff || '';
    document.getElementById('eNotes').value = existing.notes || '';
  } else {
    modalSegments = defaultSegmentsForDate(date);
    document.getElementById('eTimeOff').value = '';
    document.getElementById('eNotes').value = '';
  }
}

export function openEntryModal(date, state, context = {}) {
  // (state may not be passed if caller has already done initEntryModal)
  if (state) stateRef = state;
  // context: { source: 'payperiod' | 'log', companyId } — where the modal was
  // opened from, and the company it should be scoped to (if known).
  const { source = null, companyId = null } = context;
  // Scope this session to:
  //  - the given company (Pay Period tab, or an existing entry's own company),
  //  - no company at all when added from the Daily Log (forces a pick),
  //  - else the active company (back-compat for any other caller).
  editingCompanyId = companyId != null
    ? String(companyId)
    : (source === 'log' ? null : String(activeCompany(stateRef).id ?? ''));
  newFromLog = source === 'log' && companyId == null;
  hideEntryError();
  fillTimeOffSelect();
  editingDate = date;
  const entries = editingEntries();
  document.getElementById('entryModalTitle').textContent =
    entries[date] ? 'Edit Entry' : 'New Entry';
  document.getElementById('eDate').value = date;

  fillCompanySelect();
  loadFormForDate(date);
  renderSegments();
  updateComputedHours();

  document.getElementById('btnDeleteEntry').style.display =
    entries[date] ? 'inline-flex' : 'none';
  document.getElementById('entryModal').classList.add('show');
}

function closeEntryModal() {
  document.getElementById('entryModal').classList.remove('show');
  editingDate = null;
  editingCompanyId = null;
  newFromLog = false;
  hideEntryError();
  modalSegments = [];
}

function showEntryError(msg) {
  const el = document.getElementById('eCompanyError');
  if (!el) return;
  el.textContent = msg;
  el.style.display = '';
}

function hideEntryError() {
  const el = document.getElementById('eCompanyError');
  if (!el) return;
  el.textContent = '';
  el.style.display = 'none';
}

function fillTimeOffSelect() {
  const sel = document.getElementById('eTimeOff');
  sel.innerHTML = '<option value="">— None —</option>'
    + stateRef.timeOffTypes.map(t =>
        `<option value="${t.code}">${t.label}</option>`).join('');
}

/**
 * Populate the company picker with ACTIVE companies and select the right one:
 *   - editing an existing entry → that entry's own company (so editing never
 *     silently reassigns it). If that company is now inactive, it is prepended
 *     as a selected option so the entry stays put.
 *   - new entry → the current active company (activeCompany).
 * With a single meaningful choice the row is hidden, so single-company use
 * flows exactly as before.
 */
function fillCompanySelect() {
  const sel = document.getElementById('eCompany');
  if (!sel) return;
  const companies = Array.isArray(stateRef.companies) ? stateRef.companies : [];
  const activeList = companies.filter(c => c.isActive !== false);

  const date = document.getElementById('eDate').value;
  const existing = date ? editingEntries()[date] : null;
  // Added from the Daily Log with no company yet: show a blank placeholder and
  // require an explicit pick before save (handled in saveEntry).
  const noCompany = editingCompanyId == null && !existing;
  // New entries default to the company this modal session is scoped to (the
  // dashboard tab / active company), not always the active company.
  const defaultId = String(editingCompanyId ?? activeCompany(stateRef).id ?? '');
  const selectedId = existing && existing.companyId != null
    ? String(existing.companyId)
    : (noCompany ? '' : defaultId);

  const opts = activeList.map(c => ({ id: String(c.id ?? ''), name: c.name, inactive: false }));
  // The entry's company may not be active (e.g. a deactivated Ferry). Keep it
  // as a selected option so we don't force the entry onto another company.
  if (selectedId && !opts.some(o => o.id === selectedId)) {
    const found = companies.find(c => String(c.id ?? '') === selectedId);
    opts.unshift({ id: selectedId, name: found ? found.name : selectedId, inactive: true });
  }

  let optionsHtml = opts.map(o =>
    `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}${o.inactive ? ' (inactive)' : ''}</option>`
  ).join('');
  if (noCompany) {
    optionsHtml = `<option value="" selected>Select company</option>` + optionsHtml;
  }
  sel.innerHTML = optionsHtml || `<option value="${escapeHtml(selectedId)}"></option>`;
  sel.value = noCompany ? '' : (selectedId || (opts[0] && opts[0].id) || '');

  const row = document.getElementById('eCompanyRow');
  // Always surface the picker when a pick is required, even for a single company.
  if (row) row.style.display = (noCompany || opts.length > 1) ? '' : 'none';
}

/**
 * Effective break for the company currently selected in the entry modal's
 * picker, falling back to the user setting. Drives the live segment/day hour
 * previews so they match how the entry will be paid under its company.
 */
function selectedCompanyBreak() {
  const cid = document.getElementById('eCompany')?.value || null;
  const company = cid != null
    ? (stateRef.companies || []).find(c => String(c.id ?? '') === String(cid))
    : null;
  return resolveBreakMinutes(stateRef.settings, company || null);
}

function renderSegments() {
  const c = document.getElementById('segmentsList');
  if (modalSegments.length === 0) {
    c.innerHTML = `<div class="muted" style="font-size:13px;padding:8px 0">
      No segments. Tap "Add segment" to record a clock in/out, or leave empty
      for time-off-only entries.</div>`;
    return;
  }
  const breakMin = selectedCompanyBreak();
  let html = '';
  modalSegments.forEach((s, i) => {
    const segH = computeSegmentHours(
      s,
      document.getElementById('eDate').value || fmtDate(new Date()),
      stateRef.settings,
      breakMin
    );
    html += `<div style="border:1px solid var(--border); border-radius:var(--radius);
      padding:10px; margin-bottom:8px; background: var(--surface-2);">
      <div class="row" style="justify-content: space-between; align-items: center; margin-bottom:6px;">
        <strong style="font-size:13px">Segment ${i + 1}</strong>
        <div class="row" style="gap:8px">
          <span class="badge" style="background:var(--primary-bg);color:var(--primary)">
            ${segH.toFixed(2)} h</span>
          ${modalSegments.length > 1
            ? `<button class="btn btn-sm btn-danger" data-seg-del="${i}" type="button">Remove</button>`
            : ''}
        </div>
      </div>
      <div class="row">
        <div class="grow"><label>Clock in</label>
          <input type="time" data-seg="${i}" data-f="clockIn" value="${padHM(s.clockIn)}"></div>
        <div class="grow"><label>Clock out</label>
          <input type="time" data-seg="${i}" data-f="clockOut" value="${padHM(s.clockOut)}"></div>
      </div>
      <div class="row" style="margin-top:8px">
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal">
          <input type="checkbox" data-seg-break="${i}" ${s.breakTaken === true ? 'checked' : ''}>
          Break taken
        </label>
      </div>
    </div>`;
  });
  c.innerHTML = html;

  c.querySelectorAll('input[data-seg]').forEach(inp => {
    inp.oninput = () => {
      const i = +inp.dataset.seg;
      modalSegments[i][inp.dataset.f] = inp.value || null;
      updateComputedHours();
      // Update the badge in-place to preserve focus
      const segH = computeSegmentHours(
        modalSegments[i],
        document.getElementById('eDate').value || fmtDate(new Date()),
        stateRef.settings,
        selectedCompanyBreak()
      );
      const badge = c.querySelectorAll('.badge')[i];
      if (badge) badge.textContent = segH.toFixed(2) + ' h';
    };
  });
  c.querySelectorAll('input[data-seg-break]').forEach(inp => {
    inp.onchange = () => {
      const i = +inp.dataset.segBreak;
      modalSegments[i].breakTaken = inp.checked;
      updateComputedHours();
      const segH = computeSegmentHours(
        modalSegments[i],
        document.getElementById('eDate').value || fmtDate(new Date()),
        stateRef.settings,
        selectedCompanyBreak()
      );
      const badge = c.querySelectorAll('.badge')[i];
      if (badge) badge.textContent = segH.toFixed(2) + ' h';
    };
  });
  c.querySelectorAll('button[data-seg-del]').forEach(b => {
    b.onclick = () => {
      modalSegments.splice(+b.dataset.segDel, 1);
      renderSegments();
      updateComputedHours();
    };
  });
}

function updateComputedHours() {
  const tmp = {
    date: document.getElementById('eDate').value,
    segments: modalSegments,
    timeOff: document.getElementById('eTimeOff').value || null,
    // Tag with the picked company so break resolves per that company.
    companyId: document.getElementById('eCompany')?.value || null,
  };
  document.getElementById('eComputedHours').textContent =
    computeHours(tmp, stateRef.settings, stateRef.timeOffTypes, stateRef.companies).toFixed(2);
}

async function saveEntry() {
  const date = document.getElementById('eDate').value;
  if (!date) { toast('Pick a date'); return; }

  const cleanSegs = modalSegments.filter(s => s.clockIn || s.clockOut);
  const timeOff = document.getElementById('eTimeOff').value || null;

  if (cleanSegs.length === 0 && !timeOff) {
    if (!confirm('No segments and no time off. Save as a blank entry anyway?')) return;
  }

  const pickedCid = document.getElementById('eCompany')?.value || null;
  // Added from the Daily Log: a company must be picked before save.
  if (!pickedCid) { showEntryError('Select a company before saving.'); return; }

  const activeId = String(activeCompany(stateRef).id ?? '');
  // Source = the company whose timesheet is open; target = the company picked
  // (may differ when the user reassigns the entry).
  const sourceCid = String(editingCompanyId ?? activeId);
  const targetCid = String(pickedCid ?? sourceCid);

  const entry = {
    date,
    segments: cleanSegs,
    timeOff,
    notes: document.getElementById('eNotes').value.trim() || null,
    // Explicit company from the picker. Authoritative on the write path; the
    // storage layer only fills the active company when this is absent.
    companyId: pickedCid,
  };

  // Make sure the target company's set is in memory before we mutate it.
  await ensureEntriesForCompany(targetCid);

  const sourceSet = (stateRef.entriesByCompany || {})[sourceCid] || stateRef.entries;
  const targetSet = (stateRef.entriesByCompany || {})[targetCid] || stateRef.entries;

  // Remove the entry from its source: the old date (if the date changed) and
  // the current date (in case the company is changing but the date is not).
  if (editingDate && editingDate !== date) delete sourceSet[editingDate];
  delete sourceSet[date];
  // Write into the target company's set under the (possibly new) date.
  targetSet[date] = entry;

  // Persist the affected company sets. When source and target differ, both the
  // donor (delete) and the receiver (insert) must be saved.
  if (sourceCid === targetCid) {
    if (!await saveEntriesForCompany(targetCid)) return;
  } else {
    if (!await saveEntriesForCompany(sourceCid)) return;
    if (!await saveEntriesForCompany(targetCid)) return;
  }
  setSyncIdle();
  closeEntryModal();
  rerender();
  toast('Saved');
}

async function deleteEntry() {
  if (!editingDate) return;
  if (!confirm('Delete this entry?')) return;
  const activeId = String(activeCompany(stateRef).id ?? '');
  const sourceCid = String(editingCompanyId ?? activeId);
  const sourceSet = (stateRef.entriesByCompany || {})[sourceCid] || stateRef.entries;
  delete sourceSet[editingDate];
  if (!await saveEntriesForCompany(sourceCid)) return;
  setSyncIdle();
  closeEntryModal();
  rerender();
  toast('Deleted');
}
