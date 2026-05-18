# ROADMAP.md

Where this is going. Not a commitment, just a sketch so we don't paint
ourselves into corners.

## Phase 1 — Personal (current)

Single user, browser-only, synced via Anthropic `window.storage` or
`localStorage`.

✓ Multi-segment daily entries
✓ Configurable pay period systems
✓ PTO/Sick/Holiday/Unpaid tracking with shared pools
✓ Pay history + YTD totals
✓ Export to JSON and CSV
✓ Role scaffolding (capability checks in place, not enforced yet)

## Phase 2 — Sell to individuals

Same code, deployed to GitHub Pages (or buyer's own GitHub Pages fork).
Each buyer runs a separate instance on their own browser storage.

**Pricing model:** one-time purchase or modest subscription. Open to either.

**To do for Phase 2:**

- [ ] Settings → "About this app" page with version and license info
- [ ] First-run welcome screen (instead of immediately seeding Ravi's data)
- [ ] Optional: encrypted JSON export with a passphrase
- [ ] Optional: a simple landing page on the same Pages site

## Phase 3 — Small employer multi-tenant

A company admin creates the workspace, adds employees, optionally adds
supervisors. Employees see only their own time; supervisors see their team;
admin sees everyone.

**Required infra:**

- Backend (API + database)
- Authentication (email + password, or magic link)
- Row-level security on every query

**Stack candidates:**

1. **Supabase** — Postgres + auth + realtime + RLS in one platform. Fastest
   path. Free tier covers single-digit companies. ~$25/month at scale.
2. **Cloudflare Pages + Workers + D1** — same vendor as our frontend hosting.
   Cheaper at scale, more code to write upfront.
3. **Self-hosted Postgres + Node API on a VPS** — most control, most work.

**To do for Phase 3:**

- [ ] Pick stack (see above)
- [ ] Add login UI; wire profile.userId to authenticated identity
- [ ] Enforce capabilities from `src/auth/roles.js` in the UI
- [ ] Backend schema with company_id on every table
- [ ] Migration path from Phase 1 (export JSON → import to company workspace)
- [ ] Supervisor view: team list, pending approvals
- [ ] Admin view: user management, role assignments, company settings

## Phase 4 — Hardware punch integration

Fingerprint, RFID badge, or PIN punch devices push clock events to the
backend.

**Required additions:**

- Public API endpoint for punch events
- Device registration + auth tokens
- Reconcile pushed events with manual edits (who wins on conflict?)
- Audit log of every clock event, including edits

**To do for Phase 4:**

- [ ] Define punch event schema (device_id, user_id or badge_id, timestamp,
      event_type)
- [ ] Build hardware integration spec (REST or MQTT)
- [ ] Pick a reference device for testing (a cheap RFID reader + ESP32, or
      a tablet PWA running in kiosk mode)

## Phase 5 — Reports & compliance

When companies use this for payroll, they'll need:

- Period-end timesheet export per employee
- Approval workflow (supervisor signs off, admin closes the period)
- Audit trail of who edited what
- Compliance with local labor laws (e.g. overtime calc, meal break
  enforcement)

## Things we explicitly aren't doing

- Payroll calculation (taxes, deductions). That's a different product class
  and a regulatory minefield.
- Geolocation tracking. Privacy concern, and not needed for office work.
- Project/task-level time coding. Different product. Maybe a sibling app.
