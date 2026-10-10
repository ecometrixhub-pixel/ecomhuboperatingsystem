// App shell: boot, role-based navigation, hash router.
import { supabase } from './supabase.js';
import { state, computePerms, can, canAny } from './state.js';
import { q } from './data.js';
import { setTimezone } from './time.js';
import { startTracking, endTracking } from './tracker.js';
import { refreshTimer, mountTimerPill } from './timer.js';
import { esc, icon, avatar, fullName, closeDrawer, ROLE_ICONS, toast } from './ui.js';

const ADMIN_NAV = [
  { route: 'dashboard', label: 'Dashboard', icon: 'dashboard', page: 'admin-dashboard' },
  { route: 'team', label: 'Team', icon: 'users', page: 'team' },
  { route: 'permissions', label: 'Permissions', icon: 'shield', page: 'permissions', owner: true },
  { route: 'tasks', label: 'Tasks', icon: 'tasks', page: 'tasks' },
  { route: 'leads', label: 'Leads', icon: 'target', page: 'leads' },
  { route: 'clients', label: 'Clients', icon: 'briefcase', page: 'clients' },
  { route: 'finance', label: 'Finance', icon: 'wallet', page: 'finance' },
  { route: 'tracking', label: 'Work tracking', icon: 'chart', page: 'tracking' },
  { route: 'logins', label: 'Login history', icon: 'login', page: 'logins' },
  { route: 'logs', label: 'Activity logs', icon: 'activity', page: 'logs' },
  { route: 'settings', label: 'Settings', icon: 'settings', page: 'settings', owner: true },
];
// Extra items a manager (non-admin) gets for their own work
const MANAGER_SELF = [
  { route: 'my-tasks', label: 'My tasks', icon: 'tasks', page: 'my-tasks' },
  { route: 'my-time', label: 'My work time', icon: 'clock', page: 'tracking' },
  { route: 'profile', label: 'Profile', icon: 'user', page: 'profile' },
];
function memberNav() {
  return [
    { route: 'home', label: 'Dashboard', icon: 'home', page: 'member-home' },
    { route: 'my-tasks', label: 'My tasks', icon: 'tasks', page: 'my-tasks' },
    can('leads') && { route: 'leads', label: 'Leads', icon: 'target', page: 'leads' },
    (canAny('clients') || state.agentOf?.length) && { route: 'clients', label: state.perms.clients?.view ? 'Clients' : 'My clients', icon: 'briefcase', page: 'clients' },
    can('finance') && { route: 'finance', label: 'Finance', icon: 'wallet', page: 'finance' },
    { route: 'my-time', label: 'My work time', icon: 'clock', page: 'tracking' },
    { route: 'my-activity', label: 'My activity', icon: 'activity', page: 'my-activity' },
    { route: 'profile', label: 'Profile', icon: 'user', page: 'profile' },
  ].filter(Boolean);
}

let signingOut = false;
let cleanup = null;

async function boot() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return location.replace('/login.html');
  state.user = session.user;

  const [profile, roles, settings, permRows, agentOf] = await Promise.all([
    q(supabase.from('profiles').select('*, member_roles(role_key)').eq('id', session.user.id).maybeSingle()),
    q(supabase.from('team_roles').select('*').order('sort')),
    q(supabase.from('app_settings').select('*').eq('id', 1).maybeSingle()),
    q(supabase.from('role_permissions').select('*')).catch(() => []),
    q(supabase.from('client_members').select('client_id').eq('member_id', session.user.id)).catch(() => []),
  ]);
  if (!profile) { await supabase.auth.signOut(); return location.replace('/login.html?msg=inactive'); }
  if (['inactive', 'suspended'].includes(profile.status)) { await supabase.auth.signOut(); return location.replace('/login.html?msg=inactive'); }

  state.profile = profile;
  state.myRoles = (profile.member_roles || []).map((r) => r.role_key).sort((a, b) => roles.findIndex((x) => x.key === a) - roles.findIndex((x) => x.key === b));
  state.roles = roles;
  state.settings = settings || { timezone: 'Asia/Karachi', idle_minutes: 5, company_name: 'Ecometrix Hub' };
  state.isOwner = profile.role === 'admin';
  state.isAdmin = state.isOwner || state.myRoles.includes('manager');
  state.permRows = permRows || [];
  state.agentOf = (agentOf || []).map((r) => r.client_id);
  computePerms();
  setTimezone(state.settings.timezone);

  let fresh = false;
  try { fresh = sessionStorage.getItem('ehos.fresh') === '1'; sessionStorage.removeItem('ehos.fresh'); } catch { /* ignore */ }
  await startTracking({ userId: profile.id, idleMinutes: state.settings.idle_minutes, via: fresh ? 'login' : 'resume' });
  if (profile.status === 'invited') state.profile.status = 'active';

  renderShell();
  await refreshTimer();
  window.addEventListener('hashchange', route);
  route();

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && !signingOut) location.replace('/login.html?msg=expired');
  });
  window.addEventListener('ehos:account-inactive', async () => {
    signingOut = true;
    await supabase.auth.signOut();
    location.replace('/login.html?msg=inactive');
  });
  // keep the timer pill honest if the server paused it (e.g. after a long sleep)
  setInterval(refreshTimer, 60_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshTimer(); });
}

