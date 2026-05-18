/**
 * src/auth/session.js
 *
 * Session and authentication helpers. The rest of the app calls these
 * functions instead of touching Supabase Auth directly, so we can swap
 * the provider later if needed and so error handling is consistent.
 *
 * All functions return Supabase's standard { data, error } shape.
 * Callers should check error first, then use data.
 *
 * The redirect URL for email verification points at the production
 * GitHub Pages site. To test locally, manually click the verification
 * link, then sign in normally in dev.
 */

import { supabase } from '../data/supabase.js';

const REDIRECT_URL = 'https://raviknight.github.io/Timesheet/';

/**
 * Get the current session (if any). Returns null if not logged in.
 * This is the function the app calls at boot to decide which view
 * to show.
 */
export async function getCurrentSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('getCurrentSession error:', error);
    return null;
  }
  return data.session;
}

/**
 * Create a new account. Triggers Supabase to send a verification
 * email. The user cannot sign in until they click the link.
 */
export async function signUp(email, password) {
  return await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: REDIRECT_URL,
    },
  });
}

/**
 * Sign an existing user in with email + password.
 * Fails with "Email not confirmed" if they haven't verified yet.
 */
export async function signIn(email, password) {
  return await supabase.auth.signInWithPassword({ email, password });
}

/** Sign out the current user. */
export async function signOut() {
  return await supabase.auth.signOut();
}

/**
 * Subscribe to auth state changes (login, logout, token refresh).
 * Returns an unsubscribe function.
 *
 * Usage:
 *   const unsub = onAuthChange((event, session) => { ... });
 *   // later: unsub();
 */
export function onAuthChange(callback) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange(callback);
  return () => subscription.unsubscribe();
}
