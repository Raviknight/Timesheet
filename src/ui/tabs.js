/**
 * src/ui/tabs.js
 *
 * Tab switching. Calls the per-view render function on activation.
 */

import { renderDashboard } from './dashboard.js';
import { renderLog } from './log.js';
import { renderPaychecks } from './paychecks.js';
import { renderSettings } from './settings.js';

const RENDERERS = {
  dashboard: renderDashboard,
  log: renderLog,
  paychecks: renderPaychecks,
  settings: renderSettings,
};

export function switchView(name, state) {
  state.ui.currentView = name;

  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === name);
  });
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === 'view-' + name);
  });

  const fn = RENDERERS[name];
  if (fn) fn(state);
}

export function wireTabs(state) {
  document.querySelectorAll('.tab').forEach(t => {
    t.onclick = () => switchView(t.dataset.view, state);
  });
}
