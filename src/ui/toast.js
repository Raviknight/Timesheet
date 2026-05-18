/**
 * src/ui/toast.js
 *
 * Brief floating message at the bottom of the screen.
 */

export function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}
