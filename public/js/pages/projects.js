// Projects list (cards) + shared project helpers. The project itself opens in the workspace (pages/project.js).
// Adding people needs an approval: admin/manager adds → the PM approves; the PM adds → the admin or a manager approves.
import { supabase } from '../supabase.js';
import { state, can } from '../state.js';
import { q, rpc, loadDirectory, dirName, dirLabel } from '../data.js';
import { esc, icon, emptyState, loadingBlock, on, openModal, confirmDialog, toast, busy } from '../ui.js';
import { fmtDate, fmtDateTime, fmtRelative, todayStr } from '../time.js';
import { PROJECT_ROLES } from '../team-config.js';

export const PROJECT_STATUS = { planning: 'Planning', active: 'Active', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' };
export const FILE_KINDS = { contract: 'Contract', document: 'Document', invoice: 'Invoice PDF', other: 'Other' };
export const MEMBER_STATUS = { pending: 'Waiting for approval', approved: 'On the team', rejected: 'Not approved', cancelled: 'Cancelled', removed: 'Removed' };
export const changed = () => window.dispatchEvent(new CustomEvent('ehos:data-changed'));
export const projectBadge = (s) => `<span class="badge ${esc(s)}">${esc(PROJECT_STATUS[s] || s)}</span>`;
export const projectInitials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

const me = () => state.profile.id;
export const isPMof = (p) => p.project_manager === me();
export const canEditProject = (p) => can('projects', 'edit') || (isPMof(p) && Boolean(state.pmPerms.projects?.edit));
export const canDeleteProject = (p) => can('projects', 'delete') || (isPMof(p) && Boolean(state.pmPerms.projects?.delete));
export const canInvP = (p, a) => can('finance', a) || (isPMof(p) && Boolean(state.pmPerms.finance?.[a]));
export const canFileP = (p, a) => (a === 'view' ? true : a === 'edit' ? can('clients', 'edit') || canEditProject(p) : can('clients', 'delete') || canDeleteProject(p));
export const isOpen = (p) => !['completed', 'cancelled'].includes(p.status);

// Who has to approve a request
export const approverText = (row, project, dir) => (row.approver === 'pm'
  ? `${dirName(dir, project?.project_manager) || 'the project manager'} (project manager)`
  : 'the admin or a manager');
export const canDecide = (row, project) => row.status === 'pending' && row.requested_by !== me()
  && (row.approver === 'pm' ? project?.project_manager === me() : state.isAdmin);
export const canCancel = (row) => row.status === 'pending' && (row.requested_by === me() || state.isAdmin);
export const labelOf = (dir, id) => { const l = dirLabel(dir, id, state.roles); return l ? `${l.name}${l.title ? `, ${l.title}` : ''}` : 'Someone'; };

// What happens when the current user adds someone to this project
export function addMode(project) {
  if (state.isAdmin) {
    if (!project.project_manager || project.project_manager === me()) return { label: 'Add to project', hint: 'They join right away.' };
    return { label: 'Send to PM for approval', hint: `${'The project manager'} gets a notification and approves it.` };
  }
  return { label: 'Send for approval', hint: 'The admin or a manager approves it. Any one of them can.' };
}

// Designations people can be added as, with how many members hold each one
export function roleOptions(dir, { exclude = new Set() } = {}) {
  const pool = dir.filter((d) => d.status !== 'inactive' && !d.is_admin && !exclude.has(d.id));
  const titles = [...new Set([...PROJECT_ROLES, ...pool.map((d) => d.job_title).filter((t) => t && !PROJECT_ROLES.includes(t) && !t.startsWith('Co-Founder'))])];
  return titles.map((t) => ({ title: t, people: pool.filter((d) => d.job_title === t) }));
}

export async function decide(btn, id, approve, rows, dir) {
  const r = rows.find((x) => x.id === id);
  const who = dirName(dir, r?.member_id) || 'this member';
  const note = await confirmDialog(approve
    ? { title: `Approve ${who}?`, text: 'They join the project and get a notification.', confirm: 'Approve', note: { label: 'Note (optional)' } }
    : { title: `Reject adding ${who}?`, text: 'The person who asked is told it wasn\'t approved.', confirm: 'Reject', danger: true, note: { label: 'Reason', placeholder: 'Why not?', required: true, requiredText: 'Add a short reason.' } });
  if (note === null) return;
  await busy(btn, async () => {
    try { await rpc('project_member_decide', { p_id: id, p_approve: approve, p_note: note || null }); toast(approve ? 'Approved. They\'re on the team.' : 'Request rejected'); changed(); }
    catch (e) { toast(e.message, 'error'); }
  });
}

export async function requestAdd(project, memberId, label) {
  try {
    await rpc('project_member_request', { p_project: project.id, p_member: memberId, p_role: label });
    const direct = state.isAdmin && (!project.project_manager || project.project_manager === me());
    toast(direct ? 'Added to the project. They were notified.' : state.isAdmin ? 'Sent to the project manager for approval' : 'Sent to the admin and managers for approval');
    changed();
    return true;
  } catch (e) { toast(e.message, 'error'); return false; }
}

// Old links (#/projects?open=…) and callers land in the workspace
export function openProjectDrawer(id, tab = 'overview') { location.hash = `#/project/${id}${tab && tab !== 'overview' ? `?tab=${tab}` : ''}`; }

// ---------- Page ----------
export async function render({ el, params }) {
  if (params.get('open')) { location.replace(`#/project/${Number(params.get('open'))}${params.get('tab') ? `?tab=${encodeURIComponent(params.get('tab'))}` : ''}`); return; }
  let projects = []; let members = []; let tasks = []; let dir = [];
  let status = params.get('status') || 'open';
  let pmFilter = ''; let search = '';
  const all = can('projects');

  el.innerHTML = `
    <div class="page-head">
      <div><h1>${all ? 'Projects' : 'My projects'}</h1><p>${all ? 'Client work, who runs it, and who is on the team.' : 'Projects you run or work on. Open one to start working.'}</p></div>
      <div class="actions">${can('projects', 'edit') ? `<button class="btn btn-primary" id="new">${icon('plus', 15)}New project</button>` : ''}</div>
    </div>
    <div id="approvals"></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Status" id="status"></div></div>
    <div class="toolbar">
      <div class="search grow">${icon('search', 15)}<input class="input" id="q" placeholder="Search projects or clients" aria-label="Search projects"></div>
      ${all ? '<select class="select" id="pm" style="width:auto" aria-label="Project manager"><option value="">Any project manager</option><option value="none">No project manager</option></select>' : ''}
    </div>
    <div id="grid">${loadingBlock(4)}</div>`;
  const grid = el.querySelector('#grid');
  const appr = el.querySelector('#approvals');

  const filters = { open: (p) => isOpen(p), all: () => true, ...Object.fromEntries(Object.keys(PROJECT_STATUS).map((k) => [k, (p) => p.status === k])) };
  const labels = { open: 'Open', all: 'All', ...PROJECT_STATUS };

  function draw() {
    el.querySelector('#status').innerHTML = Object.keys(labels).map((k) =>
      `<button data-s="${k}" aria-pressed="${status === k}">${labels[k]}<span class="count">${projects.filter(filters[k]).length}</span></button>`).join('');
    const s = search.toLowerCase();
    const list = projects.filter((p) => filters[status](p)
      && (!pmFilter || (pmFilter === 'none' ? !p.project_manager : p.project_manager === pmFilter))
      && (!s || `${p.name} ${p.client?.name || ''}`.toLowerCase().includes(s)));
    if (!projects.length) {
      grid.innerHTML = `<div class="panel">${emptyState(all ? 'No projects yet' : 'No projects for you yet',
        all ? 'Open a client and press Create project, or start one here.' : 'When you\'re made project manager of a project, or added to its team, it shows up here.',
        can('projects', 'edit') ? '<button class="btn btn-primary" data-new>New project</button>' : '')}</div>`;
      return;
    }
    if (!list.length) { grid.innerHTML = `<div class="panel">${emptyState('No projects match these filters')}</div>`; return; }
    grid.innerHTML = `<div class="proj-grid">${list.map((p) => {
      const team = members.filter((m) => m.project_id === p.id && m.status === 'approved');
      const waiting = members.filter((m) => m.project_id === p.id && canDecide(m, p)).length;
      const pt = tasks.filter((t) => t.project_id === p.id); const done = pt.filter((t) => t.status === 'completed').length;
      const pct = pt.length ? Math.round((done / pt.length) * 100) : 0;
      const role = isPMof(p) ? 'You run this' : team.some((m) => m.member_id === me()) ? `You: ${esc(team.find((m) => m.member_id === me()).role_label)}` : '';
      return `<a class="proj-card" href="#/project/${p.id}">
        <div class="pc-top"><span class="pc-mark">${esc(projectInitials(p.name))}</span>
          <div class="pc-name"><b>${esc(p.name)}</b><small>${esc(p.client?.name || 'Client')}</small></div>${projectBadge(p.status)}</div>
        <div class="pc-progress"><div class="proj-progress"><i style="width:${pct}%"></i></div><span>${pt.length ? `${done}/${pt.length} tasks` : 'No tasks yet'}</span></div>
        <div class="pc-foot">
          <span class="pc-who">${icon('user', 13)}${p.project_manager ? esc(dirName(dir, p.project_manager)) : '<span class="muted">No PM yet</span>'}</span>
          <span>${icon('users', 13)}${team.length}</span>
          ${p.due_date ? `<span class="due ${p.due_date < todayStr() && isOpen(p) ? 'over' : ''}">${icon('calendar', 12)}${esc(fmtDate(p.due_date))}</span>` : ''}
        </div>
        ${role || waiting ? `<div class="pc-tags">${role ? `<span class="chip">${role}</span>` : ''}${waiting ? `<span class="badge pending">${waiting} to approve</span>` : ''}</div>` : ''}
      </a>`;
    }).join('')}</div>`;
  }

  function drawApprovals() {
    const mine = members.filter((m) => canDecide(m, projects.find((p) => p.id === m.project_id)));
    if (!mine.length) { appr.innerHTML = ''; return; }
    appr.innerHTML = `<section class="approvals" aria-label="Waiting for your approval">
      <h2>${icon('shield', 15)}Waiting for your approval (${mine.length})</h2>
      ${mine.map((r) => { const p = projects.find((x) => x.id === r.project_id); return `
        <div class="approval-row">
          <div class="grow"><div class="title">Add ${esc(dirName(dir, r.member_id) || 'a member')} to ${esc(p?.name || 'project')}</div>
            <div class="meta">As ${esc(r.role_label)}. Requested by ${esc(labelOf(dir, r.requested_by))}, ${esc(fmtRelative(r.requested_at))}</div></div>
          <button class="btn btn-sm" data-reject="${r.id}">${icon('x', 13)}Reject</button>
          <button class="btn btn-sm btn-primary" data-approve="${r.id}">${icon('check', 13)}Approve</button>
        </div>`; }).join('')}
    </section>`;
  }

  async function load() {
    [projects, members, tasks, dir] = await Promise.all([
      q(supabase.from('projects').select('*, client:clients(id, name)').order('created_at', { ascending: false })),
      q(supabase.from('project_members').select('*')),
      q(supabase.from('tasks').select('id, project_id, status').not('project_id', 'is', null)),
      loadDirectory(),
    ]);
    const sel = el.querySelector('#pm');
    if (sel && sel.options.length <= 2) {
      sel.insertAdjacentHTML('beforeend', dir.filter((d) => d.roles.includes('project_manager')).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join(''));
    }
    drawApprovals();
    draw();
  }

  el.querySelector('#status').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { status = b.dataset.s; draw(); } });
  el.querySelector('#q').addEventListener('input', (e) => { search = e.target.value.trim(); draw(); });
  el.querySelector('#pm')?.addEventListener('change', (e) => { pmFilter = e.target.value; draw(); });
  el.querySelector('#new')?.addEventListener('click', () => openProjectForm());
  const offs = [
    on(grid, 'click', '[data-new]', () => openProjectForm()),
    on(appr, 'click', '[data-approve]', (e, b) => decide(b, Number(b.dataset.approve), true, members, dir)),
    on(appr, 'click', '[data-reject]', (e, b) => decide(b, Number(b.dataset.reject), false, members, dir)),
  ];
  const safe = () => load().catch((e) => { grid.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
  await safe();
  window.addEventListener('ehos:data-changed', safe);
  return () => { offs.forEach((x) => x()); window.removeEventListener('ehos:data-changed', safe); };
}

// ---------- New project ----------
export async function openProjectForm({ clientId = null } = {}) {
  const [dir, clients] = await Promise.all([
    loadDirectory(),
    clientId ? Promise.resolve([]) : q(supabase.from('clients').select('id, name').order('name')),
  ]);
  const pms = dir.filter((d) => d.roles.includes('project_manager') && d.status !== 'inactive');
  const clientName = clientId ? (await q(supabase.from('clients').select('name, website').eq('id', clientId).maybeSingle())) : null;
  const m = openModal({
    title: 'New project',
    subtitle: clientName ? `For client ${esc(clientName.name)}` : '',
    wide: true,
    body: `
      <form id="pf" class="form-grid" novalidate>
        ${!clientId ? `<div class="field span-2"><label for="pf-client">Client</label><select id="pf-client" class="select"><option value="">Choose a client</option>${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
          ${clients.length ? '' : '<span class="hint">No clients yet. Convert a won lead or add a client first.</span>'}</div>` : ''}
        <div class="field span-2"><label for="pf-name">Project name</label><input id="pf-name" class="input" maxlength="200" value="${esc(clientName ? `${clientName.name} project` : '')}" placeholder="e.g. Shopify store build, Meta ads Q4" required></div>
        <div class="field span-2"><label for="pf-pm">Project manager</label>
          <select id="pf-pm" class="select"><option value="">Not assigned yet</option>${pms.map((d) => `<option value="${d.id}">${esc(d.name)}${d.job_title ? ` (${esc(d.job_title)})` : ''}</option>`).join('')}</select>
          <span class="hint">${pms.length ? 'They get a notification and the project shows up in their Projects tab.' : 'Give someone the Project Manager role on the Team page first.'}</span></div>
        <div class="field"><label for="pf-start">Start date</label><input id="pf-start" class="input" type="date" value="${esc(todayStr())}"></div>
        <div class="field"><label for="pf-due">Due date (optional)</label><input id="pf-due" class="input" type="date"></div>
        <div class="field span-2"><label for="pf-web">Website (optional)</label><input id="pf-web" class="input" maxlength="300" value="${esc(clientName?.website || '')}" placeholder="glowco.com"></div>
        <div class="field span-2"><label for="pf-desc">Scope / notes</label><textarea id="pf-desc" class="textarea" placeholder="What's being delivered, links, deadlines"></textarea></div>
        <div class="form-error hidden span-2" id="pf-err"></div>
      </form>`,
    foot: '<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Create project</button>',
  });
  m.querySelector('[data-cancel]').onclick = () => m.close();
  const err = m.querySelector('#pf-err'); const save = m.querySelector('[data-save]');
  const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
  const submit = () => busy(save, async () => {
    err.classList.add('hidden');
    const v = (id) => m.querySelector(id)?.value.trim() ?? '';
    const payload = { name: v('#pf-name'), status: 'planning', start_date: v('#pf-start') || null, due_date: v('#pf-due') || null,
      description: v('#pf-desc'), project_manager: v('#pf-pm') || null, website_url: normalizeUrl(v('#pf-web')) };
    const cid = clientId || Number(v('#pf-client'));
    if (!cid) return fail('Choose a client.');
    if (!payload.name) return fail('Give the project a name.');
    if (payload.start_date && payload.due_date && payload.due_date < payload.start_date) return fail('The due date is before the start date.');
    try {
      const row = await q(supabase.from('projects').insert({ ...payload, client_id: cid }).select('id').single());
      toast(payload.project_manager ? 'Project created. The project manager was notified.' : 'Project created');
      m.close(); changed();
      location.hash = `#/project/${row.id}`;
    } catch (e) { fail(e.message); }
  });
  save.onclick = submit;
  m.querySelector('#pf').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

export function normalizeUrl(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, '')}`;
}

// Request → decision timeline: who asked, who approved, when
export function historyHtml(rows, dir, { showProject = null } = {}) {
  const items = rows.slice().sort((a, b) => new Date(b.removed_at || b.decided_at || b.requested_at) - new Date(a.removed_at || a.decided_at || a.requested_at));
  return `<div class="history">${items.map((r) => {
    const who = esc(dirName(dir, r.member_id) || 'Member');
    const where = showProject ? ` on ${esc(showProject(r.project_id))}` : '';
    const line = r.approver === 'auto'
      ? `<b>${who}</b> added${where} as ${esc(r.role_label)} by ${esc(dirName(dir, r.requested_by) || 'admin')}`
      : `<b>${who}</b>${where} as ${esc(r.role_label)}. Asked by ${esc(dirName(dir, r.requested_by))}`;
    const steps = [`<div class="w">${r.approver === 'auto' ? 'Added' : 'Asked'} ${esc(fmtDateTime(r.requested_at))}</div>`];
    if (r.approver !== 'auto' && r.decided_at) {
      const verb = { approved: 'Approved', rejected: 'Not approved', cancelled: 'Cancelled', removed: 'Approved' }[r.status] || 'Decided';
      steps.push(`<div class="w">${verb} by ${esc(labelOf(dir, r.decided_by))}, ${esc(fmtDateTime(r.decided_at))}${r.decision_note && r.status !== 'cancelled' ? `: “${esc(r.decision_note)}”` : ''}</div>`);
    }
    if (r.status === 'pending') steps.push('<div class="w">Waiting for approval</div>');
    if (r.removed_at) steps.push(`<div class="w">Removed by ${esc(dirName(dir, r.removed_by))}, ${esc(fmtDateTime(r.removed_at))}</div>`);
    return `<div class="h-item ${esc(r.status)}">${line} <span class="badge ${esc(r.status)}">${esc(MEMBER_STATUS[r.status])}</span>${steps.join('')}</div>`;
  }).join('')}</div>`;
}

// ---------- Team page: a member's projects + "Add to a project" ----------
export async function memberProjectsHtml(memberId) {
  const [rows, projects, dir] = await Promise.all([
    q(supabase.from('project_members').select('*').eq('member_id', memberId).order('requested_at', { ascending: false })),
    q(supabase.from('projects').select('id, name, status, project_manager, client:clients(name)')),
    loadDirectory(),
  ]);
  const name = (pid) => projects.find((p) => p.id === pid)?.name || 'a project';
  const current = rows.filter((r) => ['approved', 'pending'].includes(r.status));
  const managed = projects.filter((p) => p.project_manager === memberId);
  return `
    ${managed.length ? `<div class="small muted" style="margin-bottom:8px">Project manager of: ${managed.map((p) => `<a href="#/project/${p.id}">${esc(p.name)}</a>`).join(', ')}</div>` : ''}
    ${current.length ? `<div class="panel" style="margin-bottom:10px"><div class="list">${current.map((r) => `
      <a class="list-item" style="padding:10px 14px" href="#/project/${r.project_id}?tab=settings"><div class="grow"><div class="title">${esc(name(r.project_id))}</div><div class="meta"><span>${esc(r.role_label)}</span>${r.status === 'pending' ? `<span>Needs ${esc(approverText(r, projects.find((p) => p.id === r.project_id), dir))}</span>` : ''}</div></div><span class="badge ${esc(r.status)}">${r.status === 'pending' ? 'Waiting' : 'On the team'}</span></a>`).join('')}</div></div>`
      : '<p class="small muted" style="margin-bottom:10px">Not on any project yet.</p>'}
    <button class="btn btn-sm" data-add-project>${icon('folder', 14)}Add to a project</button>
    ${rows.length ? `<details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">${icon('history', 13)} Project history (${rows.length})</summary><div style="margin-top:10px">${historyHtml(rows, dir, { showProject: name })}</div></details>` : ''}`;
}

export async function openAddToProject({ memberId, memberName, memberTitle = '' }) {
  const [projects, rows, dir] = await Promise.all([
    q(supabase.from('projects').select('id, name, status, project_manager, client:clients(name)').order('name')),
    q(supabase.from('project_members').select('project_id').eq('member_id', memberId).in('status', ['approved', 'pending'])),
    loadDirectory(),
  ]);
  const taken = new Set(rows.map((r) => r.project_id));
  const list = projects.filter((p) => isOpen(p) && !taken.has(p.id) && p.project_manager !== memberId && canEditProject(p));
  const roles = [...new Set([memberTitle, ...PROJECT_ROLES].filter((t) => t && !t.startsWith('Co-Founder')))];
  const m = openModal({
    title: `Add ${esc(memberName)} to a project`,
    body: list.length ? `
      <form id="ap" class="form-grid" novalidate>
        <div class="field span-2"><label for="ap-project">Project</label><select id="ap-project" class="select"><option value="">Choose a project</option>${list.map((p) => `<option value="${p.id}">${esc(p.name)} (${esc(p.client?.name || 'client')})</option>`).join('')}</select>
          <span class="hint" id="ap-hint"></span></div>
        <div class="field span-2"><label for="ap-role">Works as</label><select id="ap-role" class="select">${roles.map((r) => `<option ${r === memberTitle ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></div>
      </form>` : `<p class="muted">${projects.length ? 'They\'re already on every open project you can manage.' : 'There are no projects yet. Open a client and press Create project.'}</p>`,
    foot: list.length ? '<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Add to project</button>' : '<button class="btn btn-primary" data-cancel>OK</button>',
  });
  m.querySelector('[data-cancel]').onclick = () => m.close();
  if (!list.length) return;
  const sel = m.querySelector('#ap-project'); const save = m.querySelector('[data-save]');
  sel.onchange = () => {
    const p = list.find((x) => x.id === Number(sel.value));
    const mode = p ? addMode(p) : null;
    m.querySelector('#ap-hint').textContent = !p ? '' : p.project_manager && p.project_manager !== me() && state.isAdmin
      ? `${dirName(dir, p.project_manager)} (project manager) gets a notification to approve.` : mode.hint;
    save.textContent = mode ? mode.label : 'Add to project';
  };
  save.onclick = () => busy(save, async () => {
    const p = list.find((x) => x.id === Number(sel.value));
    if (!p) return toast('Choose a project', 'error');
    if (await requestAdd(p, memberId, m.querySelector('#ap-role').value)) m.close();
  });
}

// ---------- Project Manager role tab ----------
export async function projectsPanel() {
  const [list, pending] = await Promise.all([
    q(supabase.from('projects').select('id, name, status, due_date, project_manager, client:clients(name)').eq('project_manager', me()).order('name')),
    q(supabase.from('project_members').select('*').eq('status', 'pending')),
  ]);
  const toDecide = pending.filter((r) => canDecide(r, list.find((p) => p.id === r.project_id)));
  return `
    <section class="panel role-panel">
      <div class="panel-head"><div><h2>Your projects</h2><p>${list.filter(isOpen).length} open${toDecide.length ? `, <b style="color:#B45309">${toDecide.length} waiting for your approval</b>` : ''}</p></div><a class="btn btn-sm btn-ghost" href="#/projects">All my projects</a></div>
      <div class="list">${list.length ? list.map((p) => `
        <a class="list-item clickable" href="#/project/${p.id}"><span class="pc-mark sm">${esc(projectInitials(p.name))}</span><div class="grow"><div class="title">${esc(p.name)}</div><div class="meta"><span>${esc(p.client?.name || '')}</span>${p.due_date ? `<span>Due ${esc(fmtDate(p.due_date))}</span>` : ''}${toDecide.some((r) => r.project_id === p.id) ? '<span class="badge pending">Approval needed</span>' : ''}</div></div>${projectBadge(p.status)}</a>`).join('')
        : emptyState('No projects assigned yet', 'When the admin or a manager makes you project manager of a project, it shows up here.')}</div>
    </section>`;
}
