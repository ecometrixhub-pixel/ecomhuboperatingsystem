// Supabase client for the browser. Keys come from the server (/api/config), never hard-coded.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

async function loadConfig() {
  try {
    const cached = sessionStorage.getItem('ehos.config');
    if (cached) return JSON.parse(cached);
  } catch { /* storage blocked */ }
  const res = await fetch('/api/config');
  const cfg = await res.json().catch(() => ({}));
  if (!res.ok || !cfg.supabaseUrl) throw new Error(cfg.error || 'The server could not provide the Supabase settings.');
  try { sessionStorage.setItem('ehos.config', JSON.stringify(cfg)); } catch { /* ignore */ }
  return cfg;
}

let config;
try {
  config = await loadConfig();
} catch (e) {
  document.body.innerHTML = `<div class="fatal"><h1>EcomHub OS isn't connected yet</h1><p>${String(e.message).replace(/</g, '&lt;')}</p><p class="muted" style="margin-top:12px">Add SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY to the server environment, then reload.</p></div>`;
  throw e;
}

export const supabase = createClient(config.supabaseUrl, config.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'ehos-auth' },
});
