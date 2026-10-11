-- =====================================================================
--  Remove TEST accounts completely (profile, login, sessions, time, logs)
--  1) Put the test emails in the list below (keep the quotes and commas).
--  2) Run. The admin account is never touched.
--  Tasks / leads / clients they created stay, but show "Unassigned" / no owner.
-- =====================================================================
do $$
declare
  v_emails text[] := array[
    'test1@example.com',
    'test2@example.com'
  ];
  v_ids uuid[];
  r record;
  v_tables text[] := '{}';
  t text;
begin
  select array_agg(id) into v_ids from public.profiles
   where lower(email) = any (select lower(e) from unnest(v_emails) e) and role <> 'admin';
  if v_ids is null then raise notice 'No matching test accounts found'; return; end if;

  -- every table that points at a profile
  for r in select distinct c.conrelid::regclass::text t from pg_constraint c
           where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass loop
    v_tables := v_tables || r.t;
  end loop;
  foreach t in array v_tables loop execute format('alter table %s disable trigger user', t); end loop;

  -- their own history: gone
  delete from public.activity_logs where actor_id = any (v_ids) or subject_id = any (v_ids);
  delete from public.activity_intervals where user_id = any (v_ids);
  delete from public.user_sessions where user_id = any (v_ids);
  delete from public.task_time_entries where user_id = any (v_ids);
  delete from public.task_comments where author_id = any (v_ids);
  delete from public.notifications where user_id = any (v_ids);
  delete from public.project_members where member_id = any (v_ids);
  delete from public.client_members where member_id = any (v_ids);
  delete from public.member_roles where member_id = any (v_ids);

  -- anything else that mentions them: clear the link (e.g. task "assigned to" → nobody)
  for r in select c.conrelid::regclass::text t, a.attname col, a.attnotnull nn
             from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
            where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass loop
    if r.nn then execute format('delete from %s where %I = any ($1)', r.t, r.col) using v_ids;
    else execute format('update %s set %I = null where %I = any ($1)', r.t, r.col, r.col) using v_ids; end if;
  end loop;

  foreach t in array v_tables loop execute format('alter table %s enable trigger user', t); end loop;

  -- the login itself (the profile row goes with it)
  delete from auth.users where id = any (v_ids);
  raise notice 'Removed % test account(s)', array_length(v_ids, 1);
end $$;
