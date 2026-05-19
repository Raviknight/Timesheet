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
import { computeHours, computeSegmentHours, entrySegments, fmtDate } from '../core/time.js';
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
    modalSegments.push({ clockIn: null, clockOut: null, breakStart: null, breakEnd: null });
    renderSegments();
    updateComputedHours();
  };

  document.getElementById('eDate').addEventListener('change', updateComputedHours);
  document.getElementById('btnCancelEntry').onclick = closeEntryModal;
  document.getElementById('btnSaveEntry').onclick = saveEntry;
  document.getElementById('btnDeleteEntry').onclick = deleteEntry;
  document.getElementById('entryModal').onclick = (e) => {
    if (e.target.id === 'entryModal') closeEntryModal();
  };
}

export function openEntryModal(date, state) {
  // (state may not be passed if caller has already done initEntryModal)
  if (state) stateRef = state;
  fillTimeOffSelect();
  editingDate = date;
  const e = stateRef.entries[date] || { date };
  document.getElementById('entryModalTitle').textContent =
    stateRef.entries[date] ? 'Edit Entry' : 'New Entry';
  document.getElementById('eDate').value = date;

  const existing = entrySegments(e);
  modalSegments = existing.length ? JSON.parse(JSON.stringify(existing)) : [];
  document.getElementById('eTimeOff').value = e.timeOff || '';
  document.getElementById('eNotes').value = e.notes || '';
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
          <input type="time" data-seg="${i}" data-f="clockIn" value="${s.clockIn || ''}"></div>
        <div class="grow"><label>Clock out</label>
          <input type="time" data-seg="${i}" data-f="clockOut" value="${s.clockOut || ''}"></div>
      </div>
      <div class="row" style="margin-top:6px">
        <div class="grow"><label>Break start <span class="muted">(optional)</span></label>
          <input type="time" data-seg="${i}" data-f="breakStart" value="${s.breakStart || ''}"></div>
        <div class="grow"><label>Break end <span class="muted">(optional)</span></label>
          <input type="time" data-seg="${i}" data-f="breakEnd" value="${s.breakEnd || ''}"></div>
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
  };
  document.getElementById('eComputedHours').textContent =
    computeHours(tmp, stateRef.settings).toFixed(2);
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
