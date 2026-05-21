-- 2026-05-21-biweekly-parity.sql
--
-- Step 3e.2.1: switch the biweekly model from a per-company anchor date
-- to a global "odd or even ISO Monday-week parity" tag. The parity model
-- has no DST sensitivity and no calendar drift, and it removes the need
-- for users to pick an anchor date.
--
-- This script documents what was already applied to the live DB by hand.
-- It is idempotent so re-running it is safe.

begin;

-- 1. Replace the biweekly anchor column with a parity column.
alter table companies
  drop column if exists biweekly_ref_date;

alter table companies
  add column if not exists biweekly_start_parity text
    check (biweekly_start_parity in ('odd','even'));

-- 2. Seed the two known companies. The previous biweekly anchor
--    (2025-12-28, a Sunday in ISO week index 2920) put Ferry on the
--    even-Mon cycle and Phillips on the odd-Mon cycle by the old math.
--    Per Ravi's preference for the new model: Ferry='odd', Phillips='even'.
update companies
   set biweekly_start_parity = 'odd'
 where id = '93bf1d42-4f06-4d14-ad72-587f787b7c0a';  -- Ferry

update companies
   set biweekly_start_parity = 'even'
 where id = '944f07e7-8cbf-4ea3-8858-3863c37ce510';  -- Phillips Precision

-- 3. Verify.
select id, name, pay_frequency, week_start_dow, biweekly_start_parity
  from companies
 order by created_at;

commit;

-- ---------------------------------------------------------------------------
-- Rollback helper (only if you need to undo):
--
-- alter table companies drop column if exists biweekly_start_parity;
-- alter table companies add column if not exists biweekly_ref_date date;
