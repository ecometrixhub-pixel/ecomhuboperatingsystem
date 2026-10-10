// Project workspace: one project, everything about it in one place.
// Overview · Live view (website + socials) · Requirements · Tasks · Files · Finances · Settings (details + team)
import { supabase } from '../supabase.js';
import { state, can, canAny, money } from '../state.js';
import { q, rpc, loadDirectory, dirName, dirLabel } from '../data.js';
import { esc, icon, emptyState, loadingBlock, confirmDialog, toast, busy, openModal, prioTag, STATUS_LABEL } from '../ui.js';
import { fmtDate, fmtDateOfIso, fmtRelative, fmtDuration, todayStr, dueLabel, dueState } from '../time.js';
import {
  PROJECT_STATUS, FILE_KINDS, changed, projectBadge, projectInitials, isPMof, canEditProject, canDeleteProject, canInvP, canFileP, isOpen,
  approverText, canDecide, canCancel, addMode, roleOptions, decide, requestAdd, historyHtml, normalizeUrl,
} from './projects.js';

export const SOCIALS = [
  ['instagram', 'Instagram', 'IG', 'https://instagram.com/'],
  ['facebook', 'Facebook', 'FB', 'https://facebook.com/'],
  ['tiktok', 'TikTok', 'TT', 'https://tiktok.com/@'],
  ['youtube', 'YouTube', 'YT', 'https://youtube.com/@'],
  ['linkedin', 'LinkedIn', 'in', 'https://linkedin.com/company/'],
  ['x', 'X (Twitter)', 'X', 'https://x.com/'],
];
const shot = (url, w = 1200) => `https://s0.wp.com/mshots/v1/${encodeURIComponent(url)}?w=${w}`;
const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };
function socialUrl(key, v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s) || /\.[a-z]{2,}\//i.test(s)) return normalizeUrl(s);
  const base = SOCIALS.find((x) => x[0] === key)?.[3] || 'https://';
  return base + s.replace(/^@/, '');
}

