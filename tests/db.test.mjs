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
await expectErr(() => q(`select admin_set_member_status($1,$1,'inactive')`, [A]), 'admin cannot deactivate self', /own status/);

console.log('Privileges');
await ex(`set role anon`);
await expectErr(() => q(`select * from tasks`), 'anon cannot read tasks', /permission/);
await expectErr(() => q(`select session_start()`), 'anon cannot call functions', /permission/);
await ex(`reset role`);
await as(M1, () => expectErr(() => q(`select log_event('x','y','z','fake')`), 'members cannot call log_event', /permission/));
await as(M1, () => expectErr(() => q(`select close_session($1,'logout',now(),false)`, [S2]), 'members cannot call close_session', /permission/));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
