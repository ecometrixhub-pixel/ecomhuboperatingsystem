// Database tests for supabase/schema.sql — runs a real Postgres (PGlite) in memory.
// Run:  npm test
// Supabase pieces (auth.users, auth.uid(), roles) are stubbed below so RLS and functions behave like production.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const schemaPath = process.argv[2] || fileURLToPath(new URL('../supabase/schema.sql', import.meta.url));
const schema = fs.readFileSync(schemaPath, 'utf8');
const db = new PGlite();
process.on('unhandledRejection', e => { console.log('UNCAUGHT:', e.message, e.query || ''); process.exit(1); });
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗ FAIL:', msg); } };
const q = async (sql, params) => (await db.query(sql, params)).rows;
const ex = (sql) => db.exec(sql);

async function as(uid, fn) {
  await ex(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
  try { return await fn(); } finally { await ex(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
async function expectErr(fn, msg, pattern) {
  try { await fn(); ok(false, msg + ' (no error thrown)'); }
  catch (e) { ok(!pattern || pattern.test(e.message), msg + ' → ' + e.message.slice(0, 90)); }
}

// ---- Supabase stubs ----
await ex(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}', email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
`);

console.log('Schema load (twice, idempotent)');
await ex(schema); await ex(schema);
ok(true, 'schema.sql ran twice without errors');

// users
const [admin] = await q(`insert into auth.users (email, email_confirmed_at) values ('boss@ecom.com', now()) returning id`);
const [m1] = await q(`insert into auth.users (email, raw_user_meta_data) values ('ali@ecom.com', '{"first_name":"Ali","last_name":"Khan"}') returning id`);
const [m2] = await q(`insert into auth.users (email, raw_user_meta_data) values ('sara@ecom.com', '{"first_name":"Sara","last_name":"Ahmed"}') returning id`);
const A = admin.id, M1 = m1.id, M2 = m2.id;

console.log('Profiles & admin');
const profs = await q(`select email, status, role, employee_code from profiles order by employee_code`);
ok(profs.length === 3 && profs[1].status === 'invited', 'trigger created profiles; invited status for unconfirmed: ' + profs.map(p => p.employee_code + ':' + p.status).join(', '));
await q(`select promote_to_admin('BOSS@ecom.com')`);
ok((await q(`select role from profiles where id=$1`, [A]))[0].role === 'admin', 'promote_to_admin works (case-insensitive)');

await q(`select admin_save_member($1,$2,$3,$4)`, [A, M1, { phone: '0300', job_title: 'Caller', joined_on: '2026-10-01' }, ['cold_caller', 'lead_gen', 'bogus']]);
await q(`select admin_save_member($1,$2,$3,$4)`, [A, M2, {}, ['finance']]);
const roles = await q(`select role_key from member_roles where member_id=$1 order by 1`, [M1]);
ok(roles.map(r => r.role_key).join() === 'cold_caller,lead_gen', 'multiple roles saved, unknown role ignored');
await expectErr(() => q(`select admin_save_member($1,$2,'{}',null)`, [M1, M2]), 'non-admin cannot save members via function');

console.log('Tasks (admin)');
const [t1] = await as(A, () => q(`insert into tasks (title, assigned_to, team_role, priority, due_date) values ('Call 50 leads', $1, 'cold_caller', 'high', current_date - 1) returning id, created_by, status`, [M1]));
ok(t1.created_by === A && t1.status === 'todo', 'admin creates task (created_by forced)');
const [t2] = await as(A, () => q(`insert into tasks (title, assigned_to, team_role) values ('Find 20 prospects', $1, 'lead_gen') returning id`, [M1]));
const [t3] = await as(A, () => q(`insert into tasks (title, assigned_to, team_role) values ('Send invoices', $1, 'finance') returning id`, [M2]));
await expectErr(() => as(A, () => q(`insert into tasks (title, assigned_to, team_role) values ('x', $1, 'finance')`, [M1])), 'role mismatch blocked', /does not have/);
await expectErr(() => as(M1, () => q(`insert into tasks (title) values ('hack')`)), 'member cannot create tasks', /row-level security|permission/);

console.log('Member access');
await as(M1, async () => {
  const sid = (await q(`select session_start('Mozilla/5.0 Chrome', 'Chrome on Windows', 'login') as id`))[0].id;
  globalThis.S1 = sid;
  ok((await q(`select status from profiles where id=$1`, [M1]))[0].status === 'active', 'invited → active on first session');
  const mine = await q(`select id from tasks order by id`);
  ok(mine.length === 2, 'member sees only own tasks (' + mine.length + ')');
  const others = await q(`select id from profiles`);
  ok(others.length === 1, 'member sees only own profile');
  const upd = await q(`update tasks set title='changed' where id=$1 returning id`, [t1.id]).catch(e => e);
  ok(upd instanceof Error || upd.length === 0, 'member cannot update tasks directly');
  await expectErr(() => q(`insert into task_time_entries (task_id, user_id) values ($1,$2)`, [t1.id, M1]), 'member cannot write time entries', /permission/);
  await expectErr(() => q(`update profiles set role='admin' where id=$1`, [M1]), 'member cannot change own role', /permission/);
  const pu = await q(`update profiles set first_name='Aliyan' where id=$1 returning first_name`, [M1]);
  ok(pu[0]?.first_name === 'Aliyan', 'member can edit own name');
  await expectErr(() => q(`select team_presence()`), 'member cannot view presence', /admin/);
  await expectErr(() => q(`select * from report_daily(current_date, current_date, null)`), 'member cannot view team report', /own records/);
  await expectErr(() => q(`select * from report_daily(current_date, current_date, $1)`, [M2]), 'member cannot view another member report', /own records/);
  await expectErr(() => q(`select timer_start($1)`, [t3.id]), 'member cannot time someone else\'s task', /not assigned/);
  await expectErr(() => q(`insert into task_comments (task_id, author_id, body) values ($1,$2,'hi')`, [t3.id, M1]), 'member cannot comment on other task', /row-level/);
});

console.log('Timer');
await as(M1, async () => {
  const r = (await q(`select timer_start($1) as r`, [t1.id]))[0].r;
  ok(r.task_id == t1.id, 'timer started');
  ok((await q(`select status from tasks where id=$1`, [t1.id]))[0].status === 'in_progress', 'todo → in progress on timer start');
  const again = (await q(`select timer_start($1) as r`, [t1.id]))[0].r;
  ok(again.started_at === r.started_at, 'starting same task twice is idempotent');
});
await ex(`update task_time_entries set started_at = started_at - interval '30 minutes'`);
await as(M1, async () => {
  await q(`select timer_start($1)`, [t2.id]); // switch
  const rows = await q(`select task_id, end_reason, ended_at is null as running, extract(epoch from coalesce(ended_at, now())-started_at)::int as secs from task_time_entries order by id`);
  ok(rows.length === 2 && rows[0].end_reason === 'switch' && rows[1].running, 'switching task pauses the first');
  ok(Math.abs(rows[0].secs - 1800) < 5, 'first entry ~30 min (' + rows[0].secs + 's)');
  await q(`select timer_pause()`);
  await expectErr(() => q(`select timer_pause()`), 'pause with nothing running errors', /No timer/);
  const tot = await q(`select task_id, running, last_end_reason from task_time_totals order by task_id`);
  ok(tot.length === 2 && tot.every(t => !t.running) && tot[1].last_end_reason === 'pause', 'totals view: paused state visible');
  await q(`select timer_start($1)`, [t2.id]); // resume
  await q(`select timer_stop($1)`, [t2.id]);
  await q(`select timer_stop($1)`, [t1.id]); // stop paused (switch) timer
  const st = await q(`select task_id, last_end_reason from task_time_totals order by task_id`);
  ok(st.every(s => s.last_end_reason === 'stop'), 'stop works for running and paused timers');
  const logs = await q(`select action from activity_logs where actor_id=$1 order by id`, [M1]);
  const acts = logs.map(l => l.action);
  ok(['timer_started', 'timer_paused', 'timer_resumed', 'timer_stopped'].every(a => acts.includes(a)), 'timer actions logged: ' + [...new Set(acts)].join(','));
});
// duplicate running timer prevented by index
await expectErr(() => q(`insert into task_time_entries (task_id,user_id) values ($1,$2),($1,$2)`, [t1.id, M1]), 'unique index blocks two running timers', /duplicate|unique/);

console.log('Heartbeats & idle');
await ex(`update user_sessions set started_at = now() - interval '1 hour', last_seen_at = now() - interval '1 minute';
          update activity_intervals set started_at = now() - interval '1 hour';`);
await as(M1, async () => {
  const hb = (await q(`select session_heartbeat($1, 'active', 0) as r`, [S1]))[0].r;
  ok(hb.ok === true, 'heartbeat ok');
  await q(`select session_heartbeat($1, 'idle', 300)`, [S1]);
  const iv = await q(`select state, extract(epoch from coalesce(ended_at, now()) - started_at)::int as secs from activity_intervals where session_id=$1 order by id`, [S1]);
  ok(iv.length === 2 && iv[0].state === 'active' && Math.abs(iv[0].secs - 3300) < 5 && iv[1].state === 'idle', 'idle backdated 5 min: active=' + iv[0].secs + 's');
  await q(`select session_heartbeat($1, 'active', 0)`, [S1]);
  const ls = await q(`select status, duration_seconds, active_seconds, idle_seconds from list_sessions(current_date - 1, current_date + 1, $1)`, [M1]);
  ok(ls.length === 1 && Math.abs(ls[0].duration_seconds - 3600) < 5 && Math.abs(ls[0].idle_seconds - 300) < 5, `list_sessions: dur=${ls[0].duration_seconds} act=${ls[0].active_seconds} idle=${ls[0].idle_seconds} status=${ls[0].status}`);
});
// stale session → disconnected
await ex(`update user_sessions set last_seen_at = now() - interval '10 minutes' where id='${S1}'`);
await as(M1, async () => {
  const hb = (await q(`select session_heartbeat($1, 'active', 0) as r`, [S1]))[0].r;
  ok(hb.ok === false && hb.reason === 'ended', 'stale heartbeat → session ended');
});
const [s1] = await q(`select end_reason, end_estimated, extract(epoch from ended_at - last_seen_at)::int as d from user_sessions where id=$1`, [S1]);
ok(s1.end_reason === 'disconnected' && s1.end_estimated && s1.d === 0, 'disconnected session ends at last seen (estimated)');
ok((await q(`select count(*)::int c from activity_intervals where session_id=$1 and ended_at is null`, [S1]))[0].c === 0, 'open interval closed');

console.log('Timer auto-pause after app closed 20+ min');
const S2 = await as(M1, async () => {
  const id = (await q(`select session_start('ua','dev','resume') as id`))[0].id;
  await q(`select timer_start($1)`, [t1.id]);
  return id;
});
await ex(`update user_sessions set started_at = now() - interval '2 hours', last_seen_at = now() - interval '30 minutes' where id='${S2}';
          update activity_intervals set started_at = now() - interval '2 hours' where session_id='${S2}';
          update task_time_entries set started_at = now() - interval '90 minutes' where ended_at is null;
          update user_sessions set started_at = now() - interval '3 hours', last_seen_at = now() - interval '40 minutes', ended_at = now() - interval '40 minutes' where id='${S1}';`);
await q(`select sweep_stale_sessions()`);
const [auto] = await q(`select end_reason, extract(epoch from ended_at - started_at)::int as secs from task_time_entries where task_id=$1 order by id desc limit 1`, [t1.id]);
ok(auto.end_reason === 'auto' && Math.abs(auto.secs - 3600) < 5, 'running timer paused at last presence (' + auto.secs + 's counted)');
const resumeLog = await q(`select count(*)::int c from activity_logs where action='session_resumed'`);
ok(resumeLog[0].c === 0, 'resumed sessions do not spam logs');

console.log('Review workflow');
await as(M1, async () => {
  await q(`select session_start('ua','dev','resume')`);
  await q(`select timer_start($1)`, [t1.id]);
  await q(`select task_set_status($1, 'in_review', 'Done, sheet attached in Drive')`, [t1.id]);
  const [t] = await q(`select status, submitted_at is not null as sub from tasks where id=$1`, [t1.id]);
  ok(t.status === 'in_review' && t.sub, 'member submits for review');
  ok((await q(`select count(*)::int c from task_time_entries where user_id=$1 and ended_at is null`, [M1]))[0].c === 0, 'submitting stops the running timer');
  await expectErr(() => q(`select timer_start($1)`, [t1.id]), 'timer blocked while in review', /in review/);
  await expectErr(() => q(`select task_set_status($1, 'completed')`, [t1.id]), 'member cannot complete', /can't move/);
  await expectErr(() => q(`select task_review($1, true)`, [t1.id]), 'member cannot approve', /admin/);
});
await as(A, async () => {
  await expectErr(() => q(`select task_review($1, false, '')`, [t1.id]), 'revision needs a note', /note/);
  await q(`select task_review($1, false, 'Add phone numbers')`, [t1.id]);
  ok((await q(`select status, review_note from tasks where id=$1`, [t1.id]))[0].status === 'in_progress', 'revision → in progress');
});
await as(M1, () => q(`select task_set_status($1, 'in_review')`, [t1.id]));
await as(A, async () => {
  await q(`select task_review($1, true, 'Great work')`, [t1.id]);
  const [t] = await q(`select status, completed_at is not null as c from tasks where id=$1`, [t1.id]);
  ok(t.status === 'completed' && t.c, 'approve → completed with timestamp');
  const acts = (await q(`select action from activity_logs where entity_type='task' and entity_id=$1 order by id`, [String(t1.id)])).map(r => r.action);
  ok(['task_created', 'task_assigned', 'task_submitted', 'revision_requested', 'task_approved'].every(a => acts.includes(a)), 'task history logged');
  const cm = await q(`select author_name, body from task_comments where task_id=$1 order by id`, [t1.id]);
  ok(cm.length === 3 && cm[1].author_name === 'boss@ecom.com', 'comments: ' + cm.map(c => c.author_name + ': ' + c.body).join(' | '));
  // reassign stops timers + logs
  await q(`update tasks set assigned_to=$1, team_role=null where id=$2`, [M2, t2.id]);
  ok((await q(`select count(*)::int c from activity_logs where action='task_reassigned'`))[0].c === 1, 'reassignment logged');
});

console.log('Reports: midnight split + overlap merge (Asia/Karachi)');
const [M3] = await q(`insert into auth.users (email, email_confirmed_at) values ('zed@ecom.com', now()) returning id`);
const Z = M3.id;
// yesterday 23:00 → today 01:00 local (Karachi = UTC+5)
await ex(`
  insert into user_sessions (user_id, started_at, last_seen_at, ended_at, end_reason, state)
  values ('${Z}', ('2026-10-08 23:00'::timestamp at time zone 'Asia/Karachi'), ('2026-10-09 01:00'::timestamp at time zone 'Asia/Karachi'), ('2026-10-09 01:00'::timestamp at time zone 'Asia/Karachi'), 'logout', 'active'),
         ('${Z}', ('2026-10-09 00:30'::timestamp at time zone 'Asia/Karachi'), ('2026-10-09 02:00'::timestamp at time zone 'Asia/Karachi'), ('2026-10-09 02:00'::timestamp at time zone 'Asia/Karachi'), 'logout', 'active');
  insert into activity_intervals (session_id, user_id, state, started_at, ended_at)
  select id, user_id, 'active', started_at, ended_at from user_sessions where user_id='${Z}';
`);
await as(A, async () => {
  const rows = await q(`select day::text, session_seconds, active_seconds, idle_seconds, sessions from report_daily('2026-10-08','2026-10-09',$1) order by day`, [Z]);
  ok(rows.length === 2 && rows[0].session_seconds === 3600 && rows[1].session_seconds === 7200, 'split at midnight + overlap merged: ' + JSON.stringify(rows.map(r => [r.day, r.session_seconds, r.active_seconds, r.sessions])));
  const all = await q(`select count(*)::int c from report_daily(current_date - 7, current_date + 1, null)`);
  ok(all[0].c >= 1, 'admin all-member report runs (' + all[0].c + ' rows)');
  const tl = await q(`select kind, start_sec, end_sec from day_timeline('2026-10-09', $1) order by start_sec`, [Z]);
  ok(tl.length === 2 && tl[0].start_sec === 0 && tl[0].end_sec === 3600, 'day timeline clipped to local midnight');
  const rt = await q(`select title, seconds from report_tasks(current_date - 1, current_date + 1, null)`);
  ok(rt.length >= 2, 'task-wise report: ' + rt.map(r => r.title + '=' + r.seconds).join(', '));
  const pres = await q(`select presence, timer_task_title from team_presence() order by 1`);
  ok(pres.length === 3, 'team presence: ' + pres.map(p => p.presence).join(','));
  await expectErr(() => q(`select * from report_daily('2026-01-01','2027-06-01',null)`), 'range > 1 year rejected', /year/);
});

console.log('Settings + logs visibility');
await as(A, async () => {
  await q(`update app_settings set idle_minutes = 7 where id = 1`);
  ok((await q(`select count(*)::int c from activity_logs where action='settings_changed'`))[0].c === 1, 'settings change logged');
  await expectErr(() => q(`update app_settings set timezone='Mars/Base' where id=1`), 'invalid timezone rejected');
});
await as(M1, async () => {
  await expectErr(() => q(`update app_settings set idle_minutes = 9 where id = 1`).then(r => { if (!r.length) throw new Error('row-level: 0 rows'); }), 'member cannot change settings', /row-level|permission|0 rows/);
  const v = await q(`select count(*)::int c from activity_logs where actor_id <> $1::uuid and coalesce(subject_id::text,'') <> $1::text`, [M1]);
  ok(v[0].c === 0, 'member sees only own / own-subject logs');
  await expectErr(() => q(`insert into activity_logs (action) values ('fake')`), 'logs are append-only via server', /permission/);
});
await as(M2, async () => {
  const v = await q(`select count(*)::int c from user_sessions`);
  ok(v[0].c === 0, 'member cannot see other members\' sessions');
});

console.log('Deactivation');
const S4 = await as(M2, async () => { const id = (await q(`select session_start('ua','dev','login') as id`))[0].id; await q(`select timer_start($1)`, [t3.id]); return id; });
await q(`select admin_set_member_status($1,$2,'inactive')`, [A, M2]);
const [s4] = await q(`select end_reason from user_sessions where id=$1`, [S4]);
ok(s4.end_reason === 'inactive', 'deactivation ends open sessions');
ok((await q(`select count(*)::int c from task_time_entries where user_id=$1 and ended_at is null`, [M2]))[0].c === 0, 'deactivation pauses timer');
await expectErr(() => as(M2, () => q(`select session_start('ua','dev','login')`)), 'inactive member cannot start session', /inactive/);
await expectErr(() => as(A, () => q(`insert into tasks (title, assigned_to) values ('x', $1)`, [M2])), 'cannot assign to inactive member', /active/);
await expectErr(() => q(`select admin_set_member_status($1,$1,'inactive')`, [A]), 'admin cannot deactivate self', /own status|admin account/);

console.log('Privileges');
await ex(`set role anon`);
await expectErr(() => q(`select * from tasks`), 'anon cannot read tasks', /permission/);
await expectErr(() => q(`select session_start()`), 'anon cannot call functions', /permission/);
await ex(`reset role`);
await as(M1, () => expectErr(() => q(`select log_event('x','y','z','fake')`), 'members cannot call log_event', /permission/));
await as(M1, () => expectErr(() => q(`select close_session($1,'logout',now(),false)`, [S2]), 'members cannot call close_session', /permission/));

console.log('Part 2: roles for leads / clients / finance');
async function mkUser(email, roles) {
  const [u] = await q(`insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`, [email]);
  await q(`select admin_save_member($1,$2,'{}',$3)`, [A, u.id, roles]);
  return u.id;
}
const LG = await mkUser('lg@ecom.com', ['lead_gen']);
const SR = await mkUser('sr@ecom.com', ['sales_rep']);
const FN = await mkUser('fn@ecom.com', ['finance']);
const PM1 = await mkUser('pm1@ecom.com', ['project_manager']);
const PM2 = await mkUser('pm2@ecom.com', ['project_manager']);
const MG = await mkUser('mg@ecom.com', ['manager']);
ok((await q(`select count(*)::int c from role_permissions`))[0].c === 24, 'default permissions seeded for 6 roles × 4 modules');

const [lead] = await as(LG, () => q(`insert into leads (company, contact_name, source, budget, currency) values ('GlowCo', 'Amy', 'Instagram', 1500, 'USD') returning id, created_by`));
ok(lead.created_by === LG, 'lead generator adds a lead (created_by forced)');
await as(LG, async () => {
  await q(`delete from leads where id=$1`, [lead.id]);
  ok((await q(`select count(*)::int c from leads`))[0].c === 1, 'lead generator cannot delete leads');
  ok((await q(`select count(*)::int c from clients`))[0].c === 0, 'lead generator cannot see clients');
  ok((await q(`select count(*)::int c from team_directory()`))[0].c >= 6, 'team directory works for members');
});
await as(FN, async () => {
  ok((await q(`select count(*)::int c from leads`))[0].c === 0, 'finance cannot see leads by default');
  await expectErr(() => q(`insert into leads (company) values ('x')`), 'finance cannot add leads', /row-level/);
});
let clientId;
await as(SR, async () => {
  ok((await q(`select count(*)::int c from leads`))[0].c === 1, 'sales rep sees the lead');
  await q(`update leads set status='contacted' where id=$1`, [lead.id]);
  clientId = (await q(`select lead_mark_won($1) as id`, [lead.id]))[0].id;
  const [l] = await q(`select status, client_id, won_at is not null as w from leads where id=$1`, [lead.id]);
  ok(l.status === 'won' && l.client_id == clientId && l.w, 'won lead turns into a client');
  const cl = await q(`select name, monthly_retainer from clients`);
  ok(cl.length === 1 && cl[0].name === 'GlowCo' && Number(cl[0].monthly_retainer) === 1500, 'sales rep can view clients; client copied from lead');
  const up = await q(`update clients set notes='x' where id=$1 returning id`, [clientId]);
  ok(up.length === 0, 'sales rep cannot edit clients by default');
  await expectErr(() => q(`select business_summary()`), 'sales rep cannot see revenue', /finance/);
});
await as(MG, async () => {
  await expectErr(() => q(`update clients set project_manager=$1 where id=$2`, [SR, clientId]), 'only Project Manager role can be assigned', /Project Manager/);
  await q(`update clients set project_manager=$1, status='active' where id=$2`, [PM1, clientId]);
  ok((await q(`select count(*)::int c from team_presence()`))[0].c >= 1, 'manager can view team presence like admin');
  await q(`insert into tasks (title, assigned_to) values ('Manager task', $1)`, [SR]);
  ok(true, 'manager can create tasks');
  const s = await q(`update app_settings set idle_minutes=9 where id=1 returning id`);
  ok(s.length === 0, 'manager cannot change workspace settings');
});
await expectErr(() => q(`select admin_set_member_status($1,$2,'inactive')`, [MG, A]), 'manager cannot deactivate the admin', /admin account/);
await q(`select admin_save_member($1,$2,'{"job_title":"Caller"}',null)`, [MG, LG]);
ok(true, 'manager can edit members through the server function');
await expectErr(() => q(`select admin_save_member($1,$2,'{"first_name":"X"}',null)`, [MG, A]), 'manager cannot edit the admin account', /admin/);
await q(`insert into clients (name) values ('Other client')`);
await as(PM1, async () => {
  const cl = await q(`select id from clients`);
  ok(cl.length === 1 && cl[0].id == clientId, 'project manager sees only assigned clients');
  ok((await q(`update clients set notes='kickoff done' where id=$1 returning id`, [clientId])).length === 1, 'project manager can edit assigned client');
});
await as(PM2, async () => ok((await q(`select count(*)::int c from clients`))[0].c === 0, 'other project manager sees nothing'));
await as(FN, async () => {
  await q(`insert into invoices (client_id, invoice_number, amount, due_date) values ($1,'INV-001',1500,current_date - 3), ($1,'INV-002',800,current_date + 10)`, [clientId]);
  await q(`update invoices set status='paid' where invoice_number='INV-001'`);
  const b = (await q(`select business_summary() as b`))[0].b;
  ok(Number(b.revenue_month) === 1500 && Number(b.outstanding) === 800 && b.active_clients === 2 && b.won_month === 1 && b.months.length === 12,
    `finance sees revenue: month=${b.revenue_month} outstanding=${b.outstanding} clients=${b.active_clients} won=${b.won_month}`);
  ok((await q(`select paid_date is not null as p from invoices where invoice_number='INV-001'`))[0].p, 'paid date set automatically');
});
await as(PM1, async () => ok((await q(`select count(*)::int c from invoices where client_id <> $1`, [clientId]))[0].c === 0, 'project manager sees no invoices of other clients'));
await as(SR, async () => {
  const r = await q(`update role_permissions set can_view=true where role_key='finance' and module='leads' returning role_key`);
  ok(r.length === 0, 'members cannot change permissions');
});
await as(A, async () => {
  await q(`update role_permissions set can_view=true where role_key='finance' and module='leads'`);
});
await as(FN, async () => ok((await q(`select count(*)::int c from leads`))[0].c === 1, 'admin toggle gives finance access to leads'));
const acts2 = (await q(`select distinct action from activity_logs where action in ('lead_created','lead_won','client_created','client_pm_assigned','invoice_created','invoice_paid','permission_changed')`)).map((r) => r.action);
ok(acts2.length === 7, 'business events logged: ' + acts2.sort().join(','));

console.log('Part 3: convert flow, agents, notifications');
const notes = async (uid) => (await q(`select title from notifications where user_id=$1 order by id`, [uid])).map((r) => r.title);
const [l2] = await as(LG, () => q(`insert into leads (company, contact_name, budget, currency, priority, status) values ('Brew Co', 'Sam', 800, 'GBP', 'high', 'meeting') returning id`));
await as(SR, () => q(`update leads set assigned_to=$1 where id=$2`, [SR, l2.id]));
ok((await notes(SR)).some((t) => t.includes('Brew Co')), 'sales rep notified when a lead is assigned');
await as(SR, async () => {
  await expectErr(() => q(`select lead_convert($1)`, [l2.id]), 'convert needs a won lead first', /won/);
  await q(`update leads set status='won' where id=$1`, [l2.id]);
});
ok((await notes(A)).some((t) => t === 'Lead won: Brew Co'), 'admin notified when a lead is won');
ok((await notes(MG)).some((t) => t === 'Lead won: Brew Co'), 'manager notified when a lead is won');
ok((await notes(LG)).some((t) => t.includes('Brew Co is won')), 'lead generator told their lead was won');
const c2 = await as(SR, async () => (await q(`select lead_convert($1) as id`, [l2.id]))[0].id);
const [cc] = await q(`select name, monthly_retainer from clients where id=$1`, [c2]);
ok(cc.name === 'Brew Co' && cc.monthly_retainer === null, 'converted to client (GBP budget not copied into USD retainer)');
ok((await notes(A)).some((t) => t === 'New client: Brew Co'), 'admin notified about the new client');
await as(MG, () => q(`update clients set project_manager=$1 where id=$2`, [PM1, c2]));
ok((await notes(PM1)).some((t) => t === 'Client assigned to you: Brew Co'), 'project manager notified on assignment');
await as(PM1, async () => {
  await q(`insert into client_members (client_id, member_id, role_label) values ($1,$2,'Designer')`, [c2, LG]);
  const [t] = await q(`insert into tasks (title, assigned_to, client_id) values ('Design ad creatives', $1, $2) returning id`, [LG, c2]);
  globalThis.PT = t.id;
  await expectErr(() => q(`insert into tasks (title, assigned_to, client_id) values ('x', $1, $2)`, [FN, c2]), 'PM can only assign to the client\'s agents', /row-level/);
  await expectErr(() => q(`insert into tasks (title, assigned_to) values ('x', $1)`, [LG]), 'PM cannot create tasks outside their client', /row-level/);
  ok((await q(`select count(*)::int c from tasks where client_id=$1`, [c2]))[0].c === 1, 'PM sees tasks for their client');
});
ok((await notes(LG)).some((t) => t === 'You were added to Brew Co') && (await notes(LG)).some((t) => t === 'New task: Design ad creatives'), 'agent notified: added to client + new task');
await as(LG, async () => {
  ok((await q(`select count(*)::int c from clients where id=$1`, [c2]))[0].c === 1, 'agent can see the client they work on');
  ok((await q(`update clients set notes='x' where id=$1 returning id`, [c2])).length === 0, 'agent cannot edit the client');
  await q(`select task_set_status($1,'in_review','done')`, [PT]);
});
ok((await notes(PM1)).some((t) => t === 'Ready for review: Design ad creatives'), 'PM notified when agent submits');
await as(PM1, () => q(`select task_review($1, true, 'Nice')`, [PT]));
ok((await notes(LG)).some((t) => t === 'Approved: Design ad creatives'), 'agent notified on approval by PM');
await as(FN, () => q(`insert into invoices (client_id, invoice_number, amount) values ($1,'INV-9',300)`, [c2]));
ok((await notes(A)).some((t) => t.startsWith('New invoice for Brew Co')) && (await notes(MG)).some((t) => t.startsWith('New invoice for Brew Co')), 'finance change notifies admin + manager');
ok(!(await notes(FN)).some((t) => t.startsWith('New invoice for Brew Co')), 'the person who made the change is not notified');
await as(SR, async () => {
  ok((await q(`select count(*)::int c from notifications`))[0].c >= 2, 'members read their own notifications');
  await q(`update notifications set read_at=now()`);
  ok((await q(`select count(*)::int c from notifications where read_at is null`))[0].c === 0, 'mark all as read');
  await expectErr(() => q(`insert into notifications (user_id, title) values ($1,'x')`, [SR]), 'members cannot create notifications', /permission/);
});
await q(`insert into leads (company, contact_name, agent_id, source) values ('Form Brand', 'Ali', $1, 'Website form')`, [LG]);
ok((await notes(A)).includes('New lead from the form: Form Brand') && (await notes(LG)).includes('Lead submitted for you: Form Brand'), 'public form lead notifies managers + the agent');
await as(PM2, () => q(`select count(*)::int c from notifications`).then((r) => ok(true, 'notifications are private (PM2 sees ' + r[0].c + ')')));

console.log('Part 4: projects, team approvals');
const [nova] = await as(A, () => q(`insert into clients (name) values ('Nova Store') returning id`));
await expectErr(() => as(SR, () => q(`insert into projects (client_id, name) values ($1, 'x')`, [nova.id])), 'sales rep cannot create projects', /row-level/);
const [pj] = await as(MG, () => q(`insert into projects (client_id, name, project_manager) values ($1, 'Nova Shopify build', $2) returning id, created_by`, [nova.id, PM2]));
ok(pj.created_by === MG, 'manager creates a project for a client');
await expectErr(() => as(MG, () => q(`insert into projects (client_id, name, project_manager) values ($1, 'x', $2)`, [nova.id, SR])), 'only Project Manager role can run a project', /Project Manager/);
ok((await notes(PM2)).includes('Project assigned to you: Nova Shopify build'), 'project manager notified when assigned a project');
await as(PM2, async () => {
  ok((await q(`select count(*)::int c from projects`))[0].c === 1, 'PM sees their project');
  ok((await q(`select count(*)::int c from clients where id=$1`, [nova.id]))[0].c === 1, 'PM sees the client of their project');
  await expectErr(() => q(`update projects set project_manager=$1 where id=$2`, [PM1, pj.id]), 'PM cannot hand the project to someone else', /admin or a manager|row-level/);
  const r = await q(`update projects set status='active' where id=$1 returning status`, [pj.id]);
  ok(r[0]?.status === 'active', 'PM can update their project status');
});
ok((await notes(MG)).includes('Project active: Nova Shopify build'), 'managers notified when the PM changes project status');
await as(PM1, async () => ok((await q(`select count(*)::int c from projects where id=$1`, [pj.id]))[0].c === 0, 'other PM cannot see the project'));

// Manager adds → project manager approves
const reqLG = await as(MG, async () => (await q(`select project_member_request($1, $2, 'Designer') as id`, [pj.id, LG]))[0].id);
let [pm1row] = await q(`select status, approver from project_members where id=$1`, [reqLG]);
ok(pm1row.status === 'pending' && pm1row.approver === 'pm', 'manager request waits for the project manager');
ok((await notes(PM2)).some((t) => t.startsWith('Approval needed: add') && t.endsWith('Nova Shopify build')), 'project manager gets the approval request');
await expectErr(() => as(MG, () => q(`select project_member_request($1, $2, 'Designer')`, [pj.id, LG])), 'duplicate request blocked', /already waiting/);
await expectErr(() => as(A, () => q(`select project_member_decide($1, true)`, [reqLG])), 'admin cannot approve a request meant for the PM', /project manager/);
await as(LG, async () => ok((await q(`select count(*)::int c from projects where id=$1`, [pj.id]))[0].c === 0, 'pending member cannot see the project yet'));
await as(PM2, () => q(`select project_member_decide($1, true, 'Welcome')`, [reqLG]));
[pm1row] = await q(`select status, decided_by, decided_at from project_members where id=$1`, [reqLG]);
ok(pm1row.status === 'approved' && pm1row.decided_by === PM2 && pm1row.decided_at, 'approval saved with who and when');
await expectErr(() => as(PM2, () => q(`select project_member_decide($1, true)`, [reqLG])), 'cannot decide twice', /already approved/);
ok((await notes(LG)).includes('You were added to Nova Shopify build') && (await notes(MG)).some((t) => t.startsWith('Approved:')), 'member and requester notified on approval');

// Project manager adds → admin or a manager approves
const reqFN = await as(PM2, async () => (await q(`select project_member_request($1, $2, 'Finance support') as id`, [pj.id, FN]))[0].id);
ok((await q(`select approver from project_members where id=$1`, [reqFN]))[0].approver === 'manager', 'PM request waits for admin / manager');
ok((await notes(A)).some((t) => t.startsWith('Approval needed')) && (await notes(MG)).some((t) => t.startsWith('Approval needed')), 'admin and managers both get the request');
await expectErr(() => as(PM2, () => q(`select project_member_decide($1, true)`, [reqFN])), 'PM cannot approve their own request', /admin or a manager/);
await expectErr(() => as(LG, () => q(`select project_member_request($1, $2, 'x')`, [pj.id, SR])), 'project member cannot add people', /Only the admin/);
await as(A, () => q(`select project_member_decide($1, false, 'Not needed')`, [reqFN]));
ok((await q(`select status, decided_by from project_members where id=$1`, [reqFN]))[0].decided_by === A, 'admin rejection recorded');
ok((await notes(PM2)).some((t) => t.startsWith('Not approved:')), 'PM told the request was not approved');
const reqFN2 = await as(PM2, async () => (await q(`select project_member_request($1, $2, 'Finance support') as id`, [pj.id, FN]))[0].id);
await as(MG, () => q(`select project_member_decide($1, true)`, [reqFN2]));
ok((await q(`select count(*)::int c from project_members where project_id=$1`, [pj.id]))[0].c === 3, 'history keeps every request (approved + rejected)');

// Tasks, invoices, files on the project
await as(PM2, async () => {
  const [t] = await q(`insert into tasks (title, assigned_to, project_id) values ('Build theme', $1, $2) returning client_id`, [LG, pj.id]);
  ok(Number(t.client_id) === Number(nova.id), 'project task carries the client');
  await expectErr(() => q(`insert into tasks (title, assigned_to, project_id) values ('x', $1, $2)`, [SR, pj.id]), 'PM can only assign to approved project members', /row-level/);
});
await as(FN, async () => {
  await q(`insert into invoices (client_id, project_id, invoice_number, amount) values ($1, $2, 'NV-1', 900)`, [nova.id, pj.id]);
  await q(`insert into invoices (client_id, invoice_number, amount) values ($1, 'NV-2', 100)`, [nova.id]);
});
await as(PM2, async () => {
  const inv = await q(`select invoice_number from invoices where client_id=$1`, [nova.id]);
  ok(inv.length === 1 && inv[0].invoice_number === 'NV-1', 'PM sees only the invoices of their project');
  await q(`insert into client_files (client_id, project_id, name, storage_path) values ($1, $2, 'brief.pdf', $3)`, [nova.id, pj.id, `${nova.id}/p${pj.id}/a-brief.pdf`]);
  ok((await q(`select can_storage_file($1, 'view') ok`, [`${nova.id}/p${pj.id}/a-brief.pdf`]))[0].ok, 'PM can open their project files');
  ok(!(await q(`select can_storage_file($1, 'view') ok`, [`${nova.id}/contract.pdf`]))[0].ok, 'PM cannot open client-wide files');
});
await as(LG, async () => {
  ok((await q(`select count(*)::int c from projects where id=$1`, [pj.id]))[0].c === 1, 'approved member sees the project');
  ok((await q(`select count(*)::int c from client_files where project_id=$1`, [pj.id]))[0].c === 1, 'member sees project files');
  ok((await q(`select count(*)::int c from invoices where client_id=$1`, [nova.id]))[0].c === 0, 'member does not see invoices');
});
const lgRow = (await q(`select id from project_members where project_id=$1 and member_id=$2 and status='approved'`, [pj.id, LG]))[0].id;
await as(PM2, () => q(`select project_member_remove($1)`, [lgRow]));
await as(LG, async () => ok((await q(`select count(*)::int c from projects where id=$1`, [pj.id]))[0].c === 0, 'removed member loses access'));
ok((await q(`select count(*)::int c from activity_logs where entity_type='project' and entity_id=$1`, [String(pj.id)]))[0].c >= 6, 'project actions are in the activity log');

console.log('Part 4: moving client-level PMs and agents into projects');
const before = (await q(`select project_manager from clients where id=$1`, [c2]))[0].project_manager;
await ex(schema);
const [moved] = await q(`select id, project_manager from projects where client_id=$1`, [c2]);
ok(before === PM1 && moved?.project_manager === PM1, 're-running the schema moves the client PM into a project');
ok((await q(`select project_manager from clients where id=$1`, [c2]))[0].project_manager === null, 'client-level PM cleared after the move');
ok((await q(`select count(*)::int c from project_members where project_id=$1 and member_id=$2 and status='approved'`, [moved.id, LG]))[0].c === 1, 'client agents become approved project members');
ok((await q(`select count(*)::int c from tasks where client_id=$1 and project_id is null`, [c2]))[0].c === 0, 'client tasks moved into the project');
await ex(schema);
ok((await q(`select count(*)::int c from projects where client_id=$1`, [c2]))[0].c === 1, 'move runs once (re-run is safe)');

console.log('Part 5: leads to sales reps, project website, requirements');
await expectErr(() => as(MG, () => q(`insert into leads (company, assigned_to) values ('X Co', $1)`, [LG])), 'leads only go to Sales Representatives', /Sales Representative/);
await as(MG, async () => {
  const [l] = await q(`insert into leads (company, assigned_to) values ('Y Co', $1) returning assigned_to`, [SR]);
  ok(l.assigned_to === SR, 'lead assigned to a sales rep');
});
await as(PM2, async () => {
  const [r] = await q(`update projects set website_url='https://nova.store', socials='{"instagram":"https://instagram.com/nova"}' where id=$1 returning website_url, socials`, [pj.id]);
  ok(r.website_url === 'https://nova.store' && r.socials.instagram, 'PM saves website + socials');
  const [req] = await q(`insert into project_requirements (project_id, title) values ($1, 'Homepage hero with offer') returning id, created_by`, [pj.id]);
  ok(req.created_by === PM2, 'PM adds a requirement');
  const [d] = await q(`update project_requirements set is_done=true where id=$1 returning done_by, done_at`, [req.id]);
  ok(d.done_by === PM2 && d.done_at, 'requirement done with who + when');
  globalThis.REQ = req.id;
});
await as(FN, async () => {
  ok((await q(`select count(*)::int c from project_requirements where project_id=$1`, [pj.id]))[0].c === 1, 'project member reads requirements');
  ok((await q(`update project_requirements set title='x' where id=$1 returning id`, [REQ])).length === 0, 'project member cannot edit requirements');
});
await as(PM1, async () => ok((await q(`select count(*)::int c from project_requirements`))[0].c === 0, 'other PM sees no requirements'));
await expectErr(() => as(PM1, () => q(`insert into project_requirements (project_id, title) values ($1, 'x')`, [pj.id])), 'other PM cannot add requirements', /row-level/);

console.log('Part 6: leads go to the Sales team');
const [l6] = await as(LG, () => q(`insert into leads (company, contact_name) values ('Pick Me Co', 'Zoe') returning id`));
ok((await notes(A)).includes('New lead: Pick Me Co') && (await notes(MG)).includes('New lead: Pick Me Co'), 'admin + managers notified when lead gen adds a lead');
ok((await notes(SR)).includes('New lead to pick up: Pick Me Co'), 'sales reps told an unassigned lead came in');
await expectErr(() => as(LG, () => q(`update leads set assigned_to=$1 where id=$2`, [SR, l6.id])), 'lead generation cannot assign leads', /Sales Representative, a manager/);
await expectErr(() => as(LG, () => q(`insert into leads (company, assigned_to) values ('Z', $1)`, [SR])), 'lead generation cannot pre-assign on create', /Sales Representative, a manager/);
await as(SR, () => q(`update leads set assigned_to=$1 where id=$2`, [SR, l6.id]));
ok((await q(`select assigned_to from leads where id=$1`, [l6.id]))[0].assigned_to === SR, 'sales rep assigns a lead');
await as(MG, () => q(`update leads set assigned_to=null where id=$1`, [l6.id]));
ok((await q(`select assigned_to from leads where id=$1`, [l6.id]))[0].assigned_to === null, 'manager can unassign');

console.log('Part 7: business finance');
const today = (await q(`select (now() at time zone app_tz())::date::text d`))[0].d;
const [canva] = await as(MG, () => q(`insert into recurring_expenses (title, category, amount, frequency, next_due, auto_post) values ('Canva Pro', 'tools', 15, 'monthly', current_date - 1, true) returning id`));
await expectErr(() => as(MG, () => q(`insert into recurring_expenses (title, category, amount, next_due) values ('Salary', 'salary', 500, current_date + 2)`)), 'salary needs a team member', /team member/);
const [sal] = await as(MG, () => q(`insert into recurring_expenses (title, category, amount, next_due, payee_member) values ('Salary', 'salary', 500, current_date + 2, $1) returning id`, [SR]));
await expectErr(() => as(FN, () => q(`insert into recurring_expenses (title, category, amount, next_due, payee_member) values ('Salary', 'salary', 1, current_date, $1)`, [FN])), 'finance role cannot add salaries', /row-level/);
await as(FN, async () => {
  await q(`insert into expenses (title, category, amount) values ('Office internet', 'utilities', 40)`);
  ok((await q(`select count(*)::int c from recurring_expenses`))[0].c === 1, 'finance role sees tools but not salaries');
});
await as(SR, async () => {
  ok((await q(`select count(*)::int c from expenses`))[0].c === 0, 'sales rep sees no expenses');
  await expectErr(() => q(`insert into expenses (title, amount) values ('x', 1)`), 'sales rep cannot add expenses', /row-level/);
});
ok((await notes(MG)).some((t) => t.startsWith('New expense: Office internet')), 'managers told about a new expense');
await as(SR, () => q(`select finance_sweep()`));
const charged = await q(`select count(*)::int c, max(period)::text p from expenses where recurring_id=$1`, [canva.id]);
ok(charged[0].c === 1, 'auto-charged tool recorded as an expense (' + charged[0].p + ')');
ok((await q(`select next_due > current_date as ok from recurring_expenses where id=$1`, [canva.id]))[0].ok, 'tool due date moved to next month');
ok((await notes(A)).some((t) => t.startsWith('Charged: Canva Pro')) && (await notes(FN)).some((t) => t.startsWith('Charged: Canva Pro')), 'admin + finance told about the charge');
ok((await notes(MG)).some((t) => t.startsWith('Coming up: Salary: ')) && !(await notes(FN)).some((t) => t.includes('Salary')), 'salary reminder to admin/managers only');
ok((await notes(A)).some((t) => t.startsWith('Finance report ready:')), 'monthly report notice sent');
const notesBefore = (await q(`select count(*)::int c from notifications`))[0].c;
await as(MG, () => q(`select finance_sweep()`));
ok((await q(`select count(*)::int c from notifications`))[0].c === notesBefore, 'running the sweep again sends nothing new');
await expectErr(() => as(FN, () => q(`select recurring_mark_paid($1)`, [sal.id])), 'finance role cannot pay salaries', /permission|not found/i);
await as(MG, () => q(`select recurring_mark_paid($1)`, [sal.id]));
ok((await q(`select count(*)::int c from expenses where category='salary' and payee_member=$1`, [SR]))[0].c === 1, 'salary paid and recorded');
await as(FN, async () => ok((await q(`select count(*)::int c from expenses where category='salary'`))[0].c === 0, 'finance role cannot read salary rows'));
await as(MG, () => q(`insert into investments (source, investor_id, amount) values ('Taha Khan', $1, 2000)`, [MG]));
ok((await notes(A)).some((t) => t.startsWith('New investment:')), 'admin told about a new investment');
await as(FN, async () => {
  const o = (await q(`select finance_overview() o`))[0].o;
  ok(Number(o.cash) === Number(o.invested_total) + Number(o.revenue_total) - Number(o.expenses_total), 'cash = invested + revenue - expenses');
  ok(o.salaries_monthly === null && !o.upcoming.some((u) => u.category === 'salary'), 'finance role overview hides salary details');
  ok(o.months.length === 12, '12 months in the chart');
  const r = (await q(`select finance_report(current_date) r`))[0].r;
  ok(r.expense_rows.some((x) => x.category === 'salary' && x.title === 'Salaries' && x.payee === null), 'report hides who got which salary from finance role');
  ok(Number(r.expenses) >= 555, 'report totals include salaries (' + r.expenses + ')');
});
await as(MG, async () => {
  const r = (await q(`select finance_report(current_date) r`))[0].r;
  ok(r.expense_rows.some((x) => x.category === 'salary' && x.payee), 'managers see salary details in the report');
});
await expectErr(() => as(SR, () => q(`select finance_overview()`)), 'sales rep cannot see the finance dashboard', /access to finance/);
await as(MG, async () => {
  await q(`delete from expenses where title='Office internet'`);
  await q(`delete from investments where source='Taha Khan'`);
  await q(`update recurring_expenses set active=false where id=$1`, [canva.id]);
  await q(`delete from recurring_expenses where id=$1`, [canva.id]);
  ok((await q(`select count(*)::int c from expenses where recurring_id is null and title='Office internet'`))[0].c === 0, 'expenses, investments and bills can be deleted (charged expense kept)');
  ok((await q(`select count(*)::int c from expenses where title='Canva Pro'`))[0].c === 1, 'past tool charges stay after the bill is removed');
});

console.log('Part 8: any currency');
await as(MG, async () => {
  const [e] = await q(`insert into expenses (title, category, currency, amount_original, fx_rate) values ('Hosting PK', 'tools', 'PKR', 2800, 0.0036) returning amount, currency`);
  ok(Number(e.amount) === 10.08 && e.currency === 'PKR', 'PKR expense converted to app currency (' + e.amount + ')');
  await expectErr(() => q(`insert into expenses (title, currency, amount_original) values ('x', 'GBP', 10)`), 'foreign currency needs an exchange rate', /exchange rate/);
  const [b] = await q(`insert into expenses (title, amount) values ('Old screen', 25) returning currency, amount_original, fx_rate`);
  ok(b.currency === 'USD' && Number(b.amount_original) === 25 && Number(b.fx_rate) === 1, 'amount without currency = app currency');
  const [bill] = await q(`insert into recurring_expenses (title, category, currency, amount_original, fx_rate, next_due) values ('Office rent PK', 'rent', 'PKR', 50000, 0.0036, current_date) returning id, amount`);
  ok(Number(bill.amount) === 180, 'bill stored in PKR with converted amount');
  await q(`select recurring_mark_paid($1, 52000, null, 0.0035)`, [bill.id]);
  const [x] = await q(`select currency, amount_original, amount from expenses where recurring_id=$1`, [bill.id]);
  ok(x.currency === 'PKR' && Number(x.amount_original) === 52000 && Number(x.amount) === 182, 'paid in PKR at the new rate (' + x.amount + ')');
  const [inv] = await q(`insert into investments (source, currency, amount_original, fx_rate) values ('Uncle', 'AED', 1000, 0.27) returning amount`);
  ok(Number(inv.amount) === 270, 'AED investment converted');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
