// EcomHub OS — server
// On Vercel this file becomes one serverless function and /public is served by the CDN.
// Locally:  npm run dev  → http://localhost:3000
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL;
const PUBLIC_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');

const configured = Boolean(SUPABASE_URL && PUBLIC_KEY && SECRET_KEY);
const db = configured
  ? createClient(SUPABASE_URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

// The four co-founders (Manager role, one department each). Set up once from Team → Set up founding team.
const FOUNDERS = [
  { first_name: 'Maliha', last_name: 'Khan', email: 'khanmaliha99909@gmail.com', department: 'Digital Marketing & Client Accounts & Finance' },
  { first_name: 'Haseeb', last_name: 'Gul', email: 'haseebg0012@gmail.com', department: 'Tech & Operations' },
  { first_name: 'Taha', last_name: 'Khan', email: 'tk9715495@gmail.com', department: 'Growth & Sales (Online)' },
  { first_name: 'Tahir', last_name: 'Khan', email: 'tk247454@gmail.com', department: 'Business Development (Field)' },
];
const FOUNDER_TITLE = 'Co-Founder';
const ROLE_KEYS = ['sales_rep', 'lead_gen', 'cold_caller', 'finance', 'manager', 'project_manager'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// ---------- tiny rate limiter (per instance) ----------
const hits = new Map();
app.use('/api', (req, res, next) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count += 1;
  hits.set(ip, entry);
  if (hits.size > 5000) hits.clear();
  if (entry.count > 120) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
  next();
});

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function clean(v, max = 120) {
  if (v === undefined || v === null) return undefined;
  return String(v).trim().slice(0, max);
}

function siteOrigin(req) {
  if (SITE_URL) return SITE_URL;
  const origin = req.get('origin');
  if (origin && /^https?:\/\/[^/]+$/.test(origin)) return origin;
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${req.get('host')}`;
}

function memberFields(body) {
  const f = {};
  for (const k of ['first_name', 'last_name', 'phone', 'department', 'job_title']) {
    const v = clean(body[k], k === 'phone' ? 30 : 80);
    if (v !== undefined) f[k] = v;
  }
  if (body.joined_on !== undefined) {
    const d = clean(body.joined_on, 10);
    if (d && !DATE_RE.test(d)) throw new HttpError(400, 'Joining date must be a valid date');
    f.joined_on = d || '';
  }
  return f;
}

function parseRoles(roles) {
  if (roles === undefined) return null;
  if (!Array.isArray(roles)) throw new HttpError(400, 'Roles must be a list');
  return [...new Set(roles.map(String))].filter((r) => ROLE_KEYS.includes(r));
}

async function logEvent(actor, action, subject, description, meta = {}) {
  await db.from('activity_logs').insert({
    actor_id: actor.id,
    actor_name: `${actor.first_name} ${actor.last_name}`.trim() || actor.email,
    subject_id: subject,
    action,
    entity_type: 'member',
    entity_id: subject,
    description,
    meta,
  });
}

// The link we share points to our own page with the token hash. The token is only used when the person
// presses "Continue" there, so WhatsApp / email link previews (which open links on their own) can't use it up.
function shareLink(redirectTo, props, type) {
  return `${redirectTo}?token_hash=${encodeURIComponent(props.hashed_token)}&type=${encodeURIComponent(props.verification_type || type)}`;
}

// Generates a one-time link the admin can share (WhatsApp, email, Slack).
// Invite link for people who haven't joined yet; password-reset link for everyone else.
async function accessLink(email, invited, redirectTo, data) {
  if (invited) {
    const r = await db.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo, data } });
    if (!r.error) return { link: shareLink(redirectTo, r.data.properties, 'invite'), type: 'invite', user: r.data.user };
  }
  const r = await db.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
  if (r.error) throw new HttpError(400, r.error.message);
  return { link: shareLink(redirectTo, r.data.properties, 'recovery'), type: 'recovery', user: r.data.user };
}

// ---------- auth middleware ----------
const requireAdmin = wrap(async (req, res, next) => {
  if (!configured) throw new HttpError(500, 'Server is missing Supabase environment variables');
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Sign in again to continue');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Your session has expired. Sign in again.');
  const { data: profile } = await db.from('profiles').select('id, email, first_name, last_name, role, status, member_roles(role_key)').eq('id', data.user.id).single();
  const isManager = profile?.role === 'admin' || (profile?.member_roles || []).some((r) => r.role_key === 'manager');
  if (!profile || !isManager || profile.status !== 'active') throw new HttpError(403, 'Only the admin or a manager can do this');
  req.admin = profile;
  next();
});

// ---------- routes ----------
const api = express.Router();

api.get('/health', (req, res) => res.json({ ok: true, configured }));

// Public browser config (publishable key is safe to expose; RLS protects the data)
api.get('/config', (req, res) => {
  if (!SUPABASE_URL || !PUBLIC_KEY) {
    return res.status(500).json({ error: 'Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY on the server' });
  }
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ supabaseUrl: SUPABASE_URL, supabaseKey: PUBLIC_KEY });
});

// Add a team member → returns a one-time invite link
api.post('/members', requireAdmin, wrap(async (req, res) => {
  const email = clean(req.body.email, 160)?.toLowerCase();
  if (!email || !EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address');
  const fields = memberFields(req.body);
  if (!fields.first_name) throw new HttpError(400, 'First name is required');
  const roles = parseRoles(req.body.roles) || [];

  const { data: existing } = await db.from('profiles').select('id').eq('email', email).maybeSingle();
  if (existing) throw new HttpError(409, 'A member with this email already exists');

  const redirectTo = `${siteOrigin(req)}/set-password.html`;
  const invite = await db.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo, data: { first_name: fields.first_name, last_name: fields.last_name || '' } },
  });
  if (invite.error) throw new HttpError(400, invite.error.message);
  const user = invite.data.user;

  // Profile row is created by the database trigger; make sure it exists, then fill details + roles
  await db.from('profiles').upsert({ id: user.id, email, status: 'invited' }, { onConflict: 'id', ignoreDuplicates: true });
  const { error } = await db.rpc('admin_save_member', { p_actor: req.admin.id, p_member: user.id, p_fields: fields, p_roles: roles });
  if (error) {
    await db.auth.admin.deleteUser(user.id).catch(() => {});
    throw new HttpError(400, error.message);
  }
  await logEvent(req.admin, 'member_invited', user.id, `Invited ${fields.first_name} ${fields.last_name || ''}`.trim(), { email, roles });
  res.status(201).json({ id: user.id, inviteLink: shareLink(redirectTo, invite.data.properties, 'invite') });
}));

// Create (or update) the co-founders' accounts in one go → invite links to share
api.post('/setup/founders', requireAdmin, wrap(async (req, res) => {
  if (req.admin.role !== 'admin') throw new HttpError(403, 'Only the admin can set up the founding team');
  const redirectTo = `${siteOrigin(req)}/set-password.html`;
  const results = [];
  for (const f of FOUNDERS) {
    const name = `${f.first_name} ${f.last_name}`;
    const fields = { first_name: f.first_name, last_name: f.last_name, department: f.department, job_title: FOUNDER_TITLE };
    try {
      const { data: existing } = await db.from('profiles').select('id, role, status, member_roles(role_key)').eq('email', f.email).maybeSingle();
      if (existing) {
        // Keep their other roles, add Manager. The admin account keeps admin and just gets the title + department.
        const roles = existing.role === 'admin' ? null : [...new Set([...(existing.member_roles || []).map((r) => r.role_key), 'manager'])];
        const { error } = await db.rpc('admin_save_member', { p_actor: req.admin.id, p_member: existing.id, p_fields: fields, p_roles: roles });
        if (error) throw new Error(error.message);
        let link = null;
        if (existing.status === 'invited') link = (await accessLink(f.email, true, redirectTo, { first_name: f.first_name, last_name: f.last_name })).link;
        results.push({ name, email: f.email, status: existing.role === 'admin' ? 'admin' : existing.status === 'invited' ? 'invited' : 'updated', link });
        continue;
      }
      const invite = await db.auth.admin.generateLink({ type: 'invite', email: f.email, options: { redirectTo, data: { first_name: f.first_name, last_name: f.last_name } } });
      if (invite.error) throw new Error(invite.error.message);
      const user = invite.data.user;
      await db.from('profiles').upsert({ id: user.id, email: f.email, status: 'invited' }, { onConflict: 'id', ignoreDuplicates: true });
      const { error } = await db.rpc('admin_save_member', { p_actor: req.admin.id, p_member: user.id, p_fields: fields, p_roles: ['manager'] });
      if (error) { await db.auth.admin.deleteUser(user.id).catch(() => {}); throw new Error(error.message); }
      await logEvent(req.admin, 'member_invited', user.id, `Invited ${name} (co-founder)`, { email: f.email, roles: ['manager'] });
      results.push({ name, email: f.email, status: 'created', link: shareLink(redirectTo, invite.data.properties, 'invite') });
    } catch (e) {
      results.push({ name, email: f.email, status: 'error', error: e.message });
    }
  }
  res.json({ results });
}));

// Edit details and roles
api.patch('/members/:id', requireAdmin, wrap(async (req, res) => {
  const fields = memberFields(req.body);
  if ('first_name' in fields && !fields.first_name) throw new HttpError(400, 'First name is required');
  const roles = parseRoles(req.body.roles);
  const { data: target } = await db.from('profiles').select('id, role').eq('id', req.params.id).maybeSingle();
  if (!target) throw new HttpError(404, 'Member not found');
  const { error } = await db.rpc('admin_save_member', { p_actor: req.admin.id, p_member: target.id, p_fields: fields, p_roles: roles });
  if (error) throw new HttpError(400, error.message);
  res.json({ ok: true });
}));

// Activate / deactivate / suspend
api.post('/members/:id/status', requireAdmin, wrap(async (req, res) => {
  const status = clean(req.body.status, 20);
  if (!['active', 'inactive', 'suspended'].includes(status)) throw new HttpError(400, 'Invalid status');
  const { data: target } = await db.from('profiles').select('id, status').eq('id', req.params.id).maybeSingle();
  if (!target) throw new HttpError(404, 'Member not found');
  if (target.status === 'invited' && status === 'active') throw new HttpError(400, 'This member has not accepted the invite yet');

  const { error } = await db.rpc('admin_set_member_status', { p_actor: req.admin.id, p_member: target.id, p_status: status });
  if (error) throw new HttpError(400, error.message);
  // Block / allow sign-in at the auth level too
  const ban = status === 'active' ? 'none' : '876000h';
  const { error: banError } = await db.auth.admin.updateUserById(target.id, { ban_duration: ban });
  if (banError) throw new HttpError(500, 'Status saved, but sign-in access could not be updated: ' + banError.message);
  res.json({ ok: true });
}));

// New invite link (not joined yet) or password reset link (joined)
api.post('/members/:id/access-link', requireAdmin, wrap(async (req, res) => {
  const { data: target } = await db.from('profiles').select('id, email, first_name, last_name, status, role').eq('id', req.params.id).maybeSingle();
  if (!target) throw new HttpError(404, 'Member not found');
  if (target.role === 'admin' && req.admin.role !== 'admin') throw new HttpError(403, 'Only the admin can get a link for the admin account');
  if (['inactive', 'suspended'].includes(target.status)) throw new HttpError(400, 'Activate this member first');
  const redirectTo = `${siteOrigin(req)}/set-password.html`;
  const result = await accessLink(target.email, target.status === 'invited', redirectTo, {
    first_name: target.first_name, last_name: target.last_name,
  });
  await logEvent(req.admin, result.type === 'invite' ? 'invite_resent' : 'reset_link_created', target.id,
    `${result.type === 'invite' ? 'New invite link' : 'Password reset link'} for ${target.first_name} ${target.last_name}`.trim());
  res.json({ link: result.link, type: result.type });
}));

// ---------- Public lead form (no login) ----------
const formHits = new Map();
function formLimit(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const now = Date.now();
  const list = (formHits.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  list.push(now); formHits.set(ip, list);
  if (formHits.size > 5000) formHits.clear();
  return list.length <= 15;
}
const STAGES = ['new', 'contacted', 'qualified', 'meeting', 'proposal', 'negotiation'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const titleCase = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

async function leadAgents() {
  const { data } = await db.from('member_roles').select('member_id, profiles!inner(first_name, last_name, status)').eq('role_key', 'lead_gen');
  return (data || []).filter((r) => r.profiles.status === 'active')
    .map((r) => ({ id: r.member_id, name: `${r.profiles.first_name} ${r.profiles.last_name}`.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

api.get('/public/form', wrap(async (req, res) => {
  if (!configured) throw new HttpError(500, 'The form is not connected yet');
  const { data: settings } = await db.from('app_settings').select('company_name').eq('id', 1).maybeSingle();
  res.set('Cache-Control', 'no-store');
  res.json({ company: settings?.company_name || 'Ecometrix Hub', agents: await leadAgents() });
}));

api.post('/public/lead', wrap(async (req, res) => {
  if (!configured) throw new HttpError(500, 'The form is not connected yet');
  if (!formLimit(req)) throw new HttpError(429, 'Too many submissions. Wait a few minutes and try again.');
  const b = req.body || {};
  if (b.hp) return res.json({ ok: true }); // bot
  const lead = {
    contact_name: titleCase(clean(b.contact_name, 120)),
    company: clean(b.company, 200),
    email: clean(b.email, 160) || null,
    phone: clean(b.phone, 40) || null,
    country: clean(b.country, 60) || null,
    industry: clean(b.industry, 80) || null,
    service: clean(b.service, 200) || null,
    currency: (clean(b.currency, 8) || 'USD').toUpperCase().replace(/[^A-Z]/g, '') || 'USD',
    budget: b.budget === null || b.budget === '' || b.budget === undefined ? null : Number(b.budget),
    source: clean(b.source, 60) || 'Website',
    status: STAGES.includes(b.status) ? b.status : 'new',
    priority: PRIORITIES.includes(b.priority) ? b.priority : 'medium',
    notes: clean(b.notes, 4000) || '',
    agent_id: null,
    agent_name: null,
  };
  if (!lead.contact_name) throw new HttpError(400, 'Enter the lead\'s full name');
  if (!lead.company) throw new HttpError(400, 'Enter the company or brand name');
  if (lead.email && !EMAIL_RE.test(lead.email)) throw new HttpError(400, 'That email doesn\'t look right');
  if (lead.budget !== null && !(lead.budget >= 0 && lead.budget < 1e10)) throw new HttpError(400, 'Budget must be a number');
  if (b.agent_id) {
    const agents = await leadAgents();
    if (!agents.some((a) => a.id === b.agent_id)) throw new HttpError(400, 'Pick your name from the list');
    lead.agent_id = b.agent_id;
  } else {
    lead.agent_name = titleCase(clean(b.agent_name, 80));
    if (!lead.agent_name) throw new HttpError(400, 'Select or type the agent name');
  }
  const { error } = await db.from('leads').insert(lead);
  if (error) throw new HttpError(400, error.message);
  res.status(201).json({ ok: true });
}));

app.use('/api', api);

// Local development: serve the frontend too (Vercel serves /public from its CDN)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (req, res) => res.redirect('/app.html'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err instanceof HttpError ? err.message : 'Something went wrong on the server' });
});

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`EcomHub OS running → http://localhost:${port}`);
    if (!configured) console.log('⚠  Add your Supabase keys to .env (see .env.example)');
  });
}

export default app;
