// Projects: work for a client, run by a project manager with a team.
// Adding people needs an approval: admin/manager adds → the PM approves; the PM adds → the admin or a manager approves.
import { supabase } from '../supabase.js';
import { state, can, canAny, money } from '../state.js';
import { q, rpc, loadDirectory, dirName, dirLabel } from '../data.js';
import { esc, icon, emptyState, loadingBlock, on, openDrawer, closeDrawer, openModal, confirmDialog, toast, busy, statusBadge, prioTag } from '../ui.js';
import { fmtDate, fmtDateTime, fmtDateOfIso, fmtRelative, todayStr, dueLabel, dueState } from '../time.js';

export const PROJECT_STATUS = { planning: 'Planning', active: 'Active', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' };
export const WORK_ROLES = ['Designer', 'Web Developer', 'Social Media Manager', 'Ads Specialist', 'Video Editor', 'Content Writer', 'SEO Specialist', 'Other'];
const FILE_KINDS = { contract: 'Contract', document: 'Document', invoice: 'Invoice PDF', other: 'Other' };
const MEMBER_STATUS = { pending: 'Waiting for approval', approved: 'On the team', rejected: 'Not approved', cancelled: 'Cancelled', removed: 'Removed' };
const changed = () => window.dispatchEvent(new CustomEvent('ehos:data-changed'));
export const projectBadge = (s) => `<span class="badge ${esc(s)}">${esc(PROJECT_STATUS[s] || s)}</span>`;

const me = () => state.profile.id;
const isPMof = (p) => p.project_manager === me();
const canEditProject = (p) => can('projects', 'edit') || (isPMof(p) && Boolean(state.pmPerms.projects?.edit));
const canDeleteProject = (p) => can('projects', 'delete') || (isPMof(p) && Boolean(state.pmPerms.projects?.delete));
const canInvP = (p, a) => can('finance', a) || (isPMof(p) && Boolean(state.pmPerms.finance?.[a]));
const canFileP = (p, a) => (a === 'view' ? true : a === 'edit' ? can('clients', 'edit') || canEditProject(p) : can('clients', 'delete') || canDeleteProject(p));
const isOpen = (p) => !['completed', 'cancelled'].includes(p.status);

// Who has to approve a request
const approverText = (row, project, dir) => (row.approver === 'pm'
  ? `${dirName(dir, project?.project_manager) || 'the project manager'} (project manager)`
  : 'the admin or a manager');
export const canDecide = (row, project) => row.status === 'pending' && row.requested_by !== me()
  && (row.approver === 'pm' ? project?.project_manager === me() : state.isAdmin);
const canCancel = (row) => row.status === 'pending' && (row.requested_by === me() || state.isAdmin);
const labelOf = (dir, id) => { const l = dirLabel(dir, id, state.roles); return l ? `${l.name}${l.title ? `, ${l.title}` : ''}` : 'Someone'; };

// What happens when the current user adds someone to this project
function addMode(project) {
  if (state.isAdmin) {
    if (!project.project_manager || project.project_manager === me()) return { label: 'Add to project', hint: 'They join right away.' };
    return { label: 'Send to PM for approval', hint: 'The project manager gets a notification and approves it.' };
  }
  return { label: 'Send for approval', hint: 'The admin or a manager approves it. Anyone of them can.' };
}

// ---------- Page ----------
export async function render({ el, params }) {
  let projects = []; let members = []; let tasks = []; let dir = [];
  let status = params.get('status') || 'open';
  let pmFilter = ''; let search = '';
  const all = can('projects');

  el.innerHTML = `
    <div class="page-head">
      <div><h1>${all ? 'Projects' : 'My projects'}</h1><p>${all ? 'Client work, who runs it, and who is on the team.' : 'Projects you run or work on.'}</p></div>
      <div class="actions">${can('projects', 'edit') ? `<button class="btn btn-primary" id="new">${icon('plus', 15)}New project</button>` : ''}</div>
    </div>
    <div id="approvals"></div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Status" id="status"></div></div>
    <div class="toolbar">
      <div class="search grow">${icon('search', 15)}<input class="input" id="q" placeholder="Search projects or clients" aria-label="Search projects"></div>
      ${all ? '<select class="select" id="pm" style="width:auto" aria-label="Project manager"><option value="">Any project manager</option><option value="none">No project manager</option></select>' : ''}
    </div>
    <section class="panel"><div class="table-wrap" id="table">${loadingBlock(5)}</div></section>`;
  const table = el.querySelector('#table');
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
      table.innerHTML = emptyState(all ? 'No projects yet' : 'No projects for you yet',
        all ? 'Open a client and press Create project, or start one here.' : 'When you\'re made project manager or added to a team, the project shows up here.',
        can('projects', 'edit') ? '<button class="btn btn-primary" data-new>New project</button>' : '');
      return;
    }
    if (!list.length) { table.innerHTML = emptyState('No projects match these filters'); return; }
    table.innerHTML = `<table class="table">
      <thead><tr><th>Project</th><th>Status</th><th>Project manager</th><th>Team</th><th>Tasks</th><th>Due</th></tr></thead>
      <tbody>${list.map((p) => {
        const team = members.filter((m) => m.project_id === p.id && m.status === 'approved');
        const pending = members.filter((m) => m.project_id === p.id && m.status === 'pending').length;
        const pt = tasks.filter((t) => t.project_id === p.id); const done = pt.filter((t) => t.status === 'completed').length;
        return `<tr class="clickable" data-id="${p.id}" tabindex="0">
          <td><div style="font-weight:500">${esc(p.name)}</div><div class="small muted">${esc(p.client?.name || 'Client')}</div></td>
          <td>${projectBadge(p.status)}</td>
          <td class="small">${p.project_manager ? esc(dirName(dir, p.project_manager)) : '<span class="muted">Not assigned</span>'}</td>
          <td class="small">${team.length ? `${team.length} ${team.length === 1 ? 'person' : 'people'}` : '<span class="muted">—</span>'}${pending ? ` <span class="badge pending">${pending} waiting</span>` : ''}</td>
          <td>${pt.length ? `<div class="row" style="gap:8px"><div class="proj-progress"><i style="width:${Math.round((done / pt.length) * 100)}%"></i></div><span class="small muted">${done}/${pt.length}</span></div>` : '<span class="muted small">—</span>'}</td>
          <td class="small">${p.due_date ? esc(fmtDate(p.due_date)) : '<span class="muted">—</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
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
    on(table, 'click', '[data-new]', () => openProjectForm()),
    on(table, 'click', 'tr[data-id]', (e, tr) => openProjectDrawer(Number(tr.dataset.id))),
    on(table, 'keydown', 'tr[data-id]', (e, tr) => { if (e.key === 'Enter') openProjectDrawer(Number(tr.dataset.id)); }),
    on(appr, 'click', '[data-approve]', (e, b) => decide(b, Number(b.dataset.approve), true, members, dir)),
    on(appr, 'click', '[data-reject]', (e, b) => decide(b, Number(b.dataset.reject), false, members, dir)),
  ];
  const safe = () => load().catch((e) => { table.innerHTML = `<div class="form-error" style="margin:16px">${esc(e.message)}</div>`; });
  await safe();
  if (params.get('open')) openProjectDrawer(Number(params.get('open')), params.get('tab') || 'overview');
  window.addEventListener('ehos:data-changed', safe);
  return () => { offs.forEach((x) => x()); window.removeEventListener('ehos:data-changed', safe); };
}

