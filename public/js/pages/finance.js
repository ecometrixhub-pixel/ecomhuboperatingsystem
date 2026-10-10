// Finance: revenue overview + every invoice
import { supabase } from '../supabase.js';
import { can, money } from '../state.js';
import { q } from '../data.js';
import { esc, icon, emptyState, loadingBlock, on, downloadCSV } from '../ui.js';
import { fmtDate } from '../time.js';
import { loadBusiness, businessPanel, businessError } from '../business.js';
import { invoiceBadge, invoiceState, openInvoiceForm, openClientDrawer, INVOICE_STATUS } from './clients.js';

export async function render({ el }) {
  let invoices = []; let filter = 'unpaid'; let search = '';
  el.innerHTML = `
    <div class="page-head">
      <div><h1>Finance</h1><p>Revenue, invoices and what's still unpaid.</p></div>
      <div class="actions"><button class="btn" id="csv">${icon('download', 15)}Export CSV</button>${can('finance', 'edit') ? `<button class="btn btn-primary" id="new">${icon('plus', 15)}New invoice</button>` : ''}</div>
    </div>
    <div id="biz">${loadingBlock(3)}</div>
    <div class="toolbar" style="margin-top:20px"><div class="seg" role="group" aria-label="Invoice status" id="f"></div>
      <div class="search grow">${icon('search', 15)}<input class="input" id="q" placeholder="Search client or invoice number" aria-label="Search invoices"></div></div>
    <section class="panel"><div class="table-wrap" id="table">${loadingBlock(4)}</div></section>`;
  const table = el.querySelector('#table');
  const groups = { unpaid: (i) => i.status === 'sent', overdue: (i) => invoiceState(i) === 'overdue', paid: (i) => i.status === 'paid', draft: (i) => i.status === 'draft', all: () => true };

  function draw() {
    el.querySelector('#f').innerHTML = [['unpaid', 'Unpaid'], ['overdue', 'Overdue'], ['paid', 'Paid'], ['draft', 'Draft'], ['all', 'All']]
      .map(([k, v]) => `<button data-f="${k}" aria-pressed="${filter === k}">${v}<span class="count">${invoices.filter(groups[k]).length}</span></button>`).join('');
    const s = search.toLowerCase();
    const list = invoices.filter(groups[filter]).filter((i) => !s || `${i.client?.name || ''} ${i.invoice_number || ''}`.toLowerCase().includes(s));
    if (!list.length) { table.innerHTML = emptyState(invoices.length ? 'No invoices here' : 'No invoices yet', invoices.length ? '' : 'Add invoices from a client or with New invoice.'); return; }
    const total = list.reduce((a, i) => a + Number(i.amount), 0);
    table.innerHTML = `<table class="table">
      <thead><tr><th>Invoice</th><th>Client</th><th>Issued</th><th>Due</th><th>Status</th><th class="r">Amount</th></tr></thead>
      <tbody>${list.map((i) => `<tr class="clickable" data-client="${i.client_id}" tabindex="0">
        <td><div style="font-weight:500">${esc(i.invoice_number || `#${i.id}`)}</div><div class="small muted">${esc(i.description || '')}</div></td>
        <td>${esc(i.client?.name || '—')}</td><td class="small">${esc(fmtDate(i.issue_date))}</td><td class="small">${esc(fmtDate(i.due_date))}</td>
        <td>${invoiceBadge(i)}</td><td class="r money"><b>${money(i.amount)}</b></td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="5">Total</td><td class="r money">${money(total)}</td></tr></tfoot></table>`;
  }

  async function load() {
    const [b, inv] = await Promise.all([
      loadBusiness().catch((e) => ({ error: e })),
      q(supabase.from('invoices').select('*, client:clients(id, name)').order('issue_date', { ascending: false }).limit(3000)),
    ]);
    el.querySelector('#biz').innerHTML = b.error ? businessError(b.error) : businessPanel(b);
    invoices = inv;
    draw();
  }
  el.querySelector('#f').addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; draw(); } });
  el.querySelector('#q').addEventListener('input', (e) => { search = e.target.value.trim(); draw(); });
  el.querySelector('#new')?.addEventListener('click', () => openInvoiceForm());
  el.querySelector('#csv').onclick = () => downloadCSV('invoices.csv', [['Invoice', 'Client', 'Description', 'Issued', 'Due', 'Status', 'Paid on', 'Amount'],
    ...invoices.map((i) => [i.invoice_number || i.id, i.client?.name || '', i.description, i.issue_date, i.due_date || '', invoiceState(i) === 'overdue' ? 'Overdue' : INVOICE_STATUS[i.status], i.paid_date || '', i.amount])]);
  const offs = [on(table, 'click', 'tr[data-client]', (e, tr) => openClientDrawer(Number(tr.dataset.client), 'invoices'))];
  const safe = () => load().catch((e) => { table.innerHTML = `<div class="form-error" style="margin:16px">${esc(e.message)}</div>`; });
  await safe();
  window.addEventListener('ehos:data-changed', safe);
  return () => { offs.forEach((x) => x()); window.removeEventListener('ehos:data-changed', safe); };
}
