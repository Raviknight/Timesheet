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

-- Companies: users see companies they're a member of
create policy "Members can view companies" on companies for select
  using (id in (select company_id from company_members where user_id = auth.uid()));
create policy "Owners can update companies" on companies for update
  using (owner_user_id = auth.uid());
create policy "Anyone authenticated can create companies" on companies for insert
  with check (auth.uid() = owner_user_id);

-- company_members: members see their own memberships
create policy "Users see own memberships" on company_members for select
  using (user_id = auth.uid());
create policy "Owners manage memberships" on company_members for all
  using (company_id in (select id from companies where owner_user_id = auth.uid()));

-- Settings, entries, pays, time_off_types: all scoped to user
create policy "Users access own settings" on settings for all using (auth.uid() = user_id);
create policy "Users access own entries"  on entries  for all using (auth.uid() = user_id);
create policy "Users access own pays"     on pays     for all using (auth.uid() = user_id);
create policy "Members access company time-off types" on time_off_types for all
  using (company_id in (select company_id from company_members where user_id = auth.uid()));
