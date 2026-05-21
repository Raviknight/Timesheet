/**
 * src/data/bootstrap.js
 *
 * First-time user setup. When a user signs in for the first time
 * their Supabase account has zero rows in our tables. This module
 * detects that and creates the starter set:
 *
 *   - profiles row (name + role + active_company_id)
 *   - companies row (default workspace)
 *   - company_members row (owner of the new company)
 *   - 4 time_off_types rows (PTO, Sick, Holiday, Unpaid)
 *
 * Order matters because of RLS: companies can only be SELECTed
 * after the user is a member, so we INSERT in dependency order
 * and avoid SELECTing rows we just created in the same flow.
 */

import { supabase } from './supabase.js';
import { DEFAULT_TIME_OFF_TYPES } from './schema.js';

/**
 * Check if the current user has been bootstrapped.
 * Returns the existing profile (with active_company_id) or null.
 */
export async function getExistingProfile() {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('getExistingProfile error:', error);
    throw error;
  }
  return data;
}

/**
 * Run the full bootstrap. Should only be called when
 * getExistingProfile() returns null.
 *
 * Returns the new profile object (with active_company_id).
 */
export async function bootstrapNewUser(userId, email) {
  // 1. Insert default company
  const companyName = email.split('@')[0] + "'s workspace";
  const { data: company, error: companyError } = await supabase
    .from('companies')
    .insert({
      name: companyName,
      owner_user_id: userId,
    })
    .select()
    .single();
  if (companyError) {
    console.error('bootstrap: company insert failed', companyError);
    throw companyError;
  }

  // 2. Insert company_members row so RLS lets us see the company
  const { error: memberError } = await supabase
    .from('company_members')
    .insert({
      company_id: company.id,
      user_id: userId,
      role: 'owner',
    });
  if (memberError) {
    console.error('bootstrap: member insert failed', memberError);
    throw memberError;
  }

  // 3. Insert profile, linking to the new company
  const displayName = email.split('@')[0];
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .insert({
      user_id: userId,
      name: displayName,
      role: 'owner',
      active_company_id: company.id,
    })
    .select()
    .single();
  if (profileError) {
    console.error('bootstrap: profile insert failed', profileError);
    throw profileError;
  }

  // 4. Insert the default time-off types for this company
  const timeOffRows = DEFAULT_TIME_OFF_TYPES.map(t => ({
    company_id: company.id,
    code: t.code,
    label: t.label,
    pool_days: t.poolDays || 0,
    hours_per_day: t.hoursPerDay || 8,
    counts_against_pool: t.countsAgainstPool || false,
    shared_pool_with: t.sharedPoolWith || null,
    unpaid: t.unpaid || false,
    additive: t.additive || false,
  }));
  const { error: typesError } = await supabase
    .from('time_off_types')
    .insert(timeOffRows);
  if (typesError) {
    console.error('bootstrap: time-off types insert failed', typesError);
    throw typesError;
  }

  console.log('Bootstrap complete for user', userId);
  return profile;
}

/**
 * Convenience wrapper: get profile or bootstrap if missing.
 * Returns the profile in both cases.
 */
export async function ensureBootstrapped(userId, email) {
  const existing = await getExistingProfile();
  if (existing) return existing;
  return await bootstrapNewUser(userId, email);
}
