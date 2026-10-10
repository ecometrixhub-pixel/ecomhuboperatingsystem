// Sign in, forgot password, and set password (invite / reset links)
import { supabase } from './supabase.js';
import { icon, esc } from './ui.js';
import { forgetSessions } from './tracker.js';

const page = document.body.dataset.page;
const $ = (id) => document.getElementById(id);

const TRACKING_NOTE = `${icon('shield', 14)}<span>EcomHub OS records your sign-in times, whether you're active or idle in the app, and the time you log on tasks. It never records what you type or anything outside this tab. You can see your own records anytime.</span>`;
$('tracking-note').innerHTML = TRACKING_NOTE;

function show(kind, text) {
  const el = $('msg');
  el.className = kind === 'error' ? 'form-error' : 'form-ok';
  el.textContent = text;
}
function hideMsg() { $('msg').className = 'hidden'; }

async function withButton(btn, label, fn) {
  const original = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = `<span class="spin"></span>${esc(label)}`;
  try { await fn(); } finally { btn.disabled = false; btn.innerHTML = original; }
}

function goToApp() {
  try { sessionStorage.setItem('ehos.fresh', '1'); } catch { /* ignore */ }
  forgetSessions();
  location.replace('/app.html');
}

// ---------------- Sign in ----------------
if (page === 'login') {
  const { data: { session } } = await supabase.auth.getSession();
  const params = new URLSearchParams(location.search);
  const notices = {
    expired: ['error', 'Your session expired. Sign in again.'],
    inactive: ['error', 'Your account is not active. Contact the admin.'],
    signedout: ['ok', 'You signed out.'],
    reset: ['ok', 'Password updated. Sign in with your new password.'],
  };
  if (notices[params.get('msg')]) show(...notices[params.get('msg')]);
  else if (session) location.replace('/app.html');

  const pw = $('password');
  const toggle = $('toggle-pw');
  const setToggle = () => { toggle.innerHTML = icon(pw.type === 'password' ? 'eye' : 'eyeOff'); toggle.setAttribute('aria-label', pw.type === 'password' ? 'Show password' : 'Hide password'); };
  setToggle();
  toggle.onclick = () => { pw.type = pw.type === 'password' ? 'text' : 'password'; setToggle(); pw.focus(); };

  // Passwords are reset by the admin (Team → member → Password reset link), not by email
  $('to-reset').onclick = () => show('ok', 'Forgot your password? Ask your admin for a new password link. They can send it to you on WhatsApp.');

  $('login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    hideMsg();
    const email = $('email').value.trim().toLowerCase();
    const password = pw.value;
    if (!email || !password) return show('error', 'Enter your email and password.');
    withButton(e.submitter || e.target.querySelector('[type=submit]'), 'Signing in…', async () => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        const m = /invalid login/i.test(error.message) ? 'Email or password is incorrect.'
          : /banned|ban/i.test(error.message) ? 'Your account is not active. Contact the admin.'
          : /not confirmed/i.test(error.message) ? 'Open the invite link from your admin first to set your password.'
          : error.message;
        return show('error', m);
      }
      const { data: profile } = await supabase.from('profiles').select('status').eq('id', data.user.id).maybeSingle();
      if (!profile) { await supabase.auth.signOut(); return show('error', 'This account has no EcomHub OS profile. Ask the admin to add you.'); }
      if (['inactive', 'suspended'].includes(profile.status)) { await supabase.auth.signOut(); return show('error', 'Your account is not active. Contact the admin.'); }
      goToApp();
    });
  });

}

// ---------------- Set password (invite or reset link) ----------------
// New links: /set-password.html?token_hash=…&type=invite|recovery — the token is used only when the person
// presses Continue, so link previews (WhatsApp, email scanners) can't use it up first.
// Old links (#access_token=… from Supabase) still work.
if (page === 'set-password') {
  const hash = new URLSearchParams((window.__authHash || '').replace(/^#/, ''));
  const query = new URLSearchParams(window.__authQuery || '');
  const linkError = hash.get('error_description') || query.get('error_description');
  const tokenHash = query.get('token_hash');
  const type = query.get('type') || hash.get('type') || '';
  if (type === 'recovery') $('sp-title').textContent = 'Choose a new password';

  const expired = (msg) => {
    $('sp-sub').textContent = '';
    show('error', msg && !/expired|invalid/i.test(msg) ? msg : 'This link has expired or was already used. Ask your admin for a new link.');
    if (!document.getElementById('to-signin')) $('msg').insertAdjacentHTML('afterend', '<a class="btn btn-block" id="to-signin" href="/login.html">Go to sign in</a>');
  };
  const showForm = (email) => {
    hideMsg();
    $('sp-sub').textContent = `Signed in as ${email}. Choose a password you'll use to sign in.`;
    $('sp-form').classList.remove('hidden');
    $('pw1').focus();
  };

  $('sp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    hideMsg();
    const a = $('pw1').value; const b = $('pw2').value;
    if (a.length < 8) return show('error', 'Use at least 8 characters.');
    if (a !== b) return show('error', 'The two passwords don\'t match.');
    withButton(e.target.querySelector('[type=submit]'), 'Saving…', async () => {
      const { error } = await supabase.auth.updateUser({ password: a });
      if (error) return show('error', /same/i.test(error.message) ? 'Pick a password different from your old one.' : error.message);
      goToApp();
    });
  });

  if (linkError) {
    expired(linkError);
  } else if (tokenHash) {
    // Someone else may be signed in on this browser (e.g. the admin testing the link): never change their password
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    $('sp-sub').textContent = type === 'recovery' ? 'Press Continue to choose a new password.' : 'Welcome! Press Continue to set your password.';
    $('sp-sub').insertAdjacentHTML('afterend', '<button class="btn btn-primary btn-lg btn-block" id="sp-go" type="button" style="margin-top:14px">Continue</button>');
    const go = $('sp-go');
    go.onclick = () => withButton(go, 'Checking…', async () => {
      const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type === 'invite' ? 'invite' : 'recovery' });
      if (error || !data?.session) return expired(error?.message);
      go.remove();
      try { history.replaceState(null, '', '/set-password.html'); } catch { /* ignore */ }
      showForm(data.session.user.email);
    });
  } else {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) expired('Open this page from the link your admin shared with you. If the link is old, ask for a new one.');
    else showForm(session.user.email);
  }
}
