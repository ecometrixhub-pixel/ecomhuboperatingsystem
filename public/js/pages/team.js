import { state, roleName } from '../state.js';
import { q, rpc, api, loadMembers } from '../data.js';
import {
  esc, icon, avatar, fullName, memberBadge, roleChip, presenceTag, emptyState, loadingBlock, on,
  openDrawer, closeDrawer, openModal, confirmDialog, toast, busy, copyText,
} from '../ui.js';
import { fmtDate, fmtDateOfIso, fmtDuration, fmtRelative, todayStr, startOfWeek } from '../time.js';
import { invalidateMembers } from '../task-drawer.js';
import { DEPARTMENTS, DESIGNATIONS, FOUNDERS, FOUNDER_TITLE } from '../team-config.js';
const isFounderTitle = (t) => /^co-founder/i.test(t || '');

export async function render({ el, params }) {
  let members = [];
  let presence = new Map();
  let roleFilter = params.get('role') || 'all';
  let statusFilter = 'current';
  let search = '';

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Team</h1><p>Add people, give them one or more roles, and manage their access.</p></div>
      <div class="actions"><button class="btn btn-primary" id="add">${icon('plus', 15)}Add team member</button></div>
    </div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Filter by role" id="roles"></div>
    </div>
    <div class="toolbar">
      <div class="search grow">${icon('search', 15)}<input class="input" id="q" placeholder="Search by name, email or ID" aria-label="Search members"></div>
      <select class="select" id="status" style="width:auto" aria-label="Status">
        <option value="current">Active and invited</option><option value="all">All statuses</option>
        <option value="active">Active</option><option value="invited">Invited</option><option value="inactive">Inactive</option>
      </select>
    </div>
    <div id="founders"></div>
    <section class="panel"><div class="table-wrap" id="table">${loadingBlock(5)}</div></section>`;

  const table = el.querySelector('#table');

  function renderRoles() {
    const current = members.filter((m) => !['inactive', 'suspended'].includes(m.status));
    el.querySelector('#roles').innerHTML = [
      `<button data-r="all" aria-pressed="${roleFilter === 'all'}">All<span class="count">${current.length}</span></button>`,
      ...state.roles.map((r) => `<button data-r="${esc(r.key)}" aria-pressed="${roleFilter === r.key}"><span class="role-dot" data-role="${esc(r.key)}" style="display:inline-block;margin-right:6px"></span>${esc(r.name)}<span class="count">${current.filter((m) => m.roles.includes(r.key)).length}</span></button>`),
    ].join('');
  }

  function renderTable() {
    const s = search.toLowerCase();
    const list = members.filter((m) => {
      if (roleFilter !== 'all' && !m.roles.includes(roleFilter)) return false;
      if (statusFilter === 'current' && ['inactive', 'suspended'].includes(m.status)) return false;
      if (!['current', 'all'].includes(statusFilter) && m.status !== statusFilter && !(statusFilter === 'inactive' && m.status === 'suspended')) return false;
      if (s && !`${fullName(m)} ${m.email} ${m.employee_code}`.toLowerCase().includes(s)) return false;
      return true;
    });
    if (!members.length) {
      table.innerHTML = emptyState('No team members yet', 'Add someone and share their invite link. They set a password and start working.', '<button class="btn btn-primary" data-add>Add team member</button>');
      return;
    }
    if (!list.length) { table.innerHTML = emptyState('No one matches these filters'); return; }
    table.innerHTML = `
      <table class="table">
        <thead><tr><th>Member</th><th>Roles</th><th>Status</th><th>Presence</th><th>Employee ID</th><th>Joined</th></tr></thead>
        <tbody>${list.map((m) => {
          const p = presence.get(m.id);
          const pr = p?.presence || 'offline';
          return `<tr class="clickable" data-id="${m.id}" tabindex="0">
            <td>${`<div class="who">${avatar(m)}<div><div class="name">${esc(fullName(m))}</div><div class="sub">${esc(m.job_title || m.email)}</div>${m.department ? `<div class="sub">${esc(m.department)}</div>` : ''}</div></div>`}</td>
            <td><div class="chips">${m.roles.map((r) => roleChip(r, state.roles)).join('') || '<span class="muted small">No role</span>'}</div></td>
            <td>${memberBadge(m.status)}</td>
            <td>${m.status === 'invited' ? '<span class="muted small">Not joined yet</span>' : presenceTag(pr, pr === 'offline' ? (p?.last_seen_at ? `Seen ${fmtRelative(p.last_seen_at)}` : 'Offline') : null)}</td>
            <td class="num muted">${esc(m.employee_code)}</td>
            <td class="muted">${esc(fmtDate(m.joined_on))}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
  }

  async function load() {
    const [m, p, everyone] = await Promise.all([loadMembers(), rpc('team_presence'), state.isOwner ? loadMembers({ includeAdmin: true }) : Promise.resolve([])]);
    drawFounders(everyone);
    members = m;
    presence = new Map(p.map((x) => [x.user_id, x]));
    renderRoles();
    renderTable();
  }

  el.querySelector('#roles').addEventListener('click', (e) => {
    const b = e.target.closest('[data-r]'); if (!b) return;
    roleFilter = b.dataset.r; renderRoles(); renderTable();
  });
  el.querySelector('#q').addEventListener('input', (e) => { search = e.target.value.trim(); renderTable(); });
  el.querySelector('#status').addEventListener('change', (e) => { statusFilter = e.target.value; renderTable(); });
  el.querySelector('#add').onclick = () => memberForm();
  const offs = [
    on(table, 'click', '[data-add]', () => memberForm()),
    on(table, 'click', 'tr[data-id]', (e, tr) => memberDrawer(tr.dataset.id)),
    on(table, 'keydown', 'tr[data-id]', (e, tr) => { if (e.key === 'Enter') memberDrawer(tr.dataset.id); }),
  ];

  const reload = async () => { invalidateMembers(); await load().catch((e) => toast(e.message, 'error')); };

  // ---------- Founding team (admin only) ----------
  const foundersBox = el.querySelector('#founders');
  function drawFounders(everyone) {
    if (!state.isOwner) return;
    const missing = FOUNDERS.filter((f) => {
      const p = everyone.find((x) => (x.email || '').toLowerCase() === f.email.toLowerCase());
      return !p || p.job_title !== FOUNDER_TITLE || p.department !== f.department || (p.role !== 'admin' && !p.roles.includes('manager'));
    });
    foundersBox.innerHTML = missing.length ? `<div class="note info" style="margin-bottom:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <span style="flex:1;min-width:220px">${icon('users', 14)} <b>Founding team:</b> ${missing.map((f) => esc(`${f.first_name} ${f.last_name}`)).join(', ')} ${missing.length === 1 ? 'isn\'t' : 'aren\'t'} set up yet. One click creates their accounts as <b>Managers</b> (Co-Founder) with their department.</span>
      <button class="btn btn-primary btn-sm" data-setup-founders>${icon('userPlus', 14)}Set up founding team</button></div>` : '';
  }
  foundersBox.addEventListener('click', (e) => {
    const b = e.target.closest('[data-setup-founders]'); if (!b) return;
    busy(b, async () => {
      try {
        const { results } = await api('/setup/founders', { method: 'POST' });
        await reload();
        const label = { created: 'Account created', invited: 'Invite renewed', updated: 'Updated to Manager', admin: 'Admin account (title and department set)', error: 'Failed' };
        const modal = openModal({
          title: 'Founding team', icon: 'users', wide: true,
          body: `<p class="muted">Send each co-founder their link. They open it, set a password and land in EcomHub OS as a Manager. Links work once.</p>
            <div class="list panel">${results.map((r) => `<div class="list-item" style="flex-wrap:wrap;padding:12px 16px">
              <div class="grow" style="min-width:180px"><div class="title">${esc(r.name)} <span class="badge ${r.status === 'error' ? 'inactive' : 'active'}">${esc(label[r.status] || r.status)}</span></div>
                <div class="meta"><span>${esc(r.email)}</span>${r.error ? `<span style="color:var(--error)">${esc(r.error)}</span>` : ''}</div></div>
              ${r.link ? `<button class="btn btn-sm" data-copy-link="${esc(r.link)}">${icon('copy', 13)}Copy link</button>
                <a class="btn btn-sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Hi ${r.name.split(' ')[0]}, your EcomHub OS account is ready. Open this link to set your password: ${r.link}`)}">${icon('send', 13)}WhatsApp</a>` : ''}
            </div>`).join('')}</div>`,
          foot: '<button class="btn btn-primary" data-done>Done</button>',
        });
        modal.querySelectorAll('[data-copy-link]').forEach((c) => c.onclick = async () => { if (await copyText(c.dataset.copyLink)) { c.innerHTML = `${icon('check', 13)}Copied`; toast('Link copied'); } });
        modal.querySelector('[data-done]').onclick = () => modal.close();
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  // ---------- Add / edit ----------
  function memberForm(member = null) {
    const m = member || { first_name: '', last_name: '', email: '', phone: '', job_title: '', department: '', joined_on: todayStr(), roles: [] };
    const modal = openModal({
      title: member ? `Edit ${esc(fullName(member))}` : 'Add team member',
      wide: true,
      body: `
        <form id="mf" class="form-grid" novalidate>
          <div class="field"><label for="mf-first">First name</label><input id="mf-first" class="input" value="${esc(m.first_name)}" maxlength="80" required></div>
          <div class="field"><label for="mf-last">Last name</label><input id="mf-last" class="input" value="${esc(m.last_name)}" maxlength="80"></div>
          <div class="field span-2"><label for="mf-email">Email</label>
            <input id="mf-email" class="input" type="email" value="${esc(m.email)}" ${member ? 'disabled' : ''} maxlength="160" required>
            ${member ? '<span class="hint">Email can\'t be changed after the invite.</span>' : '<span class="hint">They sign in with this email.</span>'}</div>
          <div class="field"><label for="mf-phone">Phone (optional)</label><input id="mf-phone" class="input" value="${esc(m.phone || '')}" maxlength="30"></div>
          <div class="field"><label for="mf-joined">Joining date</label><input id="mf-joined" type="date" class="input" value="${esc(m.joined_on || '')}"></div>
          <div class="field"><label for="mf-dept">Department</label>
            <select id="mf-dept" class="select"><option value="">Select department</option>${DEPARTMENTS.map((d) => `<option ${m.department === d.name ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}${m.department && !DEPARTMENTS.some((d) => d.name === m.department) ? `<option selected>${esc(m.department)}</option>` : ''}</select>
            <span class="hint" id="mf-dept-hint"></span></div>
          <div class="field"><label for="mf-title">Designation</label>
            ${isFounderTitle(m.job_title) ? `<input id="mf-title" class="input" value="${esc(m.job_title)}" disabled><span class="hint">Founding team. Not in the designation list.</span>` : `
            <select id="mf-title" class="select"><option value="">Select designation</option>${DESIGNATIONS.map((t) => `<option ${m.job_title === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}<option value="__other" ${m.job_title && !DESIGNATIONS.includes(m.job_title) ? 'selected' : ''}>Other</option></select>
            <input id="mf-title-other" class="input ${m.job_title && !DESIGNATIONS.includes(m.job_title) ? '' : 'hidden'}" style="margin-top:6px" maxlength="80" value="${esc(m.job_title && !DESIGNATIONS.includes(m.job_title) ? m.job_title : '')}" placeholder="Type the designation">`}</div>
          <div class="field span-2"><span class="label">Roles</span><span class="hint" style="margin-top:-2px">Pick one or more. Each role adds its own tab. <b>Manager</b> gives full access like the admin (except Settings and Permissions).</span>
            <div class="role-pick">${state.roles.map((r) => `
              <label><input type="checkbox" name="roles" value="${esc(r.key)}" ${m.roles.includes(r.key) ? 'checked' : ''}>
                <div><b><span class="role-dot" data-role="${esc(r.key)}" style="display:inline-block;margin-right:6px"></span>${esc(r.name)}</b><span>${esc(r.description)}</span></div></label>`).join('')}</div></div>
          <div class="form-error hidden span-2" id="mf-err"></div>
        </form>`,
      foot: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>${member ? 'Save changes' : 'Add and get invite link'}</button>`,
    });
    const deptSel = modal.querySelector('#mf-dept');
    const showDept = () => { modal.querySelector('#mf-dept-hint').textContent = DEPARTMENTS.find((d) => d.name === deptSel.value)?.points || ''; };
    deptSel.addEventListener('change', showDept); showDept();
    const titleSel = modal.querySelector('#mf-title');
    titleSel.tagName === 'SELECT' && titleSel.addEventListener('change', () => { const o = modal.querySelector('#mf-title-other'); o.classList.toggle('hidden', titleSel.value !== '__other'); if (titleSel.value === '__other') o.focus(); });
    const err = modal.querySelector('#mf-err');
    const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
    modal.querySelector('[data-cancel]').onclick = () => modal.close();
    const save = modal.querySelector('[data-save]');
    const submit = () => busy(save, async () => {
      err.classList.add('hidden');
      const body = {
        first_name: modal.querySelector('#mf-first').value.trim(),
        last_name: modal.querySelector('#mf-last').value.trim(),
        phone: modal.querySelector('#mf-phone').value.trim(),
        job_title: isFounderTitle(m.job_title) ? m.job_title : modal.querySelector('#mf-title').value === '__other' ? modal.querySelector('#mf-title-other').value.trim() : modal.querySelector('#mf-title').value,
        department: modal.querySelector('#mf-dept').value,
        joined_on: modal.querySelector('#mf-joined').value,
        roles: [...modal.querySelectorAll('input[name=roles]:checked')].map((x) => x.value),
      };
      if (!body.first_name) return fail('Enter a first name.');
      if (!body.roles.length) return fail('Pick at least one role.');
      try {
        if (member) {
          await api(`/members/${member.id}`, { method: 'PATCH', body });
          toast('Member updated');
          modal.close();
          await reload();
          memberDrawer(member.id);
        } else {
          body.email = modal.querySelector('#mf-email').value.trim();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return fail('Enter a valid email address.');
          const res = await api('/members', { method: 'POST', body });
          modal.close();
          await reload();
          showLink({ name: body.first_name, link: res.inviteLink, type: 'invite' });
        }
      } catch (e) { fail(e.message); }
    });
    save.onclick = submit;
    modal.querySelector('#mf').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  }

  function showLink({ name, link, type }) {
    const msg = type === 'invite'
      ? `Hi ${name}, you're invited to EcomHub OS. Open this link to set your password: ${link}`
      : `Hi ${name}, use this link to set a new EcomHub OS password: ${link}`;
    const modal = openModal({
      title: type === 'invite' ? `Invite link for ${esc(name)}` : `Password reset link for ${esc(name)}`,
      body: `
        <p class="muted">${type === 'invite'
          ? `Send this link to ${esc(name)}. It opens a page where they set a password, then they're in. The link works once.`
          : `Send this link to ${esc(name)}. It lets them choose a new password. The link works once.`}</p>
        <div class="link-box"><input class="input" readonly value="${esc(link)}" aria-label="Link"><button class="btn" data-copy>${icon('copy', 14)}Copy</button></div>
        <p class="small muted">If it expires before they use it, open their profile and get a new one.</p>`,
      foot: `<a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">${icon('send', 14)}Share on WhatsApp</a><button class="btn btn-primary" data-done>Done</button>`,
    });
    modal.querySelector('[data-copy]').onclick = async (e) => {
      if (await copyText(link)) { e.currentTarget.innerHTML = `${icon('check', 14)}Copied`; toast('Link copied'); }
    };
    modal.querySelector('[data-done]').onclick = () => modal.close();
    modal.querySelector('input').select();
  }

  // ---------- Member drawer ----------
  async function memberDrawer(id) {
    const m = members.find((x) => x.id === id);
    if (!m) return;
    const p = presence.get(id);
    const isOff = ['inactive', 'suspended'].includes(m.status);
    const drawer = openDrawer({
      title: esc(fullName(m)),
      body: `
        <div class="row" style="gap:14px">${avatar(m, 'lg')}<div>
          <div style="font-weight:600;font-size:15px">${esc(fullName(m))}</div>
          <div class="muted small">${esc(m.email)}</div>
          <div class="row" style="margin-top:6px">${memberBadge(m.status)}${m.status === 'active' ? presenceTag(p?.presence || 'offline', p?.presence === 'offline' && p?.last_seen_at ? `Seen ${fmtRelative(p.last_seen_at)}` : null) : ''}</div>
        </div></div>
        <div><div class="section-title">Roles</div><div class="chips">${m.roles.map((r) => roleChip(r, state.roles)).join('') || '<span class="muted small">No role</span>'}</div></div>
        <div><div class="section-title">This week</div><div id="wk">${loadingBlock(1)}</div></div>
        ${m.status !== 'inactive' && m.status !== 'suspended' ? `<div><div class="section-title">Projects</div><div id="mprojects">${loadingBlock(1)}</div></div>` : ''}
        <dl class="kv">
          <dt>Employee ID</dt><dd class="num">${esc(m.employee_code)}</dd>
          <dt>Phone</dt><dd>${esc(m.phone || '—')}</dd>
          <dt>Job title</dt><dd>${esc(m.job_title || '—')}</dd>
          <dt>Department</dt><dd>${esc(m.department || '—')}</dd>
          <dt>Joining date</dt><dd>${esc(fmtDate(m.joined_on))}</dd>
          <dt>Added</dt><dd>${esc(fmtDateOfIso(m.created_at))}</dd>
        </dl>
        <div><div class="section-title">Records</div>
          <div class="row wrap">
            <a class="btn btn-sm" href="#/tasks?member=${id}">${icon('tasks', 14)}Tasks</a>
            <a class="btn btn-sm" href="#/tracking?member=${id}">${icon('chart', 14)}Work tracking</a>
            <a class="btn btn-sm" href="#/logins?member=${id}">${icon('login', 14)}Login history</a>
            <a class="btn btn-sm" href="#/logs?member=${id}">${icon('activity', 14)}Activity</a>
          </div></div>
        ${!isOff ? `<div><div class="section-title">Access</div>
          <p class="small muted" style="margin-bottom:10px">${m.status === 'invited' ? 'They haven\'t set a password yet. Send a fresh invite link if the first one expired.' : 'If they forgot their password, send them a reset link.'}</p>
          <button class="btn btn-sm" data-link>${icon('link', 14)}${m.status === 'invited' ? 'Get new invite link' : 'Get password reset link'}</button></div>` : ''}`,
      foot: `<button class="btn ${isOff ? '' : 'btn-danger'}" data-status>${icon('power', 14)}${isOff ? 'Activate' : m.status === 'invited' ? 'Cancel invite' : 'Deactivate'}</button><span style="flex:1"></span><button class="btn" data-edit>${icon('edit', 14)}Edit</button><a class="btn btn-primary" href="#/tasks?new=1&member=${id}">${icon('plus', 14)}Assign task</a>`,
    });

    // weekly numbers
    const from = startOfWeek(todayStr());
    Promise.all([
      rpc('report_daily', { p_from: from, p_to: todayStr(), p_user: id }),
    ]).then(([rows]) => {
      const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
      const wk = drawer.querySelector('#wk');
      if (wk) wk.innerHTML = `<div class="stats"><div class="stat-group">
        <div class="stat"><div class="v" style="font-size:19px">${fmtDuration(sum('session_seconds'))}</div><div class="k">Signed in</div></div>
        <div class="stat"><div class="v" style="font-size:19px">${fmtDuration(sum('active_seconds'))}</div><div class="k"><i class="active"></i>Active</div></div>
        <div class="stat"><div class="v" style="font-size:19px">${fmtDuration(sum('timer_seconds'))}</div><div class="k"><i class="timer"></i>Task timer</div></div>
      </div></div>`;
    }).catch((e) => { const wk = drawer.querySelector('#wk'); if (wk) wk.innerHTML = `<p class="small muted">${esc(e.message)}</p>`; });

    // projects this member is on (and "Add to a project", which goes for approval)
    const box = drawer.querySelector('#mprojects');
    const loadProjects = async () => {
      if (!box?.isConnected) return;
      try {
        const pm = await import('./projects.js');
        box.innerHTML = await pm.memberProjectsHtml(id);
        box.querySelector('[data-add-project]').onclick = () => pm.openAddToProject({ memberId: id, memberName: fullName(m), memberTitle: m.job_title || '' });
      } catch (e) { box.innerHTML = `<p class="small muted">${esc(e.message)}</p>`; }
    };
    if (box) {
      loadProjects();
      window.addEventListener('ehos:data-changed', loadProjects);
      const obs = new MutationObserver(() => { if (!drawer.isConnected) { window.removeEventListener('ehos:data-changed', loadProjects); obs.disconnect(); } });
      obs.observe(document.body, { childList: true });
    }

    drawer.querySelector('[data-edit]').onclick = () => memberForm(m);
    drawer.querySelector('[data-link]')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      try {
        const res = await api(`/members/${id}/access-link`, { method: 'POST' });
        showLink({ name: m.first_name || fullName(m), link: res.link, type: res.type });
      } catch (err) { toast(err.message, 'error'); }
    }));
    drawer.querySelector('[data-status]').onclick = async (e) => {
      const btn = e.currentTarget;
      const next = isOff ? 'active' : 'inactive';
      const ok = await confirmDialog(isOff
        ? { title: `Activate ${fullName(m)}?`, text: 'They can sign in again and get tasks.', confirm: 'Activate' }
        : { title: `${m.status === 'invited' ? 'Cancel the invite for' : 'Deactivate'} ${fullName(m)}?`, text: 'They are signed out and can\'t sign in. Their tasks, time and history are kept.', confirm: m.status === 'invited' ? 'Cancel invite' : 'Deactivate', danger: true });
      if (!ok) return;
      await busy(btn, async () => {
        try {
          await api(`/members/${id}/status`, { method: 'POST', body: { status: next } });
          toast(isOff ? 'Member activated' : 'Member deactivated');
          closeDrawer();
          await reload();
        } catch (err) { toast(err.message, 'error'); }
      });
    };
  }

  await load().catch((e) => { table.innerHTML = `<div class="form-error" style="margin:16px">${esc(e.message)}</div>`; });
  if (params.get('add') === '1') memberForm();
  return () => offs.forEach((f) => f());
}
