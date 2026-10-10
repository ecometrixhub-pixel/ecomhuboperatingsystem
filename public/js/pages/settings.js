import { supabase } from '../supabase.js';
import { state } from '../state.js';
import { q } from '../data.js';
import { esc, toast, busy } from '../ui.js';
import { setTimezone } from '../time.js';
import { setIdleMinutes } from '../tracker.js';
import { mountProfileForm, mountPasswordForm } from './profile.js';

export async function render({ el }) {
  const s = state.settings;
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
            <div class="span-2"><button class="btn btn-primary" type="submit">Save workspace settings</button></div>
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
  mountProfileForm(el.querySelector('#pf'));
  mountPasswordForm(el.querySelector('#pw'));
}
