import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { q } from '../data.js';
import { esc, toast, busy } from '../ui.js';
import { setTimezone } from '../time.js';
import { setIdleMinutes } from '../tracker.js';
import { mountProfileForm, mountPasswordForm } from './profile.js';
import { INVOICE_DEFAULTS } from '../invoices.js';

export async function render({ el }) {
  const s = state.settings;
  const inv = s.invoice_details || {};
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['Asia/Karachi', 'Europe/London', 'America/New_York', 'UTC']; }
  if (!zones.includes(s.timezone)) zones.unshift(s.timezone);

  el.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><p>Workspace settings and your admin profile.</p></div></div>
    <div class="stack" style="max-width:820px">
      <section class="panel">
        <div class="panel-head"><div><h2>Workspace</h2><p>Changes are recorded in the activity log.</p></div></div>
        <div class="panel-body">
          <form id="ws" class="form-grid" novalidate>
            <div class="field span-2"><label for="ws-name">Company name</label><input id="ws-name" class="input" value="${esc(s.company_name)}" maxlength="80"></div>
            <div class="field"><label for="ws-tz">Timezone</label>
              <select id="ws-tz" class="select">${zones.map((z) => `<option ${z === s.timezone ? 'selected' : ''}>${esc(z)}</option>`).join('')}</select>
              <span class="hint">Days, weeks and months in reports start at midnight in this timezone.</span></div>
            <div class="field"><label for="ws-idle">Mark idle after (minutes)</label><input id="ws-idle" class="input" type="number" min="1" max="60" value="${esc(s.idle_minutes)}">
              <span class="hint">No click, key press or scroll in EcomHub OS for this long counts as idle.</span></div>
            <div class="field"><label for="ws-cur">Currency</label>
              <select id="ws-cur" class="select">${['USD', 'GBP', 'EUR', 'PKR', 'AED', 'CAD', 'AUD', 'SAR'].map((c) => `<option ${c === (s.currency || 'USD') ? 'selected' : ''}>${c}</option>`).join('')}</select>
              <span class="hint">Used for invoices, revenue and lead values.</span></div>
            <div class="span-2"><button class="btn btn-primary" type="submit">Save workspace settings</button></div>
          </form>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>Invoice details</h2><p>Printed on every invoice: contact details, bank / Wise details and terms.</p></div></div>
        <div class="panel-body">
          <form id="invd" class="form-grid" novalidate>
            <div class="field span-2"><label for="id-address">Address</label><input id="id-address" class="input" maxlength="300" value="${esc(inv.address || '')}" placeholder="Office, street, city, country"></div>
            <div class="field"><label for="id-email">Email</label><input id="id-email" class="input" type="email" maxlength="160" value="${esc(inv.email ?? INVOICE_DEFAULTS.email)}"></div>
            <div class="field"><label for="id-phone">Phone</label><input id="id-phone" class="input" maxlength="40" value="${esc(inv.phone ?? INVOICE_DEFAULTS.phone)}"></div>
            <div class="field span-2"><label for="id-website">Website</label><input id="id-website" class="input" maxlength="160" value="${esc(inv.website ?? INVOICE_DEFAULTS.website)}"></div>
            <div class="span-2 section-title" style="margin:6px 0 0">Payment details</div>
            <div class="field"><label for="id-title">Account title</label><input id="id-title" class="input" maxlength="120" value="${esc(inv.account_title || '')}"></div>
            <div class="field"><label for="id-bank">Bank</label><input id="id-bank" class="input" maxlength="120" value="${esc(inv.bank || '')}"></div>
            <div class="field"><label for="id-iban">IBAN</label><input id="id-iban" class="input" maxlength="60" value="${esc(inv.iban || '')}"></div>
            <div class="field"><label for="id-swift">SWIFT / BIC</label><input id="id-swift" class="input" maxlength="30" value="${esc(inv.swift || '')}"></div>
            <div class="field span-2"><label for="id-wallet">Wise / Payoneer</label><input id="id-wallet" class="input" maxlength="160" value="${esc(inv.wallet || '')}" placeholder="Email or account ID"></div>
            <div class="field span-2"><label for="id-payment">Other payment details</label><textarea id="id-payment" class="textarea" rows="2" maxlength="1000" placeholder="Optional, e.g. PayPal">${esc(inv.payment || '')}</textarea>
              <span class="hint">The invoice number is printed as the payment reference automatically.</span></div>
            <div class="span-2 section-title" style="margin:6px 0 0">Terms</div>
            <div class="field"><label for="id-due">Payment due within (days)</label><input id="id-due" class="input" type="number" min="0" max="120" value="${esc(inv.due_days ?? INVOICE_DEFAULTS.due_days)}">
              <span class="hint">Sets the due date on new invoices.</span></div>
            <div class="field"><label for="id-pause">Services may pause after (days overdue)</label><input id="id-pause" class="input" type="number" min="0" max="365" value="${esc(inv.pause_days ?? INVOICE_DEFAULTS.pause_days)}"></div>
            <div class="field span-2"><label for="id-footer">Note under the terms</label><input id="id-footer" class="input" maxlength="300" value="${esc(inv.footer_note ?? INVOICE_DEFAULTS.footer_note)}"></div>
            <div class="field span-2"><label for="id-terms">Default note on new invoices</label><textarea id="id-terms" class="textarea" rows="2" maxlength="1000" placeholder="Optional">${esc(inv.terms || '')}</textarea>
              <span class="hint">Filled in on each new invoice. You can change it per invoice.</span></div>
            <div class="span-2"><button class="btn btn-primary" type="submit">Save invoice details</button></div>
          </form>
        </div>
      </section>
      <section class="panel"><div class="panel-head"><h2>Your profile</h2></div><div class="panel-body" id="pf"></div></section>
      <section class="panel"><div class="panel-head"><h2>Password</h2></div><div class="panel-body" id="pw"></div></section>
    </div>`;

  const form = el.querySelector('#ws');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = {
      company_name: form.querySelector('#ws-name').value.trim() || 'Ecometrix Hub',
      timezone: form.querySelector('#ws-tz').value,
      idle_minutes: Math.min(60, Math.max(1, parseInt(form.querySelector('#ws-idle').value, 10) || 5)),
      currency: form.querySelector('#ws-cur').value,
    };
    busy(form.querySelector('[type=submit]'), async () => {
      try {
        const [row] = await q(supabase.from('app_settings').update(body).eq('id', 1).select());
        Object.assign(state.settings, row || body);
        setTimezone(state.settings.timezone);
        setIdleMinutes(state.settings.idle_minutes);
        document.querySelector('.brand-name small').textContent = state.settings.company_name;
        toast('Settings saved');
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  const invForm = el.querySelector('#invd');
  invForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (id) => invForm.querySelector(id).value.trim();
    const days = (id, max, def) => { const n = parseInt(v(id), 10); return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : def; };
    const details = {
      address: v('#id-address'), email: v('#id-email'), phone: v('#id-phone'), website: v('#id-website'),
      account_title: v('#id-title'), bank: v('#id-bank'), iban: v('#id-iban'), swift: v('#id-swift'), wallet: v('#id-wallet'), payment: v('#id-payment'),
      due_days: days('#id-due', 120, INVOICE_DEFAULTS.due_days), pause_days: days('#id-pause', 365, INVOICE_DEFAULTS.pause_days),
      footer_note: v('#id-footer'), terms: v('#id-terms'),
    };
    busy(invForm.querySelector('[type=submit]'), async () => {
      try {
        const [row] = await q(supabase.from('app_settings').update({ invoice_details: details }).eq('id', 1).select());
        state.settings.invoice_details = row?.invoice_details || details;
        toast('Invoice details saved');
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  mountProfileForm(el.querySelector('#pf'));
  mountPasswordForm(el.querySelector('#pw'));
}
