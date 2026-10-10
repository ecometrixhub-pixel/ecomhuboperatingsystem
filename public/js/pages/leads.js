// Leads: add, import, work the pipeline, mark won → client
import { supabase } from '../supabase.js';
import { state, can, money } from '../state.js';
import { q, rpc, loadDirectory, dirName } from '../data.js';
import { esc, icon, emptyState, loadingBlock, on, openDrawer, closeDrawer, openModal, confirmDialog, toast, busy } from '../ui.js';
import { fmtDateOfIso, fmtRelative, todayStr, localDate, startOfWeek } from '../time.js';

export const LEAD_STATUS = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', proposal: 'Proposal sent', won: 'Won', lost: 'Lost' };
export const LEAD_SOURCES = ['Instagram', 'Facebook', 'LinkedIn', 'Google Maps', 'Shopify store list', 'Website form', 'Cold call', 'Email outreach', 'Referral', 'Other'];
const OPEN = ['new', 'contacted', 'qualified', 'proposal'];
const changed = () => window.dispatchEvent(new CustomEvent('ehos:data-changed'));
export const leadBadge = (s) => `<span class="badge ${esc(s)}">${esc(LEAD_STATUS[s] || s)}</span>`;

export async function render({ el, params }) {
  let leads = []; let dir = [];
  let status = params.get('status') || 'all';
  let scope = params.get('scope') || 'all';
  let search = '';
  const canEdit = can('leads', 'edit');

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Leads</h1><p>Every prospect from first contact to a won client.</p></div>
      <div class="actions">${canEdit ? `<button class="btn" id="import">${icon('upload', 15)}Import CSV</button><button class="btn btn-primary" id="new">${icon('plus', 15)}New lead</button>` : ''}</div>
    </div>
    <div class="toolbar"><div class="seg" role="group" aria-label="Status" id="status"></div></div>
    <div class="toolbar">
      <div class="search grow">${icon('search', 15)}<input class="input" id="q" placeholder="Search company, contact, email" aria-label="Search leads"></div>
      <select class="select" id="scope" style="width:auto" aria-label="Whose leads">
        <option value="all">All leads</option><option value="mine">Added by me</option><option value="assigned">Assigned to me</option>
      </select>
    </div>
    <section class="panel"><div class="table-wrap" id="table">${loadingBlock(5)}</div></section>`;
  const table = el.querySelector('#table');
  el.querySelector('#scope').value = scope;

  function draw() {
    const counts = { all: leads.length };
    Object.keys(LEAD_STATUS).forEach((k) => { counts[k] = leads.filter((l) => l.status === k).length; });
    el.querySelector('#status').innerHTML = [['all', 'All'], ['open', 'Open'], ...Object.entries(LEAD_STATUS)].map(([k, v]) =>
      `<button data-s="${k}" aria-pressed="${status === k}">${v}<span class="count">${k === 'open' ? leads.filter((l) => OPEN.includes(l.status)).length : counts[k]}</span></button>`).join('');
    const s = search.toLowerCase();
    const list = leads.filter((l) => (status === 'all' || (status === 'open' ? OPEN.includes(l.status) : l.status === status))
      && (scope === 'all' || (scope === 'mine' ? l.created_by === state.profile.id : l.assigned_to === state.profile.id))
      && (!s || `${l.company} ${l.contact_name || ''} ${l.email || ''} ${l.phone || ''}`.toLowerCase().includes(s)));
    if (!leads.length) {
      table.innerHTML = emptyState('No leads yet', canEdit ? 'Add a lead or import a CSV. Sales reps see them here right away.' : 'Leads added by the team show up here.', canEdit ? '<button class="btn btn-primary" data-new>New lead</button>' : '');
      return;
    }
    if (!list.length) { table.innerHTML = emptyState('No leads match these filters'); return; }
    table.innerHTML = `<table class="table">
      <thead><tr><th>Company</th><th>Status</th><th>Source</th><th class="r">Est. value / mo</th><th>Sales rep</th><th>Added by</th><th>Added</th></tr></thead>
      <tbody>${list.map((l) => `<tr class="clickable ${l.status === 'won' ? 'won' : ''}" data-id="${l.id}" tabindex="0">
        <td><div style="font-weight:500">${esc(l.company)}</div><div class="small muted">${esc([l.contact_name, l.email || l.phone].filter(Boolean).join(', ') || '—')}</div></td>
        <td>${leadBadge(l.status)}</td>
        <td class="small">${esc(l.source || '—')}</td>
        <td class="r money">${l.estimated_value ? money(l.estimated_value) : '<span class="muted">—</span>'}</td>
        <td class="small">${esc(dirName(dir, l.assigned_to) || '—')}</td>
        <td class="small muted">${esc(dirName(dir, l.created_by) || '—')}</td>
        <td class="small muted">${esc(fmtRelative(l.created_at))}</td>
      </tr>`).join('')}</tbody></table>`;
  }

  async function load() {
    [leads, dir] = await Promise.all([
      q(supabase.from('leads').select('*').order('created_at', { ascending: false }).limit(3000)),
      loadDirectory(),
    ]);
    draw();
  }

  el.querySelector('#status').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { status = b.dataset.s; draw(); } });
  el.querySelector('#q').addEventListener('input', (e) => { search = e.target.value.trim(); draw(); });
  el.querySelector('#scope').addEventListener('change', (e) => { scope = e.target.value; draw(); });
  el.querySelector('#new')?.addEventListener('click', () => openLeadForm());
  el.querySelector('#import')?.addEventListener('click', () => openImport());
  const offs = [
    on(table, 'click', '[data-new]', () => openLeadForm()),
    on(table, 'click', 'tr[data-id]', (e, tr) => openLeadDrawer(Number(tr.dataset.id))),
    on(table, 'keydown', 'tr[data-id]', (e, tr) => { if (e.key === 'Enter') openLeadDrawer(Number(tr.dataset.id)); }),
  ];
  const safe = () => load().catch((e) => { table.innerHTML = `<div class="form-error" style="margin:16px">${esc(e.message)}</div>`; });
  await safe();
  if (params.get('new') === '1' && canEdit) openLeadForm();
  window.addEventListener('ehos:data-changed', safe);
  const poll = setInterval(safe, 60_000);
  return () => { offs.forEach((x) => x()); clearInterval(poll); window.removeEventListener('ehos:data-changed', safe); };
}

// ---------- Lead form ----------
export async function openLeadForm(lead = null) {
  const dir = await loadDirectory();
  const reps = dir.filter((d) => d.roles.includes('sales_rep') && d.status === 'active');
  const l = lead || { company: '', contact_name: '', email: '', phone: '', website: '', country: '', industry: '', source: '', estimated_value: '', assigned_to: '', notes: '' };
  const m = openModal({
    title: lead ? 'Edit lead' : 'New lead',
    wide: true,
    body: `
      <form id="lf" class="form-grid" novalidate>
        <div class="field span-2"><label for="lf-company">Company / brand</label><input id="lf-company" class="input" maxlength="200" value="${esc(l.company)}" placeholder="e.g. GlowCo Skincare" required></div>
        <div class="field"><label for="lf-contact">Contact person</label><input id="lf-contact" class="input" maxlength="120" value="${esc(l.contact_name || '')}"></div>
        <div class="field"><label for="lf-email">Email</label><input id="lf-email" class="input" type="email" maxlength="160" value="${esc(l.email || '')}"></div>
        <div class="field"><label for="lf-phone">Phone / WhatsApp</label><input id="lf-phone" class="input" maxlength="40" value="${esc(l.phone || '')}"></div>
        <div class="field"><label for="lf-web">Website / store</label><input id="lf-web" class="input" maxlength="200" value="${esc(l.website || '')}" placeholder="https://"></div>
        <div class="field"><label for="lf-country">Country</label><input id="lf-country" class="input" maxlength="60" value="${esc(l.country || '')}" placeholder="UK, USA…"></div>
        <div class="field"><label for="lf-industry">Industry / niche</label><input id="lf-industry" class="input" maxlength="80" value="${esc(l.industry || '')}" placeholder="Skincare, apparel…"></div>
        <div class="field"><label for="lf-source">Source</label><select id="lf-source" class="select"><option value="">Select</option>${LEAD_SOURCES.map((s) => `<option ${l.source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></div>
        <div class="field"><label for="lf-value">Estimated value per month (${esc(state.settings.currency || 'USD')})</label><input id="lf-value" class="input" type="number" min="0" step="1" value="${esc(l.estimated_value ?? '')}"></div>
        <div class="field span-2"><label for="lf-rep">Sales rep</label><select id="lf-rep" class="select"><option value="">Not assigned yet</option>${reps.map((r) => `<option value="${r.id}" ${l.assigned_to === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
        <div class="field span-2"><label for="lf-notes">Notes</label><textarea id="lf-notes" class="textarea" placeholder="What do they sell? Ad spend? How did you find them?">${esc(l.notes || '')}</textarea></div>
        <div class="form-error hidden span-2" id="lf-err"></div>
      </form>`,
    foot: `<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-save>${lead ? 'Save lead' : 'Add lead'}</button>`,
  });
  m.querySelector('[data-cancel]').onclick = () => m.close();
  const err = m.querySelector('#lf-err');
  const save = m.querySelector('[data-save]');
  const submit = () => busy(save, async () => {
    err.classList.add('hidden');
    const v = (id) => m.querySelector(id).value.trim();
    const payload = {
      company: v('#lf-company'), contact_name: v('#lf-contact') || null, email: v('#lf-email') || null, phone: v('#lf-phone') || null,
      website: v('#lf-web') || null, country: v('#lf-country') || null, industry: v('#lf-industry') || null, source: v('#lf-source') || null,
      estimated_value: v('#lf-value') === '' ? null : Number(v('#lf-value')), assigned_to: v('#lf-rep') || null, notes: v('#lf-notes'),
    };
    if (!payload.company) { err.textContent = 'Enter the company or brand name.'; err.classList.remove('hidden'); return; }
    if (payload.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) { err.textContent = 'That email doesn\'t look right.'; err.classList.remove('hidden'); return; }
    try {
      if (lead) await q(supabase.from('leads').update(payload).eq('id', lead.id));
      else await q(supabase.from('leads').insert(payload));
      toast(lead ? 'Lead saved' : 'Lead added');
      m.close(); changed();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
  save.onclick = submit;
  m.querySelector('#lf').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

// ---------- Lead drawer ----------
export async function openLeadDrawer(id) {
  const drawer = openDrawer({ title: 'Lead', body: loadingBlock(4), onClose: () => window.removeEventListener('ehos:data-changed', reload) });
  const reload = () => load();
  window.addEventListener('ehos:data-changed', reload);
  async function load() {
    const [lead, dir] = await Promise.all([q(supabase.from('leads').select('*').eq('id', id).maybeSingle()), loadDirectory()]);
    if (!drawer.isConnected) return;
    if (!lead) { drawer.querySelector('.drawer-body').innerHTML = '<p class="muted">This lead was deleted.</p>'; return; }
    const canEdit = can('leads', 'edit');
    drawer.querySelector('.drawer-head h2').textContent = lead.company;
    drawer.querySelector('.drawer-body').innerHTML = `
      <div class="row wrap">${leadBadge(lead.status)}${lead.source ? `<span class="chip">${esc(lead.source)}</span>` : ''}${lead.estimated_value ? `<span class="chip">${money(lead.estimated_value)} / mo</span>` : ''}</div>
      ${lead.status === 'won' ? `<div class="note ok"><b>Won</b> ${esc(fmtRelative(lead.won_at))}. ${lead.client_id && can('clients') ? `<button class="linkish" data-client="${lead.client_id}">Open client</button>` : 'It is now a client.'}</div>` : ''}
      ${canEdit && lead.status !== 'won' ? `<div><div class="section-title">Stage</div><div class="seg" role="group" aria-label="Lead stage">${Object.entries(LEAD_STATUS).filter(([k]) => k !== 'won').map(([k, v]) => `<button data-status="${k}" aria-pressed="${lead.status === k}">${v}</button>`).join('')}</div></div>` : ''}
      <dl class="kv">
        <dt>Contact</dt><dd>${esc(lead.contact_name || '—')}</dd>
        <dt>Email</dt><dd>${lead.email ? `<a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>` : '—'}</dd>
        <dt>Phone</dt><dd>${lead.phone ? `<a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a>` : '—'}</dd>
        <dt>Website</dt><dd>${lead.website ? `<a href="${esc(/^https?:/.test(lead.website) ? lead.website : 'https://' + lead.website)}" target="_blank" rel="noopener">${esc(lead.website)}</a>` : '—'}</dd>
        <dt>Country</dt><dd>${esc(lead.country || '—')}</dd>
        <dt>Industry</dt><dd>${esc(lead.industry || '—')}</dd>
        <dt>Sales rep</dt><dd>${esc(dirName(dir, lead.assigned_to) || 'Not assigned')}</dd>
        <dt>Added by</dt><dd>${esc(dirName(dir, lead.created_by) || '—')}, ${esc(fmtDateOfIso(lead.created_at))}</dd>
      </dl>
      <div><div class="section-title">Notes</div>${lead.notes ? `<div class="desc">${esc(lead.notes)}</div>` : '<p class="muted small">No notes.</p>'}</div>`;
    let foot = '';
    if (can('leads', 'delete')) foot += `<button class="btn btn-ghost btn-danger" data-act="delete">${icon('trash', 14)}Delete</button>`;
    foot += '<span style="flex:1"></span>';
    if (canEdit) foot += `<button class="btn" data-act="edit">${icon('edit', 14)}Edit</button>`;
    if (canEdit && lead.status !== 'won') foot += `<button class="btn btn-success" data-act="won">${icon('trophy', 14)}Mark as won</button>`;
    let footEl = drawer.querySelector('.drawer-foot');
    if (!footEl) { footEl = document.createElement('div'); footEl.className = 'drawer-foot'; drawer.append(footEl); }
    footEl.innerHTML = foot;

    drawer.querySelectorAll('[data-status]').forEach((b) => b.onclick = async () => {
      try { await q(supabase.from('leads').update({ status: b.dataset.status }).eq('id', id)); toast(`Moved to ${LEAD_STATUS[b.dataset.status]}`); changed(); }
      catch (e) { toast(e.message, 'error'); }
    });
    drawer.querySelector('[data-client]')?.addEventListener('click', async (e) => {
      const { openClientDrawer } = await import('./clients.js');
      closeDrawer(); openClientDrawer(Number(e.currentTarget.dataset.client));
    });
    footEl.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => busy(b, async () => {
      try {
        if (b.dataset.act === 'edit') return openLeadForm(lead);
        if (b.dataset.act === 'won') {
          const ok = await confirmDialog({ title: `Mark ${lead.company} as won?`, text: 'The lead turns green and a client is created with these details, ready for onboarding, invoices and files.', confirm: 'Mark as won' });
          if (!ok) return;
          await rpc('lead_mark_won', { p_lead: id });
          toast('Lead won. Client created');
          changed();
        }
        if (b.dataset.act === 'delete') {
          const ok = await confirmDialog({ title: `Delete ${lead.company}?`, text: 'This removes the lead. A client made from it stays.', confirm: 'Delete lead', danger: true });
          if (!ok) return;
          await q(supabase.from('leads').delete().eq('id', id));
          toast('Lead deleted'); closeDrawer(); changed();
        }
      } catch (e) { toast(e.message, 'error'); }
    }));
  }
  load().catch((e) => { drawer.querySelector('.drawer-body').innerHTML = `<div class="form-error">${esc(e.message)}</div>`; });
}

// ---------- CSV import ----------
function parseCSV(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
const FIELD_MATCH = [
  ['company', /company|brand|business|store name|shop|^name$/],
  ['contact_name', /contact|person|owner|first name|full name/],
  ['email', /e-?mail/],
  ['phone', /phone|mobile|whatsapp|number/],
  ['website', /website|url|site|domain|store url|link/],
  ['country', /country|location/],
  ['industry', /industry|niche|category/],
  ['source', /source|channel/],
  ['estimated_value', /value|budget|revenue|spend/],
  ['notes', /note|comment|description/],
];

export function openImport() {
  const m = openModal({
    title: 'Import leads from CSV',
    body: `
      <p class="muted">Export from Google Sheets or Excel as CSV. The first row must have column names like <b>Company</b>, Contact, Email, Phone, Website, Country, Industry, Source, Value, Notes.</p>
      <div class="dropzone"><input type="file" accept=".csv,text/csv" id="csv-file" aria-label="CSV file"></div>
      <div id="csv-preview"></div>
      <div class="form-error hidden" id="csv-err"></div>`,
    foot: '<button class="btn" data-cancel>Cancel</button><button class="btn btn-primary" data-go disabled>Import leads</button>',
  });
  let records = [];
  const err = m.querySelector('#csv-err');
  const go = m.querySelector('[data-go]');
  m.querySelector('[data-cancel]').onclick = () => m.close();
  m.querySelector('#csv-file').onchange = async (e) => {
    err.classList.add('hidden'); go.disabled = true; records = [];
    const file = e.target.files[0]; if (!file) return;
    const rows = parseCSV(await file.text());
    if (rows.length < 2) { err.textContent = 'The file needs a header row and at least one lead.'; err.classList.remove('hidden'); return; }
    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const map = {};
    headers.forEach((h, i) => { const f = FIELD_MATCH.find(([key, re]) => !Object.values(map).includes(key) && re.test(h)); if (f && map[i] === undefined) map[i] = f[0]; });
    if (!Object.values(map).includes('company')) { err.textContent = 'Couldn\'t find a Company column. Rename the column with the business name to "Company".'; err.classList.remove('hidden'); return; }
    records = rows.slice(1).map((r) => {
      const o = {};
      Object.entries(map).forEach(([i, key]) => { const v = (r[i] || '').trim(); if (v) o[key] = key === 'estimated_value' ? Number(v.replace(/[^0-9.]/g, '')) || null : v.slice(0, key === 'notes' ? 4000 : 200); });
      return o;
    }).filter((o) => o.company).slice(0, 2000);
    m.querySelector('#csv-preview').innerHTML = `<div class="note info">Found <b>${records.length}</b> leads. Columns used: ${esc(Object.values(map).join(', '))}.</div>
      <div class="panel" style="margin-top:10px"><div class="list">${records.slice(0, 3).map((r) => `<div class="list-item" style="padding:9px 14px"><div class="grow"><div class="title">${esc(r.company)}</div><div class="meta">${esc([r.contact_name, r.email, r.country].filter(Boolean).join(', '))}</div></div></div>`).join('')}</div></div>`;
    go.disabled = !records.length;
  };
  go.onclick = () => busy(go, async () => {
    try {
      for (let i = 0; i < records.length; i += 200) await q(supabase.from('leads').insert(records.slice(i, i + 200)));
      toast(`${records.length} leads imported`);
      m.close(); changed();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  });
}

// Small list used on role tabs
export async function leadsPanel(kind) {
  const all = await q(supabase.from('leads').select('id, company, contact_name, status, created_at, created_by, assigned_to, source').order('created_at', { ascending: false }).limit(500));
  const me = state.profile.id;
  let list; let title; let sub;
  if (kind === 'lead_gen') {
    list = all.filter((l) => l.created_by === me);
    const week = list.filter((l) => localDate(l.created_at) >= startOfWeek(todayStr())).length;
    title = 'Leads you added'; sub = `${week} this week, ${list.length} in total`;
  } else {
    list = all.filter((l) => OPEN.includes(l.status)).sort((a, b) => (b.assigned_to === me) - (a.assigned_to === me));
    title = kind === 'cold_caller' ? 'Leads to call' : 'Leads to work'; sub = `${list.length} open leads${list.filter((l) => l.assigned_to === me).length ? `, ${list.filter((l) => l.assigned_to === me).length} assigned to you` : ''}`;
  }
  const canEdit = can('leads', 'edit');
  return `
    <section class="panel role-panel">
      <div class="panel-head"><div><h2>${title}</h2><p>${esc(sub)}</p></div>
        <div class="row">${kind === 'lead_gen' && canEdit ? `<button class="btn btn-sm" data-import>${icon('upload', 14)}Import CSV</button><button class="btn btn-sm btn-primary" data-new-lead>${icon('plus', 14)}New lead</button>` : ''}<a class="btn btn-sm btn-ghost" href="#/leads${kind === 'lead_gen' ? '?scope=mine' : '?status=open'}">All leads</a></div></div>
      <div class="list">${list.length ? list.slice(0, 6).map((l) => `
        <div class="list-item clickable" data-lead="${l.id}"><div class="grow"><div class="title">${esc(l.company)}</div><div class="meta"><span>${esc(l.contact_name || l.source || '')}</span><span>${esc(fmtRelative(l.created_at))}</span></div></div>${leadBadge(l.status)}</div>`).join('')
        : emptyState(kind === 'lead_gen' ? 'No leads yet' : 'No open leads', kind === 'lead_gen' ? 'Add your first lead. Sales reps see it right away.' : 'New leads from lead generation show up here.')}</div>
    </section>`;
}