function navItems() {
  if (!state.isAdmin) return memberNav();
  const items = ADMIN_NAV.filter((n) => !n.owner || state.isOwner);
  return state.isOwner ? items.concat([{ route: 'profile', label: 'Profile', icon: 'user', page: 'profile', hidden: true }]) : items.concat(MANAGER_SELF);
}

function renderShell() {
  const p = state.profile;
  const nav = navItems();
  const roleLinks = !state.isOwner && state.myRoles.length ? `
    <div class="nav-title">My roles</div>
    ${state.myRoles.map((key) => {
      const r = state.roles.find((x) => x.key === key);
      return `<a href="#/role/${esc(key)}" data-route="role/${esc(key)}" title="${esc(r?.name || key)}">${icon(ROLE_ICONS[key] || 'briefcase')}<span style="flex:1">${esc(r?.name || key)}</span><span class="role-dot" data-role="${esc(key)}"></span></a>`;
    }).join('')}` : '';

  document.getElementById('app').innerHTML = `
    <div class="shell">
      <aside class="sidebar" aria-label="Main navigation">
        <div class="brand">
          <div class="brand-mark">EH</div>
          <div class="brand-name">EcomHub OS<small>${esc(state.settings.company_name || 'Ecometrix Hub')}</small></div>
        </div>
        <nav class="nav">
          ${nav.filter((n) => !n.hidden).map((n) => `${n.route === 'my-tasks' && state.isAdmin ? '<div class="nav-title">My work</div>' : ''}<a href="#/${n.route}" data-route="${n.route}" title="${n.label}">${icon(n.icon)}<span>${n.label}</span></a>`).join('')}
          ${roleLinks}
        </nav>
        <div class="sidebar-foot">
          <p class="tracking-note">${icon('shield', 13)}<span>Sign-ins, active time and task timers are recorded. ${state.isOwner ? '' : '<a href="#/my-activity">See your records</a>'}</span></p>
          <div class="me">
            <div class="who">${avatar(p)}<div><div class="name">${esc(fullName(p))}</div><div class="sub">${state.isOwner ? 'Admin' : state.isAdmin ? 'Manager' : esc(p.job_title || 'Team member')}</div></div></div>
            <button class="btn btn-ghost btn-icon btn-sm" id="signout" title="Sign out" aria-label="Sign out">${icon('logout')}</button>
          </div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <button class="btn btn-ghost btn-icon menu-btn" id="menu" aria-label="Open menu">${icon('menu', 18)}</button>
          <button class="btn btn-ghost btn-icon collapse-btn" id="collapse" aria-label="Collapse sidebar" title="Collapse sidebar">${icon('sidebar', 18)}</button>
          <div class="page-title" id="page-title"></div>
          <div class="spacer"></div>
          <div id="timer-slot"></div>
          <div id="bell-slot"></div>
          <div class="pmenu-wrap">
            <button class="pmenu-btn" id="pmenu" aria-haspopup="true" aria-expanded="false" aria-label="Your account">${avatar(p)}</button>
          </div>
        </header>
        <main class="content" id="content"></main>
      </div>
    </div>`;

  const shell = document.querySelector('.shell');
  document.getElementById('menu').onclick = () => shell.classList.toggle('nav-open');
  shell.addEventListener('click', (e) => {
    if (shell.classList.contains('nav-open') && (e.target.closest('.nav a') || e.target === shell)) shell.classList.remove('nav-open');
  });
  document.getElementById('signout').onclick = signOut;

  // Collapse / expand the sidebar (desktop), remembered per browser
  const setCollapsed = (on) => {
    shell.classList.toggle('collapsed', on);
    const b = document.getElementById('collapse');
    b.setAttribute('aria-label', on ? 'Expand sidebar' : 'Collapse sidebar'); b.title = b.getAttribute('aria-label');
    try { localStorage.setItem('ehos.sidebar', on ? 'collapsed' : 'open'); } catch { /* ignore */ }
  };
  let startCollapsed = false;
  try { startCollapsed = localStorage.getItem('ehos.sidebar') === 'collapsed'; } catch { /* ignore */ }
  setCollapsed(startCollapsed);
  document.getElementById('collapse').onclick = () => setCollapsed(!shell.classList.contains('collapsed'));

  // Account menu (top right)
  const pbtn = document.getElementById('pmenu');
  let pmenu = null;
  const closeMenu = () => { pmenu?.remove(); pmenu = null; pbtn.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outsideMenu, true); };
  const outsideMenu = (e) => { if (pmenu && !pmenu.contains(e.target) && !pbtn.contains(e.target)) closeMenu(); };
  pbtn.onclick = () => {
    if (pmenu) return closeMenu();
    pmenu = document.createElement('div');
    pmenu.className = 'pmenu';
    pmenu.setAttribute('role', 'menu');
    pmenu.innerHTML = `
      <div class="pmenu-head">${avatar(p, 'lg')}<div style="min-width:0"><div class="name">${esc(fullName(p))}</div><div class="sub">${esc(p.email)}</div>
        <div class="sub">${state.isOwner ? 'Admin' : state.isAdmin ? 'Manager' : esc(p.job_title || 'Team member')}</div></div></div>
      <a role="menuitem" href="#/profile">${icon('user', 16)}Edit profile</a>
      ${state.isOwner ? `<a role="menuitem" href="#/settings">${icon('settings', 16)}Settings</a><a role="menuitem" href="#/permissions">${icon('shield', 16)}Permissions</a>` : `<a role="menuitem" href="#/profile">${icon('settings', 16)}Settings &amp; password</a>`}
      ${state.isOwner ? '' : `<a role="menuitem" href="#/my-activity">${icon('activity', 16)}My activity</a>`}
      <div class="pmenu-sep"></div>
      <button role="menuitem" class="danger" data-signout>${icon('logout', 16)}Sign out</button>`;
    document.body.append(pmenu);
    pbtn.setAttribute('aria-expanded', 'true');
    pmenu.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMenu));
    pmenu.querySelector('[data-signout]').onclick = () => { closeMenu(); signOut(); };
    setTimeout(() => document.addEventListener('click', outsideMenu, true), 0);
  };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pmenu) closeMenu(); });

  import('./notify.js').then((m) => m.mountBell(document.getElementById('bell-slot')));
  mountTimerPill(document.getElementById('timer-slot'), async (taskId) => {
    const { openTaskDrawer } = await import('./task-drawer.js');
    openTaskDrawer(taskId);
  });
}