async function decide(btn, id, approve, rows, dir) {
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

// ---------- Project form ----------
export async function openProjectForm({ project = null, clientId = null } = {}) {
  const [dir, clients] = await Promise.all([
    loadDirectory(),
    project || clientId ? Promise.resolve([]) : q(supabase.from('clients').select('id, name').order('name')),
  ]);
  const pms = dir.filter((d) => d.roles.includes('project_manager') && d.status !== 'inactive');
  let clientName = '';
  if (clientId && !project) clientName = (await q(supabase.from('clients').select('name').eq('id', clientId).maybeSingle()))?.name || '';
  const p = project || { name: clientName ? `${clientName} project` : '', description: '', status: 'planning', project_manager: '', start_date: todayStr(), due_date: '' };
  const canPM = can('projects', 'edit');
  const m = openModal({
    title: project ? 'Edit project' : 'New project',
    subtitle: clientName ? `For client ${esc(clientName)}` : project ? esc(project.client?.name || '') : '',
    wide: true,
    body: `
      <form id="pf" class="form-grid" novalidate>
        ${!project && !clientId ? `<div class="field span-2"><label for="pf-client">Client</label><select id="pf-client" class="select"><option value="">Choose a client</option>${clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
          ${clients.length ? '' : '<span class="hint">No clients yet. Convert a won lead or add a client first.</span>'}</div>` : ''}
        <div class="field span-2"><label for="pf-name">Project name</label><input id="pf-name" class="input" maxlength="200" value="${esc(p.name)}" placeholder="e.g. Shopify store build, Meta ads Q4" required></div>
        <div class="field span-2"><label for="pf-pm">Project manager</label>
          <select id="pf-pm" class="select" ${canPM ? '' : 'disabled'}><option value="">Not assigned yet</option>${pms.map((d) => `<option value="${d.id}" ${p.project_manager === d.id ? 'selected' : ''}>${esc(d.name)}${d.job_title ? ` (${esc(d.job_title)})` : ''}</option>`).join('')}</select>
          <span class="hint">${pms.length ? 'They get a notification, and see this project with its client details, files and finances.' : 'Give someone the Project Manager role on the Team page first.'}</span></div>
        <div class="field"><label for="pf-status">Status</label><select id="pf-status" class="select">${Object.entries(PROJECT_STATUS).map(([k, v]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label for="pf-start">Start date</label><input id="pf-start" class="input" type="date" value="${esc(p.start_date || '')}"></div>
        <div class="field"><label for="pf-due">Due date (optional)</label><input id="pf-due" class="input" type="date" value="${esc(p.due_date || '')}"></div>
        <div class="field span-2"><label for="pf-desc">Scope / notes</label><textarea id="pf-desc" class="textarea" placeholder="What's being delivered, links, deadlines">${esc(p.description || '')}</textarea></div>
        <div class="form-error hidden span-2" id="pf-err"></div>
      </form>`,
    foot: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>${project ? 'Save project' : 'Create project'}</button>`,
  });
  m.querySelector('[data-cancel]').onclick = () => m.close();
  const err = m.querySelector('#pf-err'); const save = m.querySelector('[data-save]');
  const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
  const submit = () => busy(save, async () => {
    err.classList.add('hidden');
    const v = (id) => m.querySelector(id)?.value.trim() ?? '';
    const payload = { name: v('#pf-name'), status: v('#pf-status'), start_date: v('#pf-start') || null, due_date: v('#pf-due') || null, description: v('#pf-desc') };
    if (canPM) payload.project_manager = v('#pf-pm') || null;
    const cid = project ? project.client_id : clientId || Number(v('#pf-client'));
    if (!cid) return fail('Choose a client.');
    if (!payload.name) return fail('Give the project a name.');
    if (payload.start_date && payload.due_date && payload.due_date < payload.start_date) return fail('The due date is before the start date.');
    try {
      let id = project?.id;
      if (project) await q(supabase.from('projects').update(payload).eq('id', project.id));
      else id = (await q(supabase.from('projects').insert({ ...payload, client_id: cid }).select('id').single())).id;
      toast(project ? 'Project saved' : payload.project_manager ? 'Project created. The project manager was notified.' : 'Project created');
      m.close(); changed();
      if (!project) {
        if (!location.hash.startsWith('#/projects')) location.hash = `#/projects?open=${id}`;
        else openProjectDrawer(id);
      }
    } catch (e) { fail(e.message); }
  });
  save.onclick = submit;
  m.querySelector('#pf').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

// ---------- Project drawer ----------
export function openProjectDrawer(id, tab = 'overview') {
  const drawer = openDrawer({ title: 'Project', body: loadingBlock(4), onClose: () => window.removeEventListener('ehos:data-changed', reload) });
  const reload = () => load().catch(() => {});
  window.addEventListener('ehos:data-changed', reload);

  async function load() {
    const [p, dir] = await Promise.all([q(supabase.from('projects').select('*, client:clients(id, name, contact_name, email, phone, website)').eq('id', id).maybeSingle()), loadDirectory()]);
    if (!drawer.isConnected) return;
    if (!p) { drawer.querySelector('.drawer-body').innerHTML = '<p class="muted">This project was deleted or you\'re no longer on it.</p>'; return; }
    const showInv = canInvP(p, 'view');
    const [rows, ptasks, invoices, files] = await Promise.all([
      q(supabase.from('project_members').select('*').eq('project_id', id).order('requested_at', { ascending: false })),
      q(supabase.from('tasks').select('id, title, status, priority, due_date, assigned_to').eq('project_id', id).order('created_at', { ascending: false })),
      showInv ? q(supabase.from('invoices').select('*').eq('project_id', id).order('issue_date', { ascending: false })) : Promise.resolve([]),
      q(supabase.from('client_files').select('*').eq('project_id', id).order('created_at', { ascending: false })),
    ]);
    if (!drawer.isConnected) return;
    drawer.querySelector('.drawer-head h2').textContent = p.name;
    const team = rows.filter((r) => r.status === 'approved');
    const pending = rows.filter((r) => r.status === 'pending');
    const manage = canEditProject(p);
    const tabs = [['overview', 'Overview'], ['team', `Team${team.length ? ` (${team.length})` : ''}${pending.length ? ' •' : ''}`], ['tasks', `Tasks${ptasks.length ? ` (${ptasks.length})` : ''}`],
      showInv && ['invoices', `Finances${invoices.length ? ` (${invoices.length})` : ''}`], ['files', `Files${files.length ? ` (${files.length})` : ''}`]].filter(Boolean);
    if (!tabs.some(([k]) => k === tab)) tab = 'overview';
    const c = p.client || {};
    let content = '';

    if (tab === 'overview') {
      const done = ptasks.filter((t) => t.status === 'completed').length;
      const paid = invoices.filter((i) => i.status === 'paid').reduce((a, i) => a + Number(i.amount), 0);
      const due = invoices.filter((i) => i.status === 'sent').reduce((a, i) => a + Number(i.amount), 0);
      const pmL = dirLabel(dir, p.project_manager, state.roles);
      content = `
        <div class="row wrap">${projectBadge(p.status)}${p.due_date && isOpen(p) ? `<span class="chip">Due ${esc(fmtDate(p.due_date))}</span>` : ''}</div>
        ${pending.some((r) => canDecide(r, p)) ? `<div class="note warn">${pending.filter((r) => canDecide(r, p)).length} team request(s) need your approval. <button class="linkish" data-goto="team">Review</button></div>` : ''}
        <div class="stats"><div class="stat-group">
          <div class="stat"><div class="v" style="font-size:19px">${team.length}</div><div class="k">On the team</div></div>
          <div class="stat"><div class="v" style="font-size:19px">${done}/${ptasks.length}</div><div class="k">Tasks done</div></div>
          ${showInv ? `<div class="stat"><div class="v" style="font-size:19px;color:#15803D">${money(paid)}</div><div class="k">Paid</div></div>
          <div class="stat"><div class="v" style="font-size:19px">${money(due)}</div><div class="k">Unpaid</div></div>` : ''}
        </div></div>
        <dl class="kv">
          <dt>Client</dt><dd>${esc(c.name || '—')}${c.id && canAny('clients') ? ` <a class="small" href="#/clients?open=${c.id}">Open client</a>` : ''}</dd>
          <dt>Project manager</dt><dd>${pmL ? `${esc(pmL.name)}${pmL.title ? ` <span class="muted small">${esc(pmL.title)}</span>` : ''}` : 'Not assigned'}</dd>
          <dt>Start date</dt><dd>${esc(fmtDate(p.start_date))}</dd>
          <dt>Due date</dt><dd>${esc(fmtDate(p.due_date))}</dd>
          <dt>Contact</dt><dd>${esc(c.contact_name || '—')}</dd>
          <dt>Email</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</dd>
          <dt>Phone</dt><dd>${esc(c.phone || '—')}</dd>
          <dt>Website</dt><dd>${c.website ? `<a href="${esc(/^https?:/.test(c.website) ? c.website : 'https://' + c.website)}" target="_blank" rel="noopener">${esc(c.website)}</a>` : '—'}</dd>
          <dt>Created</dt><dd>${esc(fmtDateOfIso(p.created_at))}${p.created_by ? ` by ${esc(dirName(dir, p.created_by))}` : ''}</dd>
        </dl>
        <div><div class="section-title">Scope / notes</div>${p.description ? `<div class="desc">${esc(p.description)}</div>` : '<p class="muted small">Nothing written yet.</p>'}</div>`;
    } else if (tab === 'team') {
      const taken = new Set([...team, ...pending].map((r) => r.member_id));
      const options = dir.filter((d) => d.status !== 'inactive' && !d.is_admin && d.id !== p.project_manager && !taken.has(d.id));
      const mode = addMode(p);
      const pmL = dirLabel(dir, p.project_manager, state.roles);
      content = `
        <div class="note info">${icon('shield', 13)} Adding people needs approval. When the admin or a manager adds someone, the project manager approves it. When the project manager adds someone, the admin or any manager approves it.</div>
        <div><div class="section-title">Project manager</div>
          <div class="list-item panel" style="padding:10px 14px">${p.project_manager ? `<span class="mini-av">${esc((pmL?.name || '?')[0])}</span><div class="grow"><div class="title">${esc(pmL?.name || '')}</div><div class="meta">${esc(pmL?.title || 'Project manager')}</div></div>` : '<div class="grow muted">Not assigned yet</div>'}
          ${can('projects', 'edit') ? '<button class="btn btn-sm" data-act="edit">Change</button>' : ''}</div></div>
        ${pending.length ? `<div><div class="section-title">Waiting for approval</div><div class="panel"><div class="list">${pending.map((r) => `
          <div class="list-item" style="padding:10px 14px;flex-wrap:wrap"><span class="mini-av">${esc((dirName(dir, r.member_id) || '?')[0])}</span>
            <div class="grow" style="min-width:180px"><div class="title">${esc(dirName(dir, r.member_id) || 'Member')} <span class="badge pending">Waiting</span></div>
              <div class="meta"><span>${esc(r.role_label)}</span><span>Asked by ${esc(dirName(dir, r.requested_by))} ${esc(fmtRelative(r.requested_at))}</span><span>Needs ${esc(approverText(r, p, dir))}</span></div></div>
            ${canDecide(r, p) ? `<button class="btn btn-sm" data-reject="${r.id}">${icon('x', 13)}Reject</button><button class="btn btn-sm btn-primary" data-approve="${r.id}">${icon('check', 13)}Approve</button>` : ''}
            ${canCancel(r) && !canDecide(r, p) ? `<button class="btn btn-sm btn-ghost" data-cancel-req="${r.id}">Cancel request</button>` : ''}
          </div>`).join('')}</div></div></div>` : ''}
        <div><div class="section-title">Team</div>
          ${team.length ? `<div class="panel"><div class="list">${team.map((r) => `
            <div class="list-item" style="padding:10px 14px;flex-wrap:wrap"><span class="mini-av">${esc((dirName(dir, r.member_id) || '?')[0])}</span>
              <div class="grow" style="min-width:180px"><div class="title">${esc(dirName(dir, r.member_id) || 'Member')}</div>
                <div class="meta"><span>${esc(r.role_label)}</span><span>${r.approver === 'auto' ? `Added by ${esc(dirName(dir, r.decided_by) || 'admin')}` : `Approved by ${esc(dirName(dir, r.decided_by))}`} ${esc(fmtDateOfIso(r.decided_at))}</span></div></div>
              ${manage && isOpen(p) ? `<button class="btn btn-sm" data-assign="${r.member_id}">${icon('plus', 13)}Assign task</button>` : ''}
              ${manage ? `<button class="btn btn-sm btn-ghost btn-icon btn-danger" data-remove="${r.id}" aria-label="Remove from project">${icon('x', 13)}</button>` : ''}
            </div>`).join('')}</div></div>` : '<p class="muted small">Nobody on the team yet.</p>'}
        </div>
        ${manage && isOpen(p) ? `<div class="panel"><div class="panel-body stack" style="gap:10px">
          <div class="section-title" style="margin:0">Add someone</div>
          <div class="form-grid">
            <div class="field"><label for="pm-member">Team member</label><select id="pm-member" class="select"><option value="">Choose a member</option>${options.map((d) => `<option value="${d.id}">${esc(d.name)}${d.job_title ? ` (${esc(d.job_title)})` : ''}</option>`).join('')}</select></div>
            <div class="field"><label for="pm-role">Works as</label><select id="pm-role" class="select">${WORK_ROLES.map((r) => `<option>${r}</option>`).join('')}</select>
              <input id="pm-role-other" class="input hidden" style="margin-top:6px" maxlength="40" placeholder="Type the role"></div>
          </div>
          <span class="hint small muted">${esc(mode.hint)}</span>
          <div><button class="btn btn-primary btn-sm" data-add-member>${icon('userPlus', 13)}${esc(mode.label)}</button></div></div></div>` : ''}
        ${rows.length ? `<div><div class="section-title"><span class="row" style="gap:6px">${icon('history', 14)}History</span></div>${historyHtml(rows, dir)}</div>` : ''}`;
    } else if (tab === 'tasks') {
      content = `
        <div class="section-title">Tasks <span>${manage && isOpen(p) ? `<button class="btn btn-sm btn-primary" data-assign="">${icon('plus', 13)}New task</button>` : ''}</span></div>
        ${ptasks.length ? `<div class="panel"><div class="list">${ptasks.map((t) => `
          <div class="list-item clickable" data-task="${t.id}"><div class="grow"><div class="title">${esc(t.title)}</div>
            <div class="meta">${statusBadge(t.status)}${prioTag(t.priority)}<span>${esc(dirName(dir, t.assigned_to) || 'Unassigned')}</span>${t.due_date && t.status !== 'completed' ? `<span class="due ${dueState(t)}">${esc(dueLabel(t.due_date))}</span>` : ''}</div></div></div>`).join('')}</div></div>`
          : emptyState('No tasks yet', manage ? 'Add people on the Team tab, then give them work here.' : '')}`;
    } else if (tab === 'invoices') {
      const { invoiceBadge } = await import('./clients.js');
      content = `
        <div class="section-title">Invoices for this project <span class="row">${canInvP(p, 'edit') ? `<button class="btn btn-sm btn-primary" data-new-inv>${icon('plus', 13)}New invoice</button>` : ''}</span></div>
        ${invoices.length ? `<div class="panel"><div class="list">${invoices.map((i) => `
          <div class="list-item" style="padding:11px 14px;flex-wrap:wrap">
            <div class="grow" style="min-width:180px"><div class="title">${esc(i.invoice_number || `Invoice #${i.id}`)} <span class="money" style="font-weight:600;margin-left:6px">${money(i.amount)}</span></div>
              <div class="meta"><span>Issued ${esc(fmtDate(i.issue_date))}</span>${i.due_date ? `<span>Due ${esc(fmtDate(i.due_date))}</span>` : ''}${i.paid_date ? `<span>Paid ${esc(fmtDate(i.paid_date))}</span>` : ''}${i.description ? `<span>${esc(i.description)}</span>` : ''}</div></div>
            ${invoiceBadge(i)}
            ${canInvP(p, 'edit') && i.status === 'sent' ? `<button class="btn btn-sm" data-paid="${i.id}">${icon('check', 13)}Mark paid</button>` : ''}
            ${canInvP(p, 'edit') ? `<button class="btn btn-sm btn-ghost btn-icon" data-edit-inv="${i.id}" aria-label="Edit invoice">${icon('edit', 13)}</button>` : ''}
          </div>`).join('')}</div></div>` : emptyState('No invoices for this project yet', canInvP(p, 'edit') ? 'Add one here, or tag an invoice to this project from the client.' : '')}`;
    } else {
      content = `
        ${canFileP(p, 'edit') ? `<div class="panel"><div class="panel-body stack" style="gap:10px">
          <div class="section-title" style="margin:0">Upload a file</div>
          <div class="row wrap"><select class="select select-sm" id="f-kind" style="width:auto">${Object.entries(FILE_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <input type="file" id="f-file" aria-label="File" style="flex:1;min-width:180px"><button class="btn btn-sm btn-primary" data-upload>${icon('upload', 13)}Upload</button></div>
          <span class="hint small muted">Briefs, contracts, documents. Up to 25 MB. The project team can open them.</span></div></div>` : ''}
        ${files.length ? `<div class="panel"><div>${files.map((f) => `
          <div class="file-row">${icon('file', 18)}<div class="grow"><div class="title">${esc(f.name)}</div>
            <div class="small muted">${esc(FILE_KINDS[f.kind] || f.kind)}, ${f.size_bytes ? (f.size_bytes / 1048576).toFixed(1) + ' MB, ' : ''}${esc(dirName(dir, f.uploaded_by) || '')} ${esc(fmtDateOfIso(f.created_at))}</div></div>
            <button class="btn btn-sm" data-open-file="${esc(f.storage_path)}">${icon('download', 13)}Open</button>
            ${canFileP(p, 'delete') ? `<button class="btn btn-sm btn-ghost btn-icon btn-danger" data-del-file="${f.id}" aria-label="Delete file">${icon('trash', 13)}</button>` : ''}
          </div>`).join('')}</div></div>` : emptyState('No files on this project yet')}`;
    }

    const body = drawer.querySelector('.drawer-body');
    body.innerHTML = `<div class="small muted" style="margin-top:-6px">${icon('briefcase', 12)} ${esc(c.name || '')}</div>
      <div class="tabs-line" role="tablist">${tabs.map(([k, v]) => `<button data-tab="${k}" aria-pressed="${tab === k}">${v}</button>`).join('')}</div>${content}`;
    let foot = '';
    if (canDeleteProject(p)) foot += `<button class="btn btn-ghost btn-danger" data-act="delete">${icon('trash', 14)}Delete</button>`;
    foot += '<span style="flex:1"></span>';
    if (canEditProject(p)) foot += `<button class="btn btn-primary" data-act="edit">${icon('edit', 14)}Edit project</button>`;
    let footEl = drawer.querySelector('.drawer-foot');
    if (!footEl) { footEl = document.createElement('div'); footEl.className = 'drawer-foot'; drawer.append(footEl); }
    footEl.innerHTML = foot;
    footEl.classList.toggle('hidden', !foot.replace('<span style="flex:1"></span>', ''));

    body.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; load(); });
    body.querySelectorAll('[data-goto]').forEach((b) => b.onclick = () => { tab = b.dataset.goto; load(); });
    [body, footEl].forEach((root) => root.querySelectorAll('[data-act="edit"]').forEach((b) => b.onclick = () => openProjectForm({ project: p })));
    footEl.querySelector('[data-act="delete"]')?.addEventListener('click', async () => {
      if (!await confirmDialog({ title: `Delete ${p.name}?`, text: 'The team list and requests are deleted. Tasks, invoices and files stay with the client.', confirm: 'Delete project', danger: true })) return;
      try { await q(supabase.from('projects').delete().eq('id', id)); toast('Project deleted'); closeDrawer(); changed(); } catch (e) { toast(e.message, 'error'); }
    });

    // team
    body.querySelectorAll('[data-approve]').forEach((b) => b.onclick = () => decide(b, Number(b.dataset.approve), true, rows, dir));
    body.querySelectorAll('[data-reject]').forEach((b) => b.onclick = () => decide(b, Number(b.dataset.reject), false, rows, dir));
    body.querySelectorAll('[data-cancel-req]').forEach((b) => b.onclick = async () => {
      if (!await confirmDialog({ title: 'Cancel this request?', confirm: 'Cancel request', danger: true })) return;
      try { await rpc('project_member_cancel', { p_id: Number(b.dataset.cancelReq) }); toast('Request cancelled'); changed(); } catch (e) { toast(e.message, 'error'); }
    });
    body.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => {
      const r = rows.find((x) => x.id === Number(b.dataset.remove));
      if (!await confirmDialog({ title: `Remove ${dirName(dir, r.member_id)} from ${p.name}?`, text: 'Their existing tasks stay. This shows in the history.', confirm: 'Remove', danger: true })) return;
      try { await rpc('project_member_remove', { p_id: r.id }); toast('Removed from the project'); changed(); } catch (e) { toast(e.message, 'error'); }
    });
    const roleSel = body.querySelector('#pm-role');
    roleSel?.addEventListener('change', () => body.querySelector('#pm-role-other').classList.toggle('hidden', roleSel.value !== 'Other'));
    body.querySelector('[data-add-member]')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const member = body.querySelector('#pm-member').value;
      const label = roleSel.value === 'Other' ? body.querySelector('#pm-role-other').value.trim() : roleSel.value;
      if (!member) return toast('Choose a team member', 'error');
      if (!label) return toast('Type the role', 'error');
      await requestAdd(p, member, label);
    }));

    // tasks
    body.querySelectorAll('[data-assign]').forEach((b) => b.onclick = async () => {
      const { openTaskForm } = await import('../task-drawer.js');
      const opts = team.map((t) => ({ id: t.member_id, first_name: `${dirName(dir, t.member_id)} (${t.role_label})`, last_name: '', roles: [], status: 'active' }));
      if (p.project_manager) opts.unshift({ id: p.project_manager, first_name: `${dirName(dir, p.project_manager)} (project manager)`, last_name: '', roles: [], status: 'active' });
      openTaskForm({ projectId: id, projectName: p.name, clientId: p.client_id, memberOptions: opts, presetMember: b.dataset.assign || null, onSaved: () => { tab = 'tasks'; changed(); } });
    });
    body.querySelectorAll('[data-task]').forEach((x) => x.onclick = async () => { const { openTaskDrawer } = await import('../task-drawer.js'); openTaskDrawer(Number(x.dataset.task)); });

    // finances
    body.querySelector('[data-new-inv]')?.addEventListener('click', async () => { const m = await import('./clients.js'); m.openInvoiceForm({ clientId: p.client_id, projectId: id }); });
    body.querySelectorAll('[data-edit-inv]').forEach((b) => b.onclick = async () => { const m = await import('./clients.js'); m.openInvoiceForm({ clientId: p.client_id, projectId: id, invoice: invoices.find((i) => i.id === Number(b.dataset.editInv)) }); });
    body.querySelectorAll('[data-paid]').forEach((b) => b.onclick = () => busy(b, async () => {
      try { await q(supabase.from('invoices').update({ status: 'paid' }).eq('id', Number(b.dataset.paid))); toast('Marked as paid'); changed(); } catch (e) { toast(e.message, 'error'); }
    }));

    // files
    body.querySelectorAll('[data-open-file]').forEach((b) => b.onclick = () => busy(b, async () => {
      const { data, error } = await supabase.storage.from('client-files').createSignedUrl(b.dataset.openFile, 120);
      if (error) return toast(error.message, 'error');
      window.open(data.signedUrl, '_blank', 'noopener');
    }));
    body.querySelectorAll('[data-del-file]').forEach((b) => b.onclick = async () => {
      const f = files.find((x) => x.id === Number(b.dataset.delFile));
      if (!await confirmDialog({ title: `Delete ${f.name}?`, confirm: 'Delete file', danger: true })) return;
      try {
        await supabase.storage.from('client-files').remove([f.storage_path]);
        await q(supabase.from('client_files').delete().eq('id', f.id));
        toast('File deleted'); changed();
      } catch (e) { toast(e.message, 'error'); }
    });
    body.querySelector('[data-upload]')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
      const file = body.querySelector('#f-file').files[0];
      if (!file) return toast('Choose a file first', 'error');
      if (file.size > 25 * 1048576) return toast('Files can be up to 25 MB', 'error');
      const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-120);
      const path = `${p.client_id}/p${id}/${crypto.randomUUID()}-${safeName}`;
      const up = await supabase.storage.from('client-files').upload(path, file, { contentType: file.type || 'application/octet-stream' });
      if (up.error) return toast(up.error.message, 'error');
      try {
        await q(supabase.from('client_files').insert({ client_id: p.client_id, project_id: id, kind: body.querySelector('#f-kind').value, name: file.name.slice(0, 200), storage_path: path, size_bytes: file.size }));
        toast('File uploaded'); changed();
      } catch (err) {
        await supabase.storage.from('client-files').remove([path]);
        toast(err.message, 'error');
      }
    }));
  }
  load().catch((e) => { drawer.querySelector('.drawer-body').innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
}

async function requestAdd(project, memberId, label) {
  try {
    await rpc('project_member_request', { p_project: project.id, p_member: memberId, p_role: label });
    const direct = state.isAdmin && (!project.project_manager || project.project_manager === me());
    toast(direct ? 'Added to the project. They were notified.' : state.isAdmin ? 'Sent to the project manager for approval' : 'Sent to the admin and managers for approval');
    changed();
    return true;
  } catch (e) { toast(e.message, 'error'); return false; }
}

// Request → decision timeline: who asked, who approved, when
export function historyHtml(rows, dir, { showProject = null } = {}) {
  const items = rows.slice().sort((a, b) => new Date(b.removed_at || b.decided_at || b.requested_at) - new Date(a.removed_at || a.decided_at || a.requested_at));
  return `<div class="history">${items.map((r) => {
    const who = esc(dirName(dir, r.member_id) || 'Member');
    const where = showProject ? ` on ${esc(showProject(r.project_id))}` : '';
    let line;
    if (r.approver === 'auto') line = `<b>${who}</b> added${where} as ${esc(r.role_label)} by ${esc(dirName(dir, r.requested_by) || 'admin')}`;
    else line = `<b>${who}</b>${where} as ${esc(r.role_label)}. Asked by ${esc(dirName(dir, r.requested_by))}`;
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

// ---------- Team page: a member's projects + "Add to project" ----------
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
    ${managed.length ? `<div class="small muted" style="margin-bottom:8px">Project manager of: ${managed.map((p) => `<a href="#/projects?open=${p.id}">${esc(p.name)}</a>`).join(', ')}</div>` : ''}
    ${current.length ? `<div class="panel" style="margin-bottom:10px"><div class="list">${current.map((r) => `
      <a class="list-item" style="padding:10px 14px" href="#/projects?open=${r.project_id}&tab=team"><div class="grow"><div class="title">${esc(name(r.project_id))}</div><div class="meta"><span>${esc(r.role_label)}</span>${r.status === 'pending' ? `<span>Needs ${esc(approverText(r, projects.find((p) => p.id === r.project_id), dir))}</span>` : ''}</div></div><span class="badge ${esc(r.status)}">${r.status === 'pending' ? 'Waiting' : 'On the team'}</span></a>`).join('')}</div></div>`
      : '<p class="small muted" style="margin-bottom:10px">Not on any project yet.</p>'}
    <button class="btn btn-sm" data-add-project>${icon('folder', 14)}Add to a project</button>
    ${rows.length ? `<details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">${icon('history', 13)} Project history (${rows.length})</summary><div style="margin-top:10px">${historyHtml(rows, dir, { showProject: name })}</div></details>` : ''}`;
}

export async function openAddToProject({ memberId, memberName }) {
  const [projects, rows] = await Promise.all([
    q(supabase.from('projects').select('id, name, status, project_manager, client:clients(name)').order('name')),
    q(supabase.from('project_members').select('project_id').eq('member_id', memberId).in('status', ['approved', 'pending'])),
  ]);
  const taken = new Set(rows.map((r) => r.project_id));
  const list = projects.filter((p) => isOpen(p) && !taken.has(p.id) && p.project_manager !== memberId && canEditProject(p));
  const dir = await loadDirectory();
  const m = openModal({
    title: `Add ${esc(memberName)} to a project`,
    body: list.length ? `
      <form id="ap" class="form-grid" novalidate>
        <div class="field span-2"><label for="ap-project">Project</label><select id="ap-project" class="select"><option value="">Choose a project</option>${list.map((p) => `<option value="${p.id}">${esc(p.name)} (${esc(p.client?.name || 'client')})</option>`).join('')}</select>
          <span class="hint" id="ap-hint"></span></div>
        <div class="field span-2"><label for="ap-role">Works as</label><select id="ap-role" class="select">${WORK_ROLES.map((r) => `<option>${r}</option>`).join('')}</select>
          <input id="ap-role-other" class="input hidden" style="margin-top:6px" maxlength="40" placeholder="Type the role"></div>
      </form>` : `<p class="muted">${projects.length ? 'They\'re already on every open project you can manage.' : 'There are no projects yet. Open a client and press Create project.'}</p>`,
    foot: list.length ? '<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Add to project</button>' : '<button class="btn btn-primary" data-cancel>OK</button>',
  });
  m.querySelector('[data-cancel]').onclick = () => m.close();
  if (!list.length) return;
  const sel = m.querySelector('#ap-project'); const save = m.querySelector('[data-save]');
  const roleSel = m.querySelector('#ap-role');
  roleSel.onchange = () => m.querySelector('#ap-role-other').classList.toggle('hidden', roleSel.value !== 'Other');
  sel.onchange = () => {
    const p = list.find((x) => x.id === Number(sel.value));
    const mode = p ? addMode(p) : null;
    m.querySelector('#ap-hint').textContent = !p ? '' : p.project_manager && p.project_manager !== me() && state.isAdmin
      ? `${dirName(dir, p.project_manager)} (project manager) gets a notification to approve.` : mode.hint;
    save.textContent = mode ? mode.label : 'Add to project';
  };
  save.onclick = () => busy(save, async () => {
    const p = list.find((x) => x.id === Number(sel.value));
    const label = roleSel.value === 'Other' ? m.querySelector('#ap-role-other').value.trim() : roleSel.value;
    if (!p) return toast('Choose a project', 'error');
    if (!label) return toast('Type the role', 'error');
    if (await requestAdd(p, memberId, label)) m.close();
  });
}

// ---------- Project Manager role tab ----------
export async function projectsPanel() {
  const [list, pending, dir] = await Promise.all([
    q(supabase.from('projects').select('id, name, status, due_date, project_manager, client:clients(name)').eq('project_manager', me()).order('name')),
    q(supabase.from('project_members').select('*').eq('status', 'pending')),
    loadDirectory(),
  ]);
  const toDecide = pending.filter((r) => canDecide(r, list.find((p) => p.id === r.project_id)));
  return `
    <section class="panel role-panel">
      <div class="panel-head"><div><h2>Your projects</h2><p>${list.filter(isOpen).length} open${toDecide.length ? `, <b style="color:#B45309">${toDecide.length} waiting for your approval</b>` : ''}</p></div><a class="btn btn-sm btn-ghost" href="#/projects">Open projects</a></div>
      <div class="list">${list.length ? list.map((p) => `
        <div class="list-item clickable" data-project="${p.id}"><div class="grow"><div class="title">${esc(p.name)}</div><div class="meta"><span>${esc(p.client?.name || '')}</span>${p.due_date ? `<span>Due ${esc(fmtDate(p.due_date))}</span>` : ''}${toDecide.some((r) => r.project_id === p.id) ? '<span class="badge pending">Approval needed</span>' : ''}</div></div>${projectBadge(p.status)}</div>`).join('')
        : emptyState('No projects assigned yet', 'When the admin or a manager makes you project manager of a project, it shows up here.')}</div>
    </section>`;
}
