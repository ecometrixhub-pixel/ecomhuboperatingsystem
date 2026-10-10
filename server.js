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

const ROLE_KEYS = ['sales_rep', 'lead_gen', 'cold_caller', 'finance', 'manager'];
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

// Generates a one-time link the admin can share (WhatsApp, email, Slack).
// Invite link for people who haven't joined yet; password-reset link for everyone else.
async function accessLink(email, invited, redirectTo, data) {
  if (invited) {
    const r = await db.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo, data } });
    if (!r.error) return { link: r.data.properties.action_link, type: 'invite', user: r.data.user };
  }
  const r = await db.auth.admin.generateLink({ type: 'recovery', email, options: { redirectTo } });
  if (r.error) throw new HttpError(400, r.error.message);
  return { link: r.data.properties.action_link, type: 'recovery', user: r.data.user };
}

// ---------- auth middleware ----------
const requireAdmin = wrap(async (req, res, next) => {
  if (!configured) throw new HttpError(500, 'Server is missing Supabase environment variables');
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Sign in again to continue');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Your session has expired. Sign in again.');
  const { data: profile } = await db.from('profiles').select('id, email, first_name, last_name, role, status').eq('id', data.user.id).single();
  if (!profile || profile.role !== 'admin' || profile.status !== 'active') throw new HttpError(403, 'Only the admin can do this');
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
  if (!roles.length) throw new HttpError(400, 'Pick at least one role');

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
  res.status(201).json({ id: user.id, inviteLink: invite.data.properties.action_link });
}));

// Edit details and roles
api.patch('/members/:id', requireAdmin, wrap(async (req, res) => {
  const fields = memberFields(req.body);
  if ('first_name' in fields && !fields.first_name) throw new HttpError(400, 'First name is required');
  const roles = parseRoles(req.body.roles);
  const { data: target } = await db.from('profiles').select('id, role').eq('id', req.params.id).maybeSingle();
  if (!target) throw new HttpError(404, 'Member not found');
  if (roles && !roles.length && target.role !== 'admin') throw new HttpError(400, 'Pick at least one role');
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
  const { data: target } = await db.from('profiles').select('id, email, first_name, last_name, status').eq('id', req.params.id).maybeSingle();
  if (!target) throw new HttpError(404, 'Member not found');
  if (['inactive', 'suspended'].includes(target.status)) throw new HttpError(400, 'Activate this member first');
  const redirectTo = `${siteOrigin(req)}/set-password.html`;
  const result = await accessLink(target.email, target.status === 'invited', redirectTo, {
    first_name: target.first_name, last_name: target.last_name,
  });
  await logEvent(req.admin, result.type === 'invite' ? 'invite_resent' : 'reset_link_created', target.id,
    `${result.type === 'invite' ? 'New invite link' : 'Password reset link'} for ${target.first_name} ${target.last_name}`.trim());
  res.json({ link: result.link, type: result.type });
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