async function signOut() {
  signingOut = true;
  const btn = document.getElementById('signout');
  if (btn) btn.disabled = true;
  await endTracking();
  await supabase.auth.signOut();
  location.replace('/login.html?msg=signedout');
}

async function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const nav = navItems();
  let item = nav.find((n) => n.route === path);
  let arg = null;

  if (!item && !state.isOwner && path.startsWith('role/')) {
    arg = path.slice(5);
    if (state.myRoles.includes(arg)) item = { route: path, page: 'my-tasks', label: state.roles.find((r) => r.key === arg)?.name };
  }
  if (!item) { location.replace(`#/${nav[0].route}`); return; }

  document.querySelectorAll('.nav a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.route === item.route));
  document.querySelectorAll('.nav a[aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'));
  closeDrawer();
  if (typeof cleanup === 'function') { try { cleanup(); } catch { /* ignore */ } }
  cleanup = null;

  const el = document.getElementById('content');
  const title = document.getElementById('page-title');
  title.textContent = item.label || '';
  el.innerHTML = '';
  window.scrollTo(0, 0);
  try {
    const mod = await import(`./pages/${item.page}.js`);
    cleanup = await mod.render({ el, params, arg, route: item.route, setTitle: (t) => { title.textContent = t; } });
  } catch (e) {
    console.error(e);
    el.innerHTML = `<div class="panel"><div class="empty"><h3>This page didn't load</h3><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div></div>`;
  }
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app').innerHTML = `<div class="fatal"><h1>EcomHub OS couldn't start</h1><p>${esc(e.message)}</p><p style="margin-top:16px"><a href="/login.html">Back to sign in</a></p></div>`;
  if (/session|JWT/i.test(e.message)) toast(e.message, 'error');
});
