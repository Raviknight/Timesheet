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

import { SK } from '../data/schema.js';
import { saveKey } from '../app.js';
import { computeHours, computeSegmentHours, entrySegments, fmtDate, padHM, parseDate } from '../core/time.js';
import { resolveStandardDay } from '../data/standardDay.js';
import { activeCompany } from '../data/activeCompany.js';
import { escapeHtml } from '../core/format.js';
import { setSyncIdle } from '../ui/topbar.js';
import { toast } from '../ui/toast.js';

let modalSegments = [];
let editingDate = null;
let stateRef = null;
let rerender = () => {};

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
      stateRef.entries[newDate] ? 'inline-flex' : 'none';
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
  const dow = parseDate(date).getDay();
  if (dow === 0 || dow === 6) {
    return [{ clockIn: '07:00', clockOut: '12:00', breakTaken: false }];
  }
  const sd = resolveStandardDay(stateRef.settings);
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
  const existing = stateRef.entries[date];
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

export function openEntryModal(date, state) {
  // (state may not be passed if caller has already done initEntryModal)
  if (state) stateRef = state;
  fillTimeOffSelect();
  editingDate = date;
  document.getElementById('entryModalTitle').textContent =
    stateRef.entries[date] ? 'Edit Entry' : 'New Entry';
  document.getElementById('eDate').value = date;

  fillCompanySelect();
  loadFormForDate(date);
  renderSegments();
  updateComputedHours();

  document.getElementById('btnDeleteEntry').style.display =
    stateRef.entries[date] ? 'inline-flex' : 'none';
  document.getElementById('entryModal').classList.add('show');
}

function closeEntryModal() {
  document.getElementById('entryModal').classList.remove('show');
  editingDate = null;
  modalSegments = [];
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
  const existing = date ? stateRef.entries[date] : null;
  const defaultId = String(activeCompany(stateRef).id ?? '');
  const selectedId = existing && existing.companyId != null
    ? String(existing.companyId)
    : defaultId;

  const opts = activeList.map(c => ({ id: String(c.id ?? ''), name: c.name, inactive: false }));
  // The entry's company may not be active (e.g. a deactivated Ferry). Keep it
  // as a selected option so we don't force the entry onto another company.
  if (selectedId && !opts.some(o => o.id === selectedId)) {
    const found = companies.find(c => String(c.id ?? '') === selectedId);
    opts.unshift({ id: selectedId, name: found ? found.name : selectedId, inactive: true });
  }

  sel.innerHTML = opts.map(o =>
    `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}${o.inactive ? ' (inactive)' : ''}</option>`
  ).join('') || `<option value="${escapeHtml(selectedId)}"></option>`;
  sel.value = selectedId || (opts[0] && opts[0].id) || '';

  const row = document.getElementById('eCompanyRow');
  if (row) row.style.display = opts.length > 1 ? '' : 'none';
}

function renderSegments() {
  const c = document.getElementById('segmentsList');
  if (modalSegments.length === 0) {
    c.innerHTML = `<div class="muted" style="font-size:13px;padding:8px 0">
      No segments. Tap "Add segment" to record a clock in/out, or leave empty
      for time-off-only entries.</div>`;
    return;
  }
  let html = '';
  modalSegments.forEach((s, i) => {
    const segH = computeSegmentHours(
      s,
      document.getElementById('eDate').value || fmtDate(new Date()),
      stateRef.settings
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
        stateRef.settings
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
        stateRef.settings
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
  };
  document.getElementById('eComputedHours').textContent =
    computeHours(tmp, stateRef.settings, stateRef.timeOffTypes).toFixed(2);
}

async function saveEntry() {
  const date = document.getElementById('eDate').value;
  if (!date) { toast('Pick a date'); return; }

  const cleanSegs = modalSegments.filter(s => s.clockIn || s.clockOut);
  const timeOff = document.getElementById('eTimeOff').value || null;

  if (cleanSegs.length === 0 && !timeOff) {
    if (!confirm('No segments and no time off. Save as a blank entry anyway?')) return;
  }

  const entry = {
    date,
    segments: cleanSegs,
    timeOff,
    notes: document.getElementById('eNotes').value.trim() || null,
    // Explicit company from the picker. Authoritative on the write path; the
    // storage layer only fills the active company when this is absent.
    companyId: document.getElementById('eCompany')?.value || null,
  };

  // If the date changed during editing, remove the old key
  if (editingDate && editingDate !== date) {
    delete stateRef.entries[editingDate];
  }
  stateRef.entries[date] = entry;
  if (!await saveKey(SK.entries, stateRef.entries, 'Entry')) return;
  setSyncIdle();
  closeEntryModal();
  rerender();
  toast('Saved');
}

async function deleteEntry() {
  if (!editingDate) return;
  if (!confirm('Delete this entry?')) return;
  delete stateRef.entries[editingDate];
  if (!await saveKey(SK.entries, stateRef.entries, 'Entry')) return;
  setSyncIdle();
  closeEntryModal();
  rerender();
  toast('Deleted');
}
