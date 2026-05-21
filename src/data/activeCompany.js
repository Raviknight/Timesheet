/**
 * src/data/activeCompany.js
 *
 * Resolve which company "the user is currently looking at" given the
 * in-memory state object. Centralized here so the dashboard, the pay
 * modal, and the settings preview all agree on the resolution rule.
 *
 * Rule:
 *   1. state.profile.companyId names the active company; use it.
 *   2. If unset or stale, fall back to the first company in state.companies.
 *   3. If state.companies is empty (degenerate / pre-bootstrap state),
 *      return a synthetic biweekly/Monday/odd-parity company so
 *      pay-period math still has something to operate on.
 *
 * The synthetic fallback exists strictly to keep the UI from crashing
 * during a transient empty state. It should never be persisted; callers
 * that need to save a company must use a real one.
 */

const SYNTHETIC_DEFAULT = Object.freeze({
  id: null,
  name: '',
  payFrequency: 'biweekly',
  weekStartDow: 1,
  biweeklyStartParity: 'odd',
  semiFirstDay: null,
  semiSecondDay: null,
  monthlyStartDay: null,
  advancedAnchorDate: null,
  advancedCycleDays: null,
});

export function activeCompany(state) {
  const list = Array.isArray(state?.companies) ? state.companies : [];
  const id = state?.profile?.companyId;
  if (id) {
    const found = list.find(c => c.id === id);
    if (found) return found;
  }
  return list[0] || SYNTHETIC_DEFAULT;
}

/** Look up a company by its display name; falls back to activeCompany. */
export function companyByName(state, name) {
  const list = Array.isArray(state?.companies) ? state.companies : [];
  if (name) {
    const found = list.find(c => c.name === name);
    if (found) return found;
  }
  return activeCompany(state);
}
