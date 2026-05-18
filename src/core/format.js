/**
 * src/core/format.js
 *
 * Display formatting helpers. Anything that produces text for the user lives
 * here. Keeps UI modules from reinventing format logic.
 */

import { parseDate } from './time.js';

export function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/** "Mon, Jan 15, 2026" */
export function formatLong(d) {
  const dt = parseDate(d);
  return dt.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}

/** "$1,234" with no decimals — for money displays */
export function formatMoney(n) {
  return '$' + (+n || 0).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/** "$1,234.56" — for editable money fields */
export function formatMoneyDecimal(n) {
  return '$' + (+n || 0).toFixed(2);
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthName(monthZeroIndexed) {
  return MONTH_NAMES[monthZeroIndexed] || '';
}