export async function render({ el, arg, params, setTitle }) {
  const id = Number(arg);
  let tab = params.get('tab') || 'overview';
  let liveMode = 'shot'; let taskMember = ''; let shotBust = '';
  let data = null;
  el.innerHTML = loadingBlock(6);

  async function load() {
    const [p, dir, all] = await Promise.all([
      q(supabase.from('projects').select('*, client:clients(id, name, contact_name, email, phone, website, country)').eq('id', id).maybeSingle()),
      loadDirectory(),
      q(supabase.from('projects').select('id, name, status, project_manager, client:clients(name)').order('name')),
    ]);
    if (!p) { el.innerHTML = `<div class="panel">${emptyState('Project not found', 'It was deleted, or you\'re no longer on its team.', '<a class="btn" href="#/projects">Back to projects</a>')}</div>`; return; }
    const showInv = canInvP(p, 'view');
    const [rows, tasks, reqs, invoices, files] = await Promise.all([
      q(supabase.from('project_members').select('*').eq('project_id', id).order('requested_at', { ascending: false })),
      q(supabase.from('tasks').select('id, title, status, priority, due_date, assigned_to, created_at').eq('project_id', id).order('created_at', { ascending: false })),
      q(supabase.from('project_requirements').select('*').eq('project_id', id).order('sort').order('id')).catch(() => []),
      showInv ? q(supabase.from('invoices').select('*').eq('project_id', id).order('issue_date', { ascending: false })) : Promise.resolve([]),
      q(supabase.from('client_files').select('*').eq('project_id', id).order('created_at', { ascending: false })),
    ]);
    const totals = new Map();
    if (tasks.length) {
      const tt = await q(supabase.from('task_time_totals').select('task_id, total_seconds, running').in('task_id', tasks.map((t) => t.id))).catch(() => []);
      tt.forEach((r) => { const x = totals.get(r.task_id) || { total: 0, running: false }; x.total += r.total_seconds; x.running ||= r.running; totals.set(r.task_id, x); });
    }
    data = { p, dir, all, rows, tasks, reqs, invoices, files, totals, showInv };
    draw();
  }

  function draw() {
    if (!el.isConnected || !data) return;
    const { p, dir, all, rows, tasks, reqs, invoices, files, totals, showInv } = data;
    const manage = canEditProject(p);
    const team = rows.filter((r) => r.status === 'approved');
    const pending = rows.filter((r) => r.status === 'pending');
    const toApprove = pending.filter((r) => canDecide(r, p));
    if (tab === 'team') tab = manage ? 'settings' : 'overview';
    if (tab === 'invoices') tab = 'finances';
    const tabs = [
      ['overview', 'Overview', 'dashboard'],
      ['live', 'Live view', 'eye'],
      ['requirements', `Requirements${reqs.length ? ` ${reqs.filter((r) => r.is_done).length}/${reqs.length}` : ''}`, 'list'],
      ['tasks', `Tasks${tasks.length ? ` ${tasks.length}` : ''}`, 'tasks'],
      ['files', `Files${files.length ? ` ${files.length}` : ''}`, 'file'],
      showInv && ['finances', 'Finances', 'wallet'],
      manage && ['settings', `Settings${toApprove.length ? ' •' : ''}`, 'settings'],
    ].filter(Boolean);
    if (!tabs.some(([k]) => k === tab)) tab = 'overview';
    setTitle?.(p.name);
    const pmL = dirLabel(dir, p.project_manager, state.roles);
    const c = p.client || {};

    let body = '';
    if (tab === 'overview') body = overview();
    else if (tab === 'live') body = live();
    else if (tab === 'requirements') body = requirements();
    else if (tab === 'tasks') body = taskBoard();
    else if (tab === 'files') body = filesTab();
    else if (tab === 'finances') body = finances();
    else body = settings();

    el.innerHTML = `
      <div class="ws-head">
        <div class="ws-switch-wrap">
          <button class="ws-switch" id="ws-switch" aria-haspopup="listbox" aria-expanded="false" title="Switch project">
            <span class="pc-mark">${esc(projectInitials(p.name))}</span>
            <span class="ws-title"><small>${esc(c.name || 'Client')}</small><b>${esc(p.name)}</b></span>
            <span class="ws-chev">${icon('chevronR', 16)}</span>
          </button>
          <div class="ws-meta">${projectBadge(p.status)}
            <span>${icon('user', 13)}${pmL ? `${esc(pmL.name)} <span class="muted">(PM)</span>` : '<span class="muted">No project manager yet</span>'}</span>
            ${p.due_date ? `<span class="due ${p.due_date < todayStr() && isOpen(p) ? 'over' : ''}">${icon('calendar', 12)}Due ${esc(fmtDate(p.due_date))}</span>` : ''}
            <span>${icon('users', 13)}${team.length} on the team</span>
          </div>
        </div>
        <div class="actions">
          ${p.website_url ? `<a class="btn" href="${esc(p.website_url)}" target="_blank" rel="noopener">${icon('link', 14)}Open live site</a>` : ''}
          ${manage && isOpen(p) ? `<button class="btn btn-primary" data-new-task>${icon('plus', 14)}New task</button>` : ''}
        </div>
      </div>
      ${toApprove.length && tab !== 'settings' ? `<div class="note warn" style="margin-bottom:14px">${toApprove.length} team request(s) need your approval. <button class="linkish" data-goto="settings">Review in Settings</button></div>` : ''}
      <div class="tabs-line ws-tabs" role="tablist">${tabs.map(([k, v, ic]) => `<button data-tab="${k}" aria-pressed="${tab === k}">${icon(ic, 14)}${esc(v)}</button>`).join('')}</div>
      <div class="ws-body">${body}</div>`;
    bind();

    // ----- tab bodies -----
    function overview() {
      const done = tasks.filter((t) => t.status === 'completed').length;
      const reqDone = reqs.filter((r) => r.is_done).length;
      const time = [...totals.values()].reduce((a, x) => a + x.total, 0);
      const byStatus = Object.keys(STATUS_LABEL).map((s) => [s, tasks.filter((t) => t.status === s).length]);
      const paid = invoices.filter((i) => i.status === 'paid').reduce((a, i) => a + Number(i.amount), 0);
      const open = reqs.filter((r) => !r.is_done).slice(0, 5);
      return `
        <div class="stats"><div class="stat-group">
          <div class="stat"><div class="v">${done}/${tasks.length}</div><div class="k">Tasks done</div></div>
          <div class="stat"><div class="v">${reqDone}/${reqs.length}</div><div class="k">Requirements met</div></div>
          <div class="stat"><div class="v">${fmtDuration(time)}</div><div class="k"><i class="timer"></i>Time on tasks</div></div>
          ${showInv ? `<div class="stat"><div class="v" style="color:#15803D">${money(paid)}</div><div class="k">Paid so far</div></div>` : `<div class="stat"><div class="v">${team.length}</div><div class="k">On the team</div></div>`}
        </div></div>
        <div class="grid-3-1" style="margin-top:18px">
          <div class="stack">
            <section class="panel"><div class="panel-head"><h2>Scope</h2>${manage ? '<button class="btn btn-sm btn-ghost" data-goto="settings">Edit</button>' : ''}</div>
              <div class="panel-body">${p.description ? `<div class="desc">${esc(p.description)}</div>` : '<p class="muted small">No scope written yet.</p>'}</div></section>
            <section class="panel"><div class="panel-head"><h2>Open requirements</h2><button class="btn btn-sm btn-ghost" data-goto="requirements">See all</button></div>
              <div class="list">${open.length ? open.map((r) => `<div class="list-item" style="padding:10px 16px">${icon('flag', 14)}<div class="grow"><div class="title">${esc(r.title)}</div></div></div>`).join('')
                : `<div class="panel-body"><p class="muted small">${reqs.length ? 'Every requirement is met.' : 'No requirements added yet.'}</p></div>`}</div></section>
            <section class="panel"><div class="panel-head"><h2>Work</h2><button class="btn btn-sm btn-ghost" data-goto="tasks">Open board</button></div>
              <div class="panel-body"><div class="ws-status-row">${byStatus.map(([s, n]) => `<div><span class="board-col-head" style="padding:0"><i class="${s}"></i>${esc(STATUS_LABEL[s])}</span><b>${n}</b></div>`).join('')}</div></div></section>
          </div>
          <div class="stack">
            ${p.website_url ? `<a class="panel ws-mini" href="#" data-goto="live"><img src="${shot(p.website_url, 600)}" alt="Preview of ${esc(hostOf(p.website_url))}" loading="lazy" onerror="this.remove()"><div class="panel-body small"><b>${esc(hostOf(p.website_url))}</b><div class="muted">Open live view</div></div></a>` : ''}
            <section class="panel"><div class="panel-body">
              <dl class="kv" style="grid-template-columns:100px 1fr">
                <dt>Client</dt><dd>${esc(c.name || '—')}${c.id && canAny('clients') ? ` <a class="small" href="#/clients?open=${c.id}">Open</a>` : ''}</dd>
                <dt>Contact</dt><dd>${esc(c.contact_name || '—')}</dd>
                <dt>Email</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</dd>
                <dt>Phone</dt><dd>${esc(c.phone || '—')}</dd>
                <dt>Start</dt><dd>${esc(fmtDate(p.start_date))}</dd>
                <dt>Due</dt><dd>${esc(fmtDate(p.due_date))}</dd>
              </dl></div></section>
            <section class="panel"><div class="panel-head"><h2>Team</h2>${manage ? '<button class="btn btn-sm btn-ghost" data-goto="settings">Manage</button>' : ''}</div>
              <div class="list">
                ${p.project_manager ? `<div class="list-item" style="padding:10px 16px"><span class="mini-av">${esc((pmL?.name || '?')[0])}</span><div class="grow"><div class="title">${esc(pmL?.name || '')}</div><div class="meta">Project manager</div></div></div>` : ''}
                ${team.map((r) => `<div class="list-item" style="padding:10px 16px"><span class="mini-av">${esc((dirName(dir, r.member_id) || '?')[0])}</span><div class="grow"><div class="title">${esc(dirName(dir, r.member_id))}</div><div class="meta">${esc(r.role_label)}</div></div></div>`).join('')}
                ${!p.project_manager && !team.length ? '<div class="panel-body"><p class="muted small">Nobody yet.</p></div>' : ''}
                ${pending.length ? `<div class="panel-body small muted" style="padding-top:8px">${pending.length} waiting for approval</div>` : ''}
              </div></section>
          </div>
        </div>`;
    }

    function live() {
      const socials = SOCIALS.map(([k, label, abbr]) => ({ k, label, abbr, url: socialUrl(k, p.socials?.[k]) })).filter((s) => s.url);
      if (!p.website_url && !socials.length) {
        return `<div class="panel">${emptyState('No website or social links yet', manage ? 'Add the client\'s website and social pages in Settings to see them here.' : 'The project manager adds the website and social pages.', manage ? '<button class="btn btn-primary" data-goto="settings">Add links</button>' : '')}</div>`;
      }
      return `
        ${p.website_url ? `<section class="panel">
          <div class="panel-head"><div><h2>Website</h2><p>${esc(hostOf(p.website_url))}</p></div>
            <div class="row wrap">
              <div class="seg" role="group" aria-label="Preview mode"><button data-live="shot" aria-pressed="${liveMode === 'shot'}">Snapshot</button><button data-live="frame" aria-pressed="${liveMode === 'frame'}">Live</button></div>
              ${liveMode === 'shot' ? `<button class="btn btn-sm btn-ghost" data-refresh-shot title="Take a fresh snapshot">${icon('refresh', 13)}Refresh</button>` : ''}
              <a class="btn btn-sm btn-primary" href="${esc(p.website_url)}" target="_blank" rel="noopener">${icon('link', 13)}Open site</a>
            </div></div>
          <div class="browser">
            <div class="browser-bar"><i></i><i></i><i></i><span>${esc(p.website_url)}</span></div>
            ${liveMode === 'frame'
              ? `<iframe src="${esc(p.website_url)}" title="Live view of ${esc(hostOf(p.website_url))}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`
              : `<a href="${esc(p.website_url)}" target="_blank" rel="noopener" class="browser-shot"><img src="${shot(p.website_url)}${shotBust}" alt="Snapshot of ${esc(hostOf(p.website_url))}" loading="lazy" onerror="this.parentNode.classList.add('noimg')"></a>`}
          </div>
          <p class="small muted" style="padding:10px 16px 14px">${liveMode === 'frame' ? 'If this stays blank, the site doesn\'t allow being shown inside other apps. Use Open site.' : 'A fresh snapshot can take up to a minute the first time. Click it to open the site.'}</p>
        </section>` : ''}
        ${socials.length ? `<div class="section-title" style="margin-top:20px">Social pages</div>
          <div class="social-grid">${socials.map((s) => `
            <a class="social-card" href="${esc(s.url)}" target="_blank" rel="noopener">
              <div class="sc-shot"><img src="${shot(s.url, 800)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('none')"><span class="sc-badge ${s.k}">${esc(s.abbr)}</span></div>
              <div class="sc-body"><b>${esc(s.label)}</b><span>${esc(s.url.replace(/^https?:\/\/(www\.)?/, ''))}</span></div>
              <span class="sc-open">${icon('link', 13)}Open</span>
            </a>`).join('')}</div>` : ''}`;
    }

    function requirements() {
      const done = reqs.filter((r) => r.is_done).length;
      const pct = reqs.length ? Math.round((done / reqs.length) * 100) : 0;
      return `
        <section class="panel">
          <div class="panel-head"><div><h2>Requirements</h2><p>${reqs.length ? `${done} of ${reqs.length} met` : 'What the client needs from this project'}</p></div>
            ${reqs.length ? `<div class="proj-progress" style="width:160px"><i style="width:${pct}%"></i></div>` : ''}</div>
          ${manage ? `<form class="req-add" id="req-form">
            <input class="input" id="req-title" maxlength="300" placeholder="Add a requirement, e.g. Homepage with a sale banner" aria-label="New requirement">
            <button class="btn btn-primary" type="submit">${icon('plus', 14)}Add</button>
            <textarea class="textarea" id="req-details" placeholder="Details, links, references (optional)" rows="2"></textarea>
          </form>` : ''}
          <div class="list">${reqs.length ? reqs.map((r) => `
            <div class="list-item req-item ${r.is_done ? 'done' : ''}">
              <label class="req-check"><input type="checkbox" data-req-done="${r.id}" ${r.is_done ? 'checked' : ''} ${manage ? '' : 'disabled'} aria-label="Mark ${esc(r.title)} as met"></label>
              <div class="grow"><div class="title">${esc(r.title)}</div>
                ${r.details ? `<div class="desc small" style="margin-top:4px">${esc(r.details)}</div>` : ''}
                <div class="meta"><span>Added by ${esc(dirName(dir, r.created_by) || '—')} ${esc(fmtDateOfIso(r.created_at))}</span>${r.is_done ? `<span style="color:#15803D">Met${r.done_by ? `, ${esc(dirName(dir, r.done_by))}` : ''}${r.done_at ? ` ${esc(fmtRelative(r.done_at))}` : ''}</span>` : ''}</div></div>
              ${manage ? `<button class="btn btn-sm btn-ghost btn-icon" data-req-edit="${r.id}" aria-label="Edit requirement">${icon('edit', 13)}</button>
                <button class="btn btn-sm btn-ghost btn-icon btn-danger" data-req-del="${r.id}" aria-label="Delete requirement">${icon('trash', 13)}</button>` : ''}
            </div>`).join('') : `<div class="panel-body">${emptyState('No requirements yet', manage ? 'Write down everything the client asked for, then tick each one off.' : '')}</div>`}</div>
        </section>`;
    }

    function taskBoard() {
      const people = [...new Set(tasks.map((t) => t.assigned_to).filter(Boolean))];
      const list = tasks.filter((t) => !taskMember || t.assigned_to === taskMember);
      const card = (t) => {
        const tt = totals.get(t.id);
        return `<button class="tcard" data-task="${t.id}"><span class="t">${esc(t.title)}</span>
          <span class="meta">${prioTag(t.priority)}${t.due_date && t.status !== 'completed' ? `<span class="due ${dueState(t)}">${esc(dueLabel(t.due_date))}</span>` : ''}</span>
          <span class="foot"><span class="who small"><span>${esc(dirName(dir, t.assigned_to) || 'Unassigned')}</span></span>${tt?.total ? `<span class="tracked ${tt.running ? 'live' : ''}">${icon('clock', 12)}${fmtDuration(tt.total)}</span>` : ''}</span></button>`;
      };
      return `
        <div class="toolbar">
          <p class="muted small grow" style="margin:0">Tasks for this project live here. ${state.isAdmin ? 'They don\'t show on the main Tasks page.' : ''}</p>
          ${people.length > 1 ? `<select class="select" id="task-member" style="width:auto" aria-label="Filter by person"><option value="">Everyone</option>${people.map((pid) => `<option value="${pid}" ${taskMember === pid ? 'selected' : ''}>${esc(dirName(dir, pid))}</option>`).join('')}</select>` : ''}
          ${manage && isOpen(p) ? `<button class="btn btn-primary" data-new-task>${icon('plus', 14)}New task</button>` : ''}
        </div>
        ${tasks.length ? `<div class="board">${Object.keys(STATUS_LABEL).map((s) => {
          const items = list.filter((t) => t.status === s);
          return `<div class="board-col"><div class="board-col-head"><i class="${s}"></i>${STATUS_LABEL[s]}<span class="count">${items.length}</span></div>${items.map(card).join('') || '<div class="board-empty">Nothing here</div>'}</div>`;
        }).join('')}</div>` : `<div class="panel">${emptyState('No tasks yet', manage ? (team.length ? 'Create a task and give it to someone on the team.' : 'Add people to the team in Settings, then give them tasks.') : 'Tasks for this project show up here.')}</div>`}`;
    }

    function filesTab() {
      return `
        ${canFileP(p, 'edit') ? `<div class="panel" style="margin-bottom:14px"><div class="panel-body stack" style="gap:10px">
          <div class="section-title" style="margin:0">Upload a file</div>
          <div class="row wrap"><select class="select select-sm" id="f-kind" style="width:auto">${Object.entries(FILE_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <input type="file" id="f-file" aria-label="File" style="flex:1;min-width:180px"><button class="btn btn-sm btn-primary" data-upload>${icon('upload', 13)}Upload</button></div>
          <span class="hint small muted">Briefs, contracts, brand assets. Up to 25 MB. The project team can open them.</span></div></div>` : ''}
        ${files.length ? `<div class="panel"><div>${files.map((f) => `
          <div class="file-row">${icon('file', 18)}<div class="grow"><div class="title">${esc(f.name)}</div>
            <div class="small muted">${esc(FILE_KINDS[f.kind] || f.kind)}, ${f.size_bytes ? (f.size_bytes / 1048576).toFixed(1) + ' MB, ' : ''}${esc(dirName(dir, f.uploaded_by) || '')} ${esc(fmtDateOfIso(f.created_at))}</div></div>
            <button class="btn btn-sm" data-open-file="${esc(f.storage_path)}">${icon('download', 13)}Open</button>
            ${canFileP(p, 'delete') ? `<button class="btn btn-sm btn-ghost btn-icon btn-danger" data-del-file="${f.id}" aria-label="Delete file">${icon('trash', 13)}</button>` : ''}
          </div>`).join('')}</div></div>` : `<div class="panel">${emptyState('No files on this project yet')}</div>`}`;
    }

    function finances() {
      const paid = invoices.filter((i) => i.status === 'paid').reduce((a, i) => a + Number(i.amount), 0);
      const due = invoices.filter((i) => i.status === 'sent').reduce((a, i) => a + Number(i.amount), 0);
      return `
        <div class="stats" style="margin-bottom:14px"><div class="stat-group">
          <div class="stat"><div class="v" style="color:#15803D">${money(paid)}</div><div class="k">Paid</div></div>
          <div class="stat"><div class="v">${money(due)}</div><div class="k">Unpaid</div></div>
          <div class="stat"><div class="v">${invoices.length}</div><div class="k">Invoices</div></div></div></div>
        <section class="panel"><div class="panel-head"><h2>Invoices</h2>${canInvP(p, 'edit') ? `<button class="btn btn-sm btn-primary" data-new-inv>${icon('plus', 13)}New invoice</button>` : ''}</div>
        ${invoices.length ? `<div class="list">${invoices.map((i) => `
          <div class="list-item" style="padding:11px 16px;flex-wrap:wrap">
            <div class="grow" style="min-width:180px"><div class="title">${esc(i.invoice_number || `Invoice #${i.id}`)} <span class="money" style="font-weight:600;margin-left:6px">${money(i.amount)}</span></div>
              <div class="meta"><span>Issued ${esc(fmtDate(i.issue_date))}</span>${i.due_date ? `<span>Due ${esc(fmtDate(i.due_date))}</span>` : ''}${i.paid_date ? `<span>Paid ${esc(fmtDate(i.paid_date))}</span>` : ''}${i.description ? `<span>${esc(i.description)}</span>` : ''}</div></div>
            <span class="badge ${i.status === 'sent' && i.due_date && i.due_date < todayStr() ? 'overdue' : esc(i.status)}">${i.status === 'sent' ? (i.due_date && i.due_date < todayStr() ? 'Overdue' : 'Unpaid') : esc(i.status[0].toUpperCase() + i.status.slice(1))}</span>
            ${canInvP(p, 'edit') && i.status === 'sent' ? `<button class="btn btn-sm" data-paid="${i.id}">${icon('check', 13)}Mark paid</button>` : ''}
            ${canInvP(p, 'edit') ? `<button class="btn btn-sm btn-ghost btn-icon" data-edit-inv="${i.id}" aria-label="Edit invoice">${icon('edit', 13)}</button>` : ''}
          </div>`).join('')}</div>` : `<div class="panel-body">${emptyState('No invoices for this project yet')}</div>`}</section>`;
    }

    function settings() {
      const taken = new Set([...team, ...pending].map((r) => r.member_id).concat(p.project_manager ? [p.project_manager] : []));
      const roles = roleOptions(dir, { exclude: taken });
      const mode = addMode(p);
      const so = p.socials || {};
      return `
        <div class="grid-2">
          <section class="panel"><div class="panel-head"><h2>Project details</h2></div><div class="panel-body">
            <form id="ps" class="form-grid" novalidate>
              <div class="field span-2"><label for="ps-name">Project name</label><input id="ps-name" class="input" maxlength="200" value="${esc(p.name)}"></div>
              <div class="field"><label for="ps-status">Status</label><select id="ps-status" class="select">${Object.entries(PROJECT_STATUS).map(([k, v]) => `<option value="${k}" ${p.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
              <div class="field"><label for="ps-pm">Project manager</label><select id="ps-pm" class="select" ${can('projects', 'edit') ? '' : 'disabled'}><option value="">Not assigned</option>${dir.filter((d) => d.roles.includes('project_manager') && d.status !== 'inactive').map((d) => `<option value="${d.id}" ${p.project_manager === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
                ${can('projects', 'edit') ? '' : '<span class="hint">Only the admin or a manager can change this.</span>'}</div>
              <div class="field"><label for="ps-start">Start date</label><input id="ps-start" class="input" type="date" value="${esc(p.start_date || '')}"></div>
              <div class="field"><label for="ps-due">Due date</label><input id="ps-due" class="input" type="date" value="${esc(p.due_date || '')}"></div>
              <div class="field span-2"><label for="ps-web">Website</label><input id="ps-web" class="input" maxlength="300" value="${esc(p.website_url || '')}" placeholder="glowco.com"><span class="hint">Shows a live preview in Live view.</span></div>
              ${SOCIALS.map(([k, label]) => `<div class="field"><label for="ps-s-${k}">${label}</label><input id="ps-s-${k}" class="input" maxlength="300" value="${esc(so[k] || '')}" placeholder="@handle or link"></div>`).join('')}
              <div class="field span-2"><label for="ps-desc">Scope / notes</label><textarea id="ps-desc" class="textarea" rows="4">${esc(p.description || '')}</textarea></div>
              <div class="form-error hidden span-2" id="ps-err"></div>
              <div class="span-2 row" style="justify-content:space-between">
                ${canDeleteProject(p) ? `<button type="button" class="btn btn-ghost btn-danger" data-delete>${icon('trash', 14)}Delete project</button>` : '<span></span>'}
                <button class="btn btn-primary" type="submit">Save details</button></div>
            </form></div></section>

          <div class="stack">
            <section class="panel"><div class="panel-head"><div><h2>Add someone to the team</h2><p>Pick the role you need help with, then the person.</p></div></div>
              <div class="panel-body stack" style="gap:12px">
              ${isOpen(p) ? `
                <div class="field"><label for="tm-role">1. Role</label>
                  <select id="tm-role" class="select"><option value="">Choose a role</option>${roles.map((r) => `<option value="${esc(r.title)}" ${r.people.length ? '' : 'disabled'}>${esc(r.title)} (${r.people.length ? `${r.people.length} ${r.people.length === 1 ? 'person' : 'people'}` : 'nobody yet'})</option>`).join('')}</select></div>
                <div class="field"><label for="tm-member">2. Person</label>
                  <select id="tm-member" class="select" disabled><option value="">Choose a role first</option></select></div>
                <p class="small muted" style="margin:0">${icon('shield', 12)} ${esc(mode.hint)} ${state.isAdmin ? '' : 'You can only pick people the admin or a manager has already added on the Team page.'}</p>
                <div><button class="btn btn-primary" data-add-member disabled>${icon('userPlus', 14)}${esc(mode.label)}</button></div>`
                : '<p class="muted small">This project is closed. Set it back to Active to add people.</p>'}
              </div></section>

            ${pending.length ? `<section class="panel"><div class="panel-head"><h2>Waiting for approval</h2></div><div class="list">${pending.map((r) => `
              <div class="list-item" style="padding:10px 16px;flex-wrap:wrap"><span class="mini-av">${esc((dirName(dir, r.member_id) || '?')[0])}</span>
                <div class="grow" style="min-width:170px"><div class="title">${esc(dirName(dir, r.member_id) || 'Member')}</div>
                  <div class="meta"><span>${esc(r.role_label)}</span><span>Asked by ${esc(dirName(dir, r.requested_by))} ${esc(fmtRelative(r.requested_at))}</span><span>Needs ${esc(approverText(r, p, dir))}</span></div></div>
                ${canDecide(r, p) ? `<button class="btn btn-sm" data-reject="${r.id}">${icon('x', 13)}Reject</button><button class="btn btn-sm btn-primary" data-approve="${r.id}">${icon('check', 13)}Approve</button>` : ''}
                ${canCancel(r) && !canDecide(r, p) ? `<button class="btn btn-sm btn-ghost" data-cancel-req="${r.id}">Cancel request</button>` : ''}
              </div>`).join('')}</div></section>` : ''}

            <section class="panel"><div class="panel-head"><h2>Team</h2><span class="muted small">${team.length} ${team.length === 1 ? 'person' : 'people'}</span></div><div class="list">
              ${p.project_manager ? `<div class="list-item" style="padding:10px 16px"><span class="mini-av">${esc((pmL?.name || '?')[0])}</span><div class="grow"><div class="title">${esc(pmL?.name || '')}</div><div class="meta">Project manager</div></div></div>` : ''}
              ${team.map((r) => `<div class="list-item" style="padding:10px 16px;flex-wrap:wrap"><span class="mini-av">${esc((dirName(dir, r.member_id) || '?')[0])}</span>
                <div class="grow" style="min-width:160px"><div class="title">${esc(dirName(dir, r.member_id))}</div><div class="meta"><span>${esc(r.role_label)}</span><span>${r.approver === 'auto' ? 'Added' : 'Approved'} by ${esc(dirName(dir, r.decided_by) || 'admin')}</span></div></div>
                ${isOpen(p) ? `<button class="btn btn-sm" data-assign="${r.member_id}">${icon('plus', 13)}Task</button>` : ''}
                <button class="btn btn-sm btn-ghost btn-icon btn-danger" data-remove="${r.id}" aria-label="Remove from project">${icon('x', 13)}</button></div>`).join('')}
              ${!team.length ? '<div class="panel-body"><p class="muted small">Nobody on the team yet.</p></div>' : ''}
            </div></section>

            ${rows.length ? `<section class="panel"><div class="panel-head"><h2><span class="row" style="gap:6px">${icon('history', 15)}History</span></h2></div><div class="panel-body">${historyHtml(rows, dir)}</div></section>` : ''}
          </div>
        </div>`;
    }

    // ----- events -----
    function bind() {
      el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => go(b.dataset.tab));
      el.querySelectorAll('[data-goto]').forEach((b) => b.onclick = (e) => { e.preventDefault(); go(b.dataset.goto); });
      el.querySelector('#ws-switch').onclick = (e) => openSwitcher(e.currentTarget, all, p.id);
      el.querySelectorAll('[data-new-task], [data-assign]').forEach((b) => b.onclick = async () => {
        const { openTaskForm } = await import('../task-drawer.js');
        const opts = team.map((t) => ({ id: t.member_id, first_name: `${dirName(dir, t.member_id)} (${t.role_label})`, last_name: '', roles: [], status: 'active' }));
        if (p.project_manager) opts.unshift({ id: p.project_manager, first_name: `${dirName(dir, p.project_manager)} (project manager)`, last_name: '', roles: [], status: 'active' });
        openTaskForm({ projectId: id, projectName: p.name, clientId: p.client_id, memberOptions: opts, presetMember: b.dataset.assign || null, onSaved: () => { tab = 'tasks'; changed(); } });
      });
      el.querySelectorAll('[data-task]').forEach((x) => x.onclick = async () => (await import('../task-drawer.js')).openTaskDrawer(Number(x.dataset.task)));
      el.querySelector('#task-member')?.addEventListener('change', (e) => { taskMember = e.target.value; draw(); });

      // live view
      el.querySelectorAll('[data-live]').forEach((b) => b.onclick = () => { liveMode = b.dataset.live; draw(); });
      el.querySelector('[data-refresh-shot]')?.addEventListener('click', () => { shotBust = `&r=${Date.now()}`; draw(); });

      // requirements
      el.querySelector('#req-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const title = el.querySelector('#req-title').value.trim();
        if (!title) return toast('Write the requirement first', 'error');
        busy(e.submitter || el.querySelector('#req-form button'), async () => {
          try {
            await q(supabase.from('project_requirements').insert({ project_id: id, title, details: el.querySelector('#req-details').value.trim(), sort: reqs.length }));
            toast('Requirement added'); changed();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
      el.querySelectorAll('[data-req-done]').forEach((cb) => cb.onchange = async () => {
        cb.disabled = true;
        try { await q(supabase.from('project_requirements').update({ is_done: cb.checked }).eq('id', Number(cb.dataset.reqDone))); changed(); }
        catch (err) { toast(err.message, 'error'); cb.checked = !cb.checked; cb.disabled = false; }
      });
      el.querySelectorAll('[data-req-edit]').forEach((b) => b.onclick = () => editRequirement(reqs.find((r) => r.id === Number(b.dataset.reqEdit))));
      el.querySelectorAll('[data-req-del]').forEach((b) => b.onclick = async () => {
        const r = reqs.find((x) => x.id === Number(b.dataset.reqDel));
        if (!await confirmDialog({ title: 'Delete this requirement?', text: r.title, confirm: 'Delete', danger: true })) return;
        try { await q(supabase.from('project_requirements').delete().eq('id', r.id)); toast('Requirement deleted'); changed(); } catch (err) { toast(err.message, 'error'); }
      });

      // files
      el.querySelectorAll('[data-open-file]').forEach((b) => b.onclick = () => busy(b, async () => {
        const { data: d, error } = await supabase.storage.from('client-files').createSignedUrl(b.dataset.openFile, 120);
        if (error) return toast(error.message, 'error');
        window.open(d.signedUrl, '_blank', 'noopener');
      }));
      el.querySelectorAll('[data-del-file]').forEach((b) => b.onclick = async () => {
        const f = files.find((x) => x.id === Number(b.dataset.delFile));
        if (!await confirmDialog({ title: `Delete ${f.name}?`, confirm: 'Delete file', danger: true })) return;
        try {
          await supabase.storage.from('client-files').remove([f.storage_path]);
          await q(supabase.from('client_files').delete().eq('id', f.id));
          toast('File deleted'); changed();
        } catch (e) { toast(e.message, 'error'); }
      });
      el.querySelector('[data-upload]')?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
        const file = el.querySelector('#f-file').files[0];
        if (!file) return toast('Choose a file first', 'error');
        if (file.size > 25 * 1048576) return toast('Files can be up to 25 MB', 'error');
        const safeName = file.name.replace(/[^\w.\-]+/g, '_').slice(-120);
        const path = `${p.client_id}/p${id}/${crypto.randomUUID()}-${safeName}`;
        const up = await supabase.storage.from('client-files').upload(path, file, { contentType: file.type || 'application/octet-stream' });
        if (up.error) return toast(up.error.message, 'error');
        try {
          await q(supabase.from('client_files').insert({ client_id: p.client_id, project_id: id, kind: el.querySelector('#f-kind').value, name: file.name.slice(0, 200), storage_path: path, size_bytes: file.size }));
          toast('File uploaded'); changed();
        } catch (err) { await supabase.storage.from('client-files').remove([path]); toast(err.message, 'error'); }
      }));

      // finances
      el.querySelector('[data-new-inv]')?.addEventListener('click', async () => (await import('./clients.js')).openInvoiceForm({ clientId: p.client_id, projectId: id }));
      el.querySelectorAll('[data-edit-inv]').forEach((b) => b.onclick = async () => (await import('./clients.js')).openInvoiceForm({ clientId: p.client_id, projectId: id, invoice: invoices.find((i) => i.id === Number(b.dataset.editInv)) }));
      el.querySelectorAll('[data-paid]').forEach((b) => b.onclick = () => busy(b, async () => {
        try { await q(supabase.from('invoices').update({ status: 'paid' }).eq('id', Number(b.dataset.paid))); toast('Marked as paid'); changed(); } catch (e) { toast(e.message, 'error'); }
      }));

      // settings: details
      el.querySelector('#ps')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const f = e.currentTarget; const err = f.querySelector('#ps-err');
        const v = (sel) => f.querySelector(sel).value.trim();
        const socials = {};
        SOCIALS.forEach(([k]) => { const x = v(`#ps-s-${k}`); if (x) socials[k] = x; });
        const payload = { name: v('#ps-name'), status: v('#ps-status'), start_date: v('#ps-start') || null, due_date: v('#ps-due') || null,
          website_url: normalizeUrl(v('#ps-web')), socials, description: v('#ps-desc') };
        if (can('projects', 'edit')) payload.project_manager = v('#ps-pm') || null;
        err.classList.add('hidden');
        if (!payload.name) { err.textContent = 'Give the project a name.'; err.classList.remove('hidden'); return; }
        if (payload.start_date && payload.due_date && payload.due_date < payload.start_date) { err.textContent = 'The due date is before the start date.'; err.classList.remove('hidden'); return; }
        busy(f.querySelector('[type=submit]'), async () => {
          try { await q(supabase.from('projects').update(payload).eq('id', id)); toast('Project saved'); changed(); }
          catch (x) { err.textContent = x.message; err.classList.remove('hidden'); }
        });
      });
      el.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!await confirmDialog({ title: `Delete ${p.name}?`, text: 'The team list, requests and requirements are deleted. Tasks, invoices and files stay with the client.', confirm: 'Delete project', danger: true })) return;
        try { await q(supabase.from('projects').delete().eq('id', id)); toast('Project deleted'); location.hash = '#/projects'; } catch (e) { toast(e.message, 'error'); }
      });

      // settings: team
      const roleSel = el.querySelector('#tm-role'); const memSel = el.querySelector('#tm-member'); const addBtn = el.querySelector('[data-add-member]');
      roleSel?.addEventListener('change', () => {
        const r = roleOptions(dir, { exclude: new Set([...team, ...pending].map((x) => x.member_id).concat(p.project_manager ? [p.project_manager] : [])) }).find((x) => x.title === roleSel.value);
        memSel.innerHTML = r ? `<option value="">Choose a ${esc(r.title)}</option>${r.people.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}` : '<option value="">Choose a role first</option>';
        memSel.disabled = !r; addBtn.disabled = true;
      });
      memSel?.addEventListener('change', () => { addBtn.disabled = !memSel.value; });
      addBtn?.addEventListener('click', (e) => busy(e.currentTarget, async () => {
        if (!memSel.value) return toast('Choose a person', 'error');
        await requestAdd(p, memSel.value, roleSel.value);
      }));
      el.querySelectorAll('[data-approve]').forEach((b) => b.onclick = () => decide(b, Number(b.dataset.approve), true, rows, dir));
      el.querySelectorAll('[data-reject]').forEach((b) => b.onclick = () => decide(b, Number(b.dataset.reject), false, rows, dir));
      el.querySelectorAll('[data-cancel-req]').forEach((b) => b.onclick = async () => {
        if (!await confirmDialog({ title: 'Cancel this request?', confirm: 'Cancel request', danger: true })) return;
        try { await rpc('project_member_cancel', { p_id: Number(b.dataset.cancelReq) }); toast('Request cancelled'); changed(); } catch (e) { toast(e.message, 'error'); }
      });
      el.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => {
        const r = rows.find((x) => x.id === Number(b.dataset.remove));
        if (!await confirmDialog({ title: `Remove ${dirName(dir, r.member_id)} from ${p.name}?`, text: 'Their existing tasks stay. This shows in the history.', confirm: 'Remove', danger: true })) return;
        try { await rpc('project_member_remove', { p_id: r.id }); toast('Removed from the project'); changed(); } catch (e) { toast(e.message, 'error'); }
      });
    }
  }

  function go(next) {
    tab = next;
    try { history.replaceState(null, '', `#/project/${id}${tab === 'overview' ? '' : `?tab=${tab}`}`); } catch { /* ignore */ }
    draw();
    window.scrollTo(0, 0);
  }

  function editRequirement(r) {
    const m = openModal({
      title: 'Edit requirement',
      body: `<form id="re" class="form-grid" novalidate>
        <div class="field span-2"><label for="re-title">Requirement</label><input id="re-title" class="input" maxlength="300" value="${esc(r.title)}"></div>
        <div class="field span-2"><label for="re-details">Details</label><textarea id="re-details" class="textarea">${esc(r.details || '')}</textarea></div></form>`,
      foot: '<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>Save</button>',
    });
    m.querySelector('[data-cancel]').onclick = () => m.close();
    m.querySelector('[data-save]').onclick = (e) => busy(e.currentTarget, async () => {
      const title = m.querySelector('#re-title').value.trim();
      if (!title) return toast('Write the requirement', 'error');
      try { await q(supabase.from('project_requirements').update({ title, details: m.querySelector('#re-details').value.trim() }).eq('id', r.id)); toast('Saved'); m.close(); changed(); }
      catch (err) { toast(err.message, 'error'); }
    });
  }

  const reload = () => load().catch((e) => toast(e.message, 'error'));
  await load().catch((e) => { el.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
  window.addEventListener('ehos:data-changed', reload);
  return () => { window.removeEventListener('ehos:data-changed', reload); closeSwitcher(); };
}

// ---------- Project switcher (top left) ----------
let switcher = null;
function closeSwitcher() {
  if (!switcher) return;
  switcher.el.remove(); switcher.btn?.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', switcher.outside, true); document.removeEventListener('keydown', switcher.key);
  switcher = null;
}
function openSwitcher(btn, all, current) {
  if (switcher) return closeSwitcher();
  const el = document.createElement('div');
  el.className = 'ws-pop'; el.setAttribute('role', 'listbox');
  const r = btn.getBoundingClientRect();
  el.style.top = `${r.bottom + window.scrollY + 6}px`; el.style.left = `${Math.max(12, r.left + window.scrollX)}px`;
  const list = (s = '') => all.filter((p) => !s || `${p.name} ${p.client?.name || ''}`.toLowerCase().includes(s.toLowerCase()));
  const items = (s) => list(s).map((p) => `
    <a role="option" href="#/project/${p.id}" aria-selected="${p.id === current}" class="${p.id === current ? 'on' : ''}">
      <span class="pc-mark sm">${esc(projectInitials(p.name))}</span><span class="grow"><b>${esc(p.name)}</b><small>${esc(p.client?.name || '')}${p.project_manager === state.profile.id ? ' · You run this' : ''}</small></span>
      ${p.id === current ? icon('check', 14) : `<span class="badge ${esc(p.status)}">${esc(PROJECT_STATUS[p.status])}</span>`}</a>`).join('') || '<div class="small muted" style="padding:12px">No projects match</div>';
  el.innerHTML = `<div class="ws-pop-head">${all.length > 6 ? `<div class="search">${icon('search', 14)}<input class="input" placeholder="Find a project" aria-label="Find a project"></div>` : '<span class="small muted">Switch project</span>'}</div>
    <div class="ws-pop-list">${items('')}</div>
    <a class="ws-pop-foot" href="#/projects">${icon('folder', 14)}All projects</a>`;
  document.body.append(el);
  btn.setAttribute('aria-expanded', 'true');
  const input = el.querySelector('input');
  input?.addEventListener('input', () => { el.querySelector('.ws-pop-list').innerHTML = items(input.value.trim()); });
  input?.focus();
  el.addEventListener('click', (e) => { if (e.target.closest('a')) closeSwitcher(); });
  const outside = (e) => { if (!el.contains(e.target) && !btn.contains(e.target)) closeSwitcher(); };
  const key = (e) => { if (e.key === 'Escape') closeSwitcher(); };
  setTimeout(() => document.addEventListener('click', outside, true), 0);
  document.addEventListener('keydown', key);
  switcher = { el, btn, outside, key };
}
