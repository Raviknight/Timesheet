-- 2026-05-21-companies-pay-period.sql
--
-- Step 3e.1: move pay-period configuration from per-user settings JSON onto
-- the companies table. Adds the columns and seeds existing rows from
-- current user-level settings (biweekly, Monday, biweeklyRef 2025-12-28).
--
-- Run interactively in the Supabase SQL Editor. The transaction commits at
-- the end; if any verification block fails, ROLLBACK by hand before COMMIT
-- ran (or restore the column drop block at the bottom if already committed).

begin;

-- 1. Add the new columns.
alter table companies
  add column if not exists pay_frequency text not null default 'biweekly'
    check (pay_frequency in ('weekly','biweekly','semimonthly','monthly','advanced')),
  add column if not exists week_start_dow smallint not null default 1,
  add column if not exists biweekly_ref_date date,
  add column if not exists semi_first_day smallint,
  add column if not exists semi_second_day smallint,
  add column if not exists monthly_start_day smallint,
  add column if not exists advanced_anchor_date date,
  add column if not exists advanced_cycle_days smallint;

-- 2. Seed the two known companies with current per-user pay-period values.
--    Both get the same starting values; user can customize from the UI
--    after Step 3e.5 ships.
update companies
   set pay_frequency     = 'biweekly',
       week_start_dow    = 1,
       biweekly_ref_date = date '2025-12-28',
       semi_first_day    = null,
       semi_second_day   = null,
       monthly_start_day = null,
       advanced_anchor_date = null,
       advanced_cycle_days  = null
 where id in (
   '93bf1d42-4f06-4d14-ad72-587f787b7c0a',  -- Ferry
   '944f07e7-8cbf-4ea3-8858-3863c37ce510'   -- Phillips Precision
 );

-- 3. Verification. Should return exactly the two rows above with the
--    expected values. Inspect before running COMMIT below.
select id,
       name,
       pay_frequency,
       week_start_dow,
       biweekly_ref_date,
       semi_first_day,
       semi_second_day,
       monthly_start_day,
       advanced_anchor_date,
       advanced_cycle_days
  from companies
 order by created_at;

commit;

-- ---------------------------------------------------------------------------
-- ROLLBACK helper (only run if you committed and want to undo the column
-- additions). Drops the columns; the column-add block above is idempotent
-- via "if not exists" so you can re-run after a clean drop.
--
-- alter table companies
--   drop column if exists pay_frequency,
--   drop column if exists week_start_dow,
--   drop column if exists biweekly_ref_date,
--   drop column if exists semi_first_day,
--   drop column if exists semi_second_day,
--   drop column if exists monthly_start_day,
--   drop column if exists advanced_anchor_date,
--   drop column if exists advanced_cycle_days;
