// app/auth.js
// Single-page auth flow for Son of Wisdom
// - Sign in
// - Sign up via email link
// - Password set/reset after email link (handled on finish-signup.html)

import { supabase } from './supabase.js';

const $ = (sel) => document.querySelector(sel);

// ---- Config: where should Supabase send people back? ----
const DEV_FALLBACK_ORIGIN = 'http://127.0.0.1:5500';

function getAuthOrigin() {
  const origin = window.location.origin;
  if (origin && origin.startsWith('http')) return origin;
  return DEV_FALLBACK_ORIGIN;
}

// Shared DOM
const statusEl    = $('#status');
const titleEl     = $('#auth-card-title');
const subEl       = $('#auth-card-sub');
const viewSignin  = $('#view-signin');
const viewSignup  = $('#view-signup-email');
const viewSetPw   = $('#view-set-password');

// Sign-in view
const signinEmailEl = $('#signin-email');
const signinPassEl  = $('#signin-password');
const btnSignIn     = $('#btn-signin');
const linkSignup    = $('#link-signup');
const linkForgot    = $('#link-forgot');
const togglePassword = document.getElementById('toggle-password');

// Sign-up email view
const signupEmailEl   = $('#signup-email');
const btnSignupEmail  = $('#btn-signup-email');
const linkBackSignin  = $('#link-back-signin');

// Set-password view (no longer used for email links, but kept harmlessly)
const setpwEmailLine   = $('#setpw-email-line');
const setpwEmailSpan   = $('#user-email');
const setpwForm        = $('#set-password-form');
const setpwPassEl      = $('#sp-password');
const setpwPassConfEl  = $('#sp-password-confirm');
const btnSetPassword   = $('#btn-set-password');
const setpwSigninLink  = $('#setpw-signin-link');

// ---------- helpers ----------
function setStatus(message, kind = 'info') {
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.style.display = message ? 'block' : 'none';
  statusEl.dataset.kind = kind;
}

function getRedirectTarget() {
  const params = new URLSearchParams(window.location.search);
  const redirect = params.get('redirect');
  return redirect || 'home.html';
}

function showView(mode) {
  if (!viewSignin || !viewSignup || !viewSetPw) return;

  viewSignin.style.display = mode === 'signin' ? 'block' : 'none';
  viewSignup.style.display = mode === 'signup' ? 'block' : 'none';
  viewSetPw.style.display  = mode === 'set-password' ? 'block' : 'none';

  if (!titleEl || !subEl) return;

  if (mode === 'signup') {
    titleEl.textContent = 'Create your account';
    subEl.textContent =
      'Step 1: enter the email where you want your Son of Wisdom account.';
  } else if (mode === 'set-password') {
    titleEl.textContent = 'Set your password';
    subEl.textContent =
      'Your email link is confirmed. Choose a password for your account.';
  } else {
    titleEl.textContent = 'Sign in';
    subEl.textContent = 'Sign in to continue where you left off.';
  }

  if (mode !== 'set-password') {
    setStatus('');
  }
}

// ---------- bootstrap from URL ----------
const params = new URLSearchParams(window.location.search);
let mode = params.get('mode') || 'signin';
if (!['signin', 'signup', 'set-password'].includes(mode)) {
  mode = 'signin';
}

(function bootstrapFromUrl() {
  const emailParam      = params.get('email');
  const passwordSetFlag = params.get('password_set');

  if (emailParam && signinEmailEl && !signinEmailEl.value) {
    signinEmailEl.value = emailParam;
  }

  if (passwordSetFlag === '1') {
    setStatus(
      'Your account is ready. Please sign in with your email and password.',
      'info'
    );
  }
})();

showView(mode);

// ---------- sign in ----------
async function handleSignIn() {
  const email = (signinEmailEl?.value || '').trim();
  const password = (signinPassEl?.value || '').trim();

  if (!email || !password) {
    setStatus('Please enter both email and password.', 'error');
    return;
  }

  btnSignIn && (btnSignIn.disabled = true);
  setStatus('Signing you in…', 'info');

  try {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      console.error('[auth] signIn error', error);
      setStatus(error.message || 'Incorrect email or password.', 'error');
      btnSignIn && (btnSignIn.disabled = false);
      return;
    }

    const dest = getRedirectTarget();
    window.location.href = dest;
  } catch (err) {
    console.error('[auth] unexpected sign-in error', err);
    setStatus('Something went wrong signing you in.', 'error');
    btnSignIn && (btnSignIn.disabled = false);
  }
}

btnSignIn?.addEventListener('click', (e) => {
  e.preventDefault();
  handleSignIn();
});

signinEmailEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    signinPassEl?.focus();
  }
});

signinPassEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    handleSignIn();
  }
});

// ---------- switch to signup view ----------
linkSignup?.addEventListener('click', (e) => {
  e.preventDefault();
  const existing = (signinEmailEl?.value || '').trim();
  if (existing && signupEmailEl && !signupEmailEl.value) {
    signupEmailEl.value = existing;
  }
  mode = 'signup';
  showView(mode);
});

linkBackSignin?.addEventListener('click', (e) => {
  e.preventDefault();
  const email = (signupEmailEl?.value || '').trim();
  if (email && signinEmailEl) signinEmailEl.value = email;
  mode = 'signin';
  showView(mode);
});

