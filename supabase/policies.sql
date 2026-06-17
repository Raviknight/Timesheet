-- policies.sql
--
-- Phase 3, Step 2: Row-Level Security for Time Sheet on Supabase.
-- Run this ONCE, in the SQL Editor, AFTER schema.sql.
--
-- Source of truth: docs/PHASE_3_PLAN.md ("Row-Level Security (RLS) policies").
-- Reproduced verbatim from the plan; the plan is the reviewed design.
--
-- Principle: every table has RLS enabled and every query implicitly filters
-- by the authenticated user. Get this right once, never worry about app-layer
-- data leaks. Note: a `for all ... using (...)` policy with no `with check`
-- applies the `using` expression to INSERT as well, so writes are guarded too.
--
-- Verify after running: Table Editor in the sidebar should show a green RLS
-- shield on every table. Then test with two accounts in incognito windows
-- (PHASE_3_PLAN.md "Risks") before trusting it.
--
-- NOTE: Companies SELECT and INSERT policies, and the company_members
-- ALL policy, were loosened during Phase 3 Step 5a debugging.
-- The original strict versions caused infinite recursion (company_members
-- ALL policy) and an unresolved RLS rejection on company INSERT despite
-- correct auth.uid() values. See docs/CONTEXT.md for the full debugging
-- story. As of 0.4 entries and pays are membership-scoped (member_id in the
-- caller's company_members rows), no longer user_id-scoped. The remaining
-- deferred shortcuts are the companies SELECT and INSERT USING(true) policies,
-- slated for tightening in chunk 0.6.

-- Enable RLS on all tables
alter table profiles         enable row level security;
alter table companies        enable row level security;
alter table company_members  enable row level security;
alter table settings         enable row level security;
alter table time_off_types   enable row level security;
alter table entries          enable row level security;
alter table pays             enable row level security;

-- Profiles: users can only see and edit their own profile
create policy "Users can view own profile"   on profiles for select using (auth.uid() = user_id);
create policy "Users can update own profile" on profiles for update using (auth.uid() = user_id);
create policy "Users can insert own profile" on profiles for insert with check (auth.uid() = user_id);

-- Companies: SELECT and INSERT loosened during Phase 3 Step 5a (see NOTE above)
CREATE POLICY "Authenticated users can view companies"
  ON companies FOR SELECT
  TO authenticated
  USING (true);
create policy "Owners can update companies" on companies for update
  using (owner_user_id = auth.uid());
CREATE POLICY "Authenticated users can create companies"
  ON companies FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- company_members: members see their own memberships
create policy "Users see own memberships" on company_members for select
  using (user_id = auth.uid());
-- "Owners manage memberships" replaced to fix infinite recursion (see NOTE above)
CREATE POLICY "Users manage own memberships"
  ON company_members FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Settings, entries, pays, time_off_types: all scoped to user
create policy "Users access own settings" on settings for all using (auth.uid() = user_id);
create policy "Members access own entries" on entries for all
  using (
    member_id in (
      select id from company_members where user_id = auth.uid()
    )
  );
create policy "Members access own pays" on pays for all
  using (
    member_id in (
      select id from company_members where user_id = auth.uid()
    )
  );
create policy "Members access company time-off types" on time_off_types for all
  using (company_id in (select company_id from company_members where user_id = auth.uid()));
