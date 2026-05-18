/**
 * src/auth/roles.js
 *
 * Capability checks. Each user role gets a set of capabilities. The UI calls
 * `can(profile, 'capabilityName')` rather than checking roles directly, so
 * we can refine permissions later without touching every view.
 *
 * Today (personal mode): every user is 'owner' and can do everything.
 * Future (multi-tenant): admin assigns roles, supervisors get team scope,
 * employees can only view their own data.
 *
 * See ROADMAP.md Phase 3 for the rollout plan.
 */

/**
 * All capabilities the app knows about. Add new ones here as features land.
 */
export const CAPABILITIES = {
  // Own data
  editOwnEntries: 'Add, edit, or delete your own time entries',
  editOwnPays: 'Add, edit, or delete your own paychecks',
  editSettings: 'Change pay period, time-off types, profile',
  exportOwnData: 'Export your own data as JSON or CSV',

  // Team scope (supervisor)
  viewTeamEntries: 'See entries for direct reports',
  approveTeamEntries: 'Approve or reject time entries',
  editTeamEntries: 'Edit entries on behalf of direct reports',

  // Company scope (admin)
  manageUsers: 'Add, remove, or change roles for users',
  manageCompany: 'Edit company-wide settings',
  viewAllEntries: 'See entries for everyone in the company',

  // Hardware
  registerPunchDevice: 'Add or remove punch hardware',
};

/** Role → set of capability keys. */
const ROLE_CAPABILITIES = {
  owner: new Set([
    'editOwnEntries', 'editOwnPays', 'editSettings', 'exportOwnData',
    // In personal mode the owner can also do everything else, since they
    // are the only user.
    'viewTeamEntries', 'approveTeamEntries', 'editTeamEntries',
    'manageUsers', 'manageCompany', 'viewAllEntries', 'registerPunchDevice',
  ]),
  admin: new Set([
    'editOwnEntries', 'editOwnPays', 'editSettings', 'exportOwnData',
    'viewTeamEntries', 'approveTeamEntries', 'editTeamEntries',
    'manageUsers', 'manageCompany', 'viewAllEntries', 'registerPunchDevice',
  ]),
  supervisor: new Set([
    'editOwnEntries', 'editOwnPays', 'editSettings', 'exportOwnData',
    'viewTeamEntries', 'approveTeamEntries', 'editTeamEntries',
  ]),
  employee: new Set([
    // Employees CANNOT edit their own entries once the multi-tenant version
    // ships. Their entries come from the punch device or a supervisor.
    'exportOwnData',
  ]),
};

export function can(profile, capability) {
  if (!profile) return false;
  const caps = ROLE_CAPABILITIES[profile.role] || ROLE_CAPABILITIES.employee;
  return caps.has(capability);
}

export function rolesAvailable() {
  return Object.keys(ROLE_CAPABILITIES);
}
