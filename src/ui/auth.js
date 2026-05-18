/**
 * src/ui/auth.js
 *
 * Login / signup screen. Two modes (Sign in / Sign up), toggled by
 * tabs. Calls session helpers from src/auth/session.js to perform
 * auth actions.
 *
 * State flow:
 *   - User picks Sign in or Sign up
 *   - Enters email + password
 *   - Submits
 *   - On success: clears form, shows confirmation (signup) or sets
 *     session (signin); app state change is observed by app.js via
 *     onAuthChange (wired in sub-step 4c)
 *   - On error: shows the error message below the form
 *
 * This file does NOT decide when the auth view is shown. That's the
 * job of app.js / tabs.js in sub-step 4c. For now the auth view is
 * a normal view that other code can switch to.
 */

import { signIn, signUp } from '../auth/session.js';

let mode = 'signin'; // 'signin' | 'signup'

export function renderAuth() {
  // Update tab states
  document.querySelectorAll('[data-auth-tab]').forEach(t => {
    t.classList.toggle('active', t.dataset.authTab === mode);
  });

  // Update button label and form state
  const submitBtn = document.getElementById('authSubmit');
  if (submitBtn) {
    submitBtn.textContent = mode === 'signin' ? 'Sign in' : 'Sign up';
  }

  // Clear any previous error/success messages on tab switch
  setAuthMessage('', null);
}

function setAuthMessage(text, type) {
  // type: 'error' | 'success' | null
  const el = document.getElementById('authMessage');
  if (!el) return;
  el.textContent = text;
  el.className = 'auth-message';
  if (type) el.classList.add('auth-message-' + type);
  el.style.display = text ? 'block' : 'none';
}

async function handleSubmit(ev) {
  ev.preventDefault();
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;

  if (!email || !password) {
    setAuthMessage('Email and password required', 'error');
    return;
  }
  if (password.length < 6) {
    setAuthMessage('Password must be at least 6 characters', 'error');
    return;
  }

  const submitBtn = document.getElementById('authSubmit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Working...';

  try {
    if (mode === 'signup') {
      const { data, error } = await signUp(email, password);
      if (error) {
        setAuthMessage(error.message, 'error');
      } else {
        setAuthMessage(
          'Check your email (' + email + ') for a verification link. '
          + 'After clicking the link, return here and sign in.',
          'success'
        );
        document.getElementById('authPassword').value = '';
      }
    } else {
      const { data, error } = await signIn(email, password);
      if (error) {
        setAuthMessage(error.message, 'error');
      } else {
        setAuthMessage('Signed in successfully', 'success');
        // Note: in 4c, onAuthChange will trigger the app to re-render
        // and show the timesheet view automatically.
      }
    }
  } catch (e) {
    setAuthMessage('Unexpected error: ' + e.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = mode === 'signin' ? 'Sign in' : 'Sign up';
  }
}

export function wireAuth() {
  // Tab switching
  document.querySelectorAll('[data-auth-tab]').forEach(t => {
    t.onclick = () => {
      mode = t.dataset.authTab;
      renderAuth();
    };
  });

  // Form submission
  const form = document.getElementById('authForm');
  if (form) form.onsubmit = handleSubmit;
}
