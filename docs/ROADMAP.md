# ROADMAP.md

Where this is going. Not a commitment, just a sketch so we don't paint
ourselves into corners.

## Direction

The app becomes a multi-tenant employer/employee platform. Record-keeping
first (the timesheet, time off, and balances that exist today, made
multi-tenant), with paycheck and HR features later. The personal single-user
app is the seed; the company model grows around it without throwing it away.

## Phase 0 (settled): the company model

The shape everything else builds on. Decided, not yet fully built.

**Two views over one membership model.** The UI splits into an Employee view
("My Time") and a Company view ("Manage"), both reading the same shared
membership model:

- A company has members.
- A person can be a member of several companies.
- An owner-managed employee is a membership with no linked user. The owner
  records that person's time without the person having a login.
- A claim flow links a real login to an existing membership later, so an
  owner-managed employee can become a self-serve user without losing history.

**Config split.** Settings divide cleanly into two scopes:

- **Company-wide:** pay frequency, overtime rules, holiday calendar, and the
  time-off type definitions.
- **Per-employee:** standard day, break, PTO balances and accrual, and wage
  (wage comes later).

This split is what lets one company set the rules once while each employee
carries their own day shape and balances.

## Phase 1: owner-managed employees

The owner creates employee memberships with no linked user and records their
time, time off, and balances. Single operator, many tracked people. No auth
for the employees yet.

## Phase 2: roles and access (RLS)

Authentication plus row-level security on every query. Roles: owner/admin,
supervisor, employee. Employees see only their own time; supervisors see their
team; admin sees everyone. Capability checks from `src/auth/roles.js` get
enforced in the UI.

## Phase 3: invite and claim

The claim flow from Phase 0: an owner invites a person, the person signs up,
and their login links to the existing owner-managed membership. History is
preserved across the claim.

## Phase 4: employee self-tracking and parity

Claimed employees track their own time with the same capabilities the personal
app has today (clock in/out, multi-segment days, time off, balances). The
Employee view reaches parity with the standalone personal experience.

## Phase 5: punch-system integration

Fingerprint, RFID badge, or PIN punch devices push clock events to the
backend. Needs a public punch endpoint, device registration and tokens,
reconciliation of pushed events against manual edits, and an audit log of
every clock event including edits.

## Done

- **PTO accrual** is complete: per-type allotment with up-front or accrued
  grant, calendar / anniversary / fiscal cycle anchors off a per-person hire
  date with first-cycle proration, waiting periods, carry-over (none / cap /
  unlimited), shared pools, and a booking-order reservation model with a
  coverage-aware pay calc. See `docs/LOGIC.md` "PTO accrual".

## Deferred

- **Tenure-based allotment growth** is deferred to the company phase. The
  accrual model leaves the allotment as a plain value, so a pure tenure function
  can feed it later without changing the accrual rule.
- **Online request-and-approve workflow** is deferred. The data model already
  carries `status` and `bookedAt`, so an employee request / manager approval
  flow can drive them later without a schema change.
- **Engine-side per-cycle `poolByYear` resolution** is deferred until a real
  earlier hire date ever meets a non-none carry-over (today the allotment is
  resolved in the caller from `pool_days`, keeping the engine frozen).
- **Paycheck and HR features** beyond record-keeping: period-end exports per
  employee and compliance reporting come after the multi-tenant record-keeping
  core is solid.

## Things we explicitly aren't doing

- Payroll calculation (taxes, deductions). That's a different product class
  and a regulatory minefield.
- Geolocation tracking. Privacy concern, and not needed for office work.
- Project/task-level time coding. Different product. Maybe a sibling app.
