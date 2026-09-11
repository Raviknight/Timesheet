/**
 * src/ui/toast.js
 *
 * Brief floating message at the bottom of the screen.
 *
 * Two flavors, because they serve different purposes:
 *   - toast('Saved')            confirmation, 2s, neutral styling
 *   - toast(msg, { type, ms })  something went wrong and the user has to
 *                               read it before it disappears
 *
 * A network failure needs longer than a confirmation does: the message is
 * longer, it is unexpected, and acting on it means understanding it. Two
 * seconds is not enough to read "you are offline and editing is disabled".
 */

const DEFAULTS = { type: 'info', ms: 2000 };
const ERROR_MS = 6000;

let hideTimer = null;

/**
 * @param {string} msg
 * @param {{type?: 'info'|'warn'|'error', ms?: number}} [opts]
 *        type styles the toast; error and warn also default to a longer
 *        display time unless ms is given explicitly.
 */
export function toast(msg, opts = {}) {
  const t = document.getElementById('toast');
  if (!t) return;

  const type = opts.type || DEFAULTS.type;
  const ms = opts.ms != null
    ? opts.ms
    : (type === 'error' || type === 'warn' ? ERROR_MS : DEFAULTS.ms);

  // A new toast must cancel the previous timer, or a long error message gets
  // cut short by the timeout belonging to an earlier confirmation.
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  t.textContent = msg;
  t.className = 'toast show' + (type !== 'info' ? ' toast-' + type : '');
  hideTimer = setTimeout(() => {
    t.classList.remove('show');
    hideTimer = null;
  }, ms);
}