// ---------- sign up: send confirmation email ----------
btnSignupEmail?.addEventListener('click', async () => {
  const email = (signupEmailEl?.value || '').trim();
  if (!email) {
    setStatus('Please enter the email where you want your account.', 'error');
    signupEmailEl?.focus();
    return;
  }

  btnSignupEmail.disabled = true;
  setStatus('Sending confirmation link…', 'info');

  try {
    const origin = getAuthOrigin();
    // NEW: send them to finish-signup.html, not auth.html
    const redirectUrl = new URL('finish-signup.html', origin);
    redirectUrl.searchParams.set('from', 'signup');

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: redirectUrl.toString(),
      },
    });

    if (error) {
      console.error('[auth] signInWithOtp error', error);
      setStatus(error.message || 'Could not send confirmation email.', 'error');
      btnSignupEmail.disabled = false;
      return;
    }

    setStatus(
      `Check ${email} for a confirmation email with your sign-up link.`,
      'info'
    );
  } catch (err) {
    console.error('[auth] unexpected signup error', err);
    setStatus('Something went wrong sending the email.', 'error');
    btnSignupEmail.disabled = false;
  }
});

// ---------- forgot password: send reset email ----------
linkForgot?.addEventListener('click', async (e) => {
  e.preventDefault();
  const email = (signinEmailEl?.value || '').trim();
  if (!email) {
    setStatus(
      'Enter your email first, then click "Forgot password?".',
      'error'
    );
    signinEmailEl?.focus();
    return;
  }

  setStatus('Sending password reset link…', 'info');

  try {
    const origin = getAuthOrigin();
    // NEW: send them to finish-signup.html (recovery mode)
    const redirectUrl = new URL('finish-signup.html', origin);
    redirectUrl.searchParams.set('from', 'recovery');

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: redirectUrl.toString(),
    });

    if (error) {
      console.error('[auth] resetPasswordForEmail error', error);
      setStatus(
        error.message || 'Could not send password reset email.',
        'error'
      );
      return;
    }

    setStatus(
      'If an account exists for that email, we\'ve sent a reset link.',
      'info'
    );
  } catch (err) {
    console.error('[auth] unexpected forgot-password error', err);
    setStatus('Something went wrong sending the reset link.', 'error');
  }
});

// ---------- set-password view (legacy; safe to keep but not used now) ----------
function setCopyFromContext() {
  const from = params.get('from') || 'signup';
  if (!titleEl || !subEl) return;

  if (from === 'recovery') {
    titleEl.textContent = 'Reset your password';
    subEl.textContent =
      'You opened a password reset link. Choose a new password for your account.';
  } else {
    titleEl.textContent = 'Create your password';
    subEl.textContent =
      'Your email is confirmed. Now choose a password for your Son of Wisdom account.';
  }
}

async function initSetPasswordIfNeeded() {
  if (mode !== 'set-password') return;
  showView('set-password');
  setCopyFromContext();
  setStatus('Checking your link…', 'info');

  const { data, error } = await supabase.auth.getUser();

  if (error || !data?.user) {
    console.warn('[auth] no user for this link', error);
    setStatus(
      'This link is invalid or has expired. Please request a new one from the app.',
      'error'
    );
    if (btnSetPassword) btnSetPassword.disabled = true;
    if (setpwForm) setpwForm.style.opacity = '0.6';
    if (setpwSigninLink) setpwSigninLink.style.display = 'block';
    return;
  }

  const email = data.user.email;
  if (email && setpwEmailSpan) {
    setpwEmailSpan.textContent = email;
    if (setpwEmailLine) setpwEmailLine.style.display = 'block';
  }

  setStatus('', 'info');
}

setpwForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pwd = (setpwPassEl?.value || '').trim();
  const confirm = (setpwPassConfEl?.value || '').trim();

  if (!pwd || !confirm) {
    setStatus('Please enter your new password twice.', 'error');
    return;
  }
  if (pwd.length < 8) {
    setStatus('Password must be at least 8 characters long.', 'error');
    return;
  }
  if (pwd !== confirm) {
    setStatus('Passwords do not match.', 'error');
    return;
  }

  if (btnSetPassword) btnSetPassword.disabled = true;
  setStatus('Saving your password…', 'info');

  try {
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      setStatus(
        'Your session is no longer valid. Please open the email link again.',
        'error'
      );
      if (btnSetPassword) btnSetPassword.disabled = false;
      if (setpwSigninLink) setpwSigninLink.style.display = 'block';
      return;
    }

    const email = userData.user.email;

    const { error } = await supabase.auth.updateUser({ password: pwd });
    if (error) {
      console.error('[auth] updateUser error', error);
      setStatus(error.message || 'Could not update password.', 'error');
      if (btnSetPassword) btnSetPassword.disabled = false;
      return;
    }

    setStatus('Password saved. Redirecting you to sign in…', 'info');

    await supabase.auth.signOut();

    const origin = getAuthOrigin();
    const dest = new URL('auth.html', origin);
    dest.searchParams.set('mode', 'signin');
    if (email) dest.searchParams.set('email', email);
    dest.searchParams.set('password_set', '1');
    window.location.href = dest.toString();
  } catch (err) {
    console.error('[auth] unexpected set-password error', err);
    setStatus('Unexpected error updating password.', 'error');
    if (btnSetPassword) btnSetPassword.disabled = false;
  }
});

// init if we arrived via email link (legacy mode)
initSetPasswordIfNeeded().catch((err) => {
  console.error('[auth] init set-password error', err);
  setStatus('Something went wrong loading this page.', 'error');
});

// ---------- toggle password visibility on sign-in ----------
togglePassword?.addEventListener('click', () => {
  if (!signinPassEl) return;
  const isHidden = signinPassEl.type === 'password';
  signinPassEl.type = isHidden ? 'text' : 'password';
  togglePassword.textContent = isHidden ? '🙈' : '👁️';
});

console.log('[auth] ready');
