-- =====================================================================
--  EcomHub OS — database setup
--  Supabase → SQL Editor → New query → paste this whole file → Run.
--  Safe to run again: tables are only created if missing and
--  functions / policies are replaced.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- Single-row app settings (timezone drives every report boundary)
create table if not exists public.app_settings (
  id            smallint primary key default 1 check (id = 1),
  company_name  text not null default 'Ecometrix Hub',
  timezone      text not null default 'Asia/Karachi',
  idle_minutes  int  not null default 5 check (idle_minutes between 1 and 60),
  updated_at    timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict (id) do nothing;

-- Team roles (a member can hold several)
create table if not exists public.team_roles (
  key          text primary key,
  name         text not null,
  description  text not null default '',
  sort         int  not null default 0
);
insert into public.team_roles (key, name, description, sort) values
  ('sales_rep',   'Sales Representative', 'Client conversations, proposals and closing deals', 1),
  ('lead_gen',    'Lead Generation',      'Finding and qualifying new prospects',              2),
  ('cold_caller', 'Cold Caller',          'Calling prospects and booking meetings',            3),
  ('finance',     'Finance',              'Invoices, payments and financial records',          4),
  ('manager',     'Manager',              'Coordinating the team and keeping work on track',   5)
on conflict (key) do update set name = excluded.name, description = excluded.description, sort = excluded.sort;

create sequence if not exists public.employee_code_seq;

-- One profile per Supabase Auth user
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  employee_code  text not null unique default ('EMP-' || lpad(nextval('public.employee_code_seq')::text, 4, '0')),
  first_name     text not null default '',
  last_name      text not null default '',
  email          text not null unique,
  phone          text,
  avatar_url     text,
  department     text,
  job_title      text,
  role           text not null default 'member' check (role in ('admin', 'member')),
  status         text not null default 'invited' check (status in ('invited', 'active', 'inactive', 'suspended')),
  joined_on      date default current_date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.member_roles (
  member_id   uuid not null references public.profiles(id) on delete cascade,
  role_key    text not null references public.team_roles(key) on update cascade,
  created_at  timestamptz not null default now(),
  primary key (member_id, role_key)
);

create table if not exists public.tasks (
  id            bigint generated always as identity primary key,
  title         text not null check (char_length(title) between 1 and 200),
  description   text not null default '',
  assigned_to   uuid references public.profiles(id),
  team_role     text references public.team_roles(key) on update cascade,
  created_by    uuid references public.profiles(id),
  priority      text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  status        text not null default 'todo' check (status in ('todo', 'in_progress', 'in_review', 'completed')),
  start_date    date,
  due_date      date,
  review_note   text,
  submitted_at  timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists tasks_assignee_idx on public.tasks (assigned_to, status);
create index if not exists tasks_due_idx on public.tasks (due_date);

create table if not exists public.task_comments (
  id           bigint generated always as identity primary key,
  task_id      bigint not null references public.tasks(id) on delete cascade,
  author_id    uuid not null references public.profiles(id),
  author_name  text not null default '',
  body         text not null check (char_length(body) between 1 and 4000),
  created_at   timestamptz not null default now()
);
create index if not exists task_comments_task_idx on public.task_comments (task_id, created_at);

-- Task timer: one row per start→pause/stop interval. Server timestamps only.
create table if not exists public.task_time_entries (
  id          bigint generated always as identity primary key,
  task_id     bigint not null references public.tasks(id),
  user_id     uuid not null references public.profiles(id),
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  end_reason  text check (end_reason in ('pause', 'stop', 'switch', 'logout', 'auto')),
  check (ended_at is null or ended_at >= started_at)
);
-- a member can only ever have one running timer
create unique index if not exists task_time_one_running on public.task_time_entries (user_id) where ended_at is null;
create index if not exists task_time_user_idx on public.task_time_entries (user_id, started_at);
create index if not exists task_time_task_idx on public.task_time_entries (task_id);

-- Login sessions (presence)
create table if not exists public.user_sessions (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id),
  started_at     timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  ended_at       timestamptz,
  end_reason     text check (end_reason in ('logout', 'expired', 'inactive', 'disconnected', 'unknown')),
  end_estimated  boolean not null default false,
  state          text not null default 'active' check (state in ('active', 'idle')),
  started_via    text not null default 'login' check (started_via in ('login', 'resume')),
  user_agent     text,
  device         text
);
create index if not exists user_sessions_user_idx on public.user_sessions (user_id, started_at desc);
create index if not exists user_sessions_open_idx on public.user_sessions (last_seen_at) where ended_at is null;

-- Active / idle intervals inside a session
create table if not exists public.activity_intervals (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references public.user_sessions(id) on delete cascade,
  user_id     uuid not null references public.profiles(id),
  state       text not null check (state in ('active', 'idle')),
  started_at  timestamptz not null,
  ended_at    timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create unique index if not exists activity_one_open on public.activity_intervals (session_id) where ended_at is null;
create index if not exists activity_user_idx on public.activity_intervals (user_id, started_at);

-- Append-only audit trail
create table if not exists public.activity_logs (
  id           bigint generated always as identity primary key,
  actor_id     uuid references public.profiles(id),
  actor_name   text not null default '',
  subject_id   uuid references public.profiles(id),
  action       text not null,
  entity_type  text,
  entity_id    text,
  description  text not null default '',
  meta         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists activity_logs_time_idx on public.activity_logs (created_at desc);
create index if not exists activity_logs_actor_idx on public.activity_logs (actor_id, created_at desc);
create index if not exists activity_logs_subject_idx on public.activity_logs (subject_id, created_at desc);
create index if not exists activity_logs_entity_idx on public.activity_logs (entity_type, entity_id);


-- ---------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin' and status = 'active');
$$;

create or replace function public.app_tz() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select timezone from app_settings where id = 1), 'Asia/Karachi');
$$;

create or replace function public.member_name(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(first_name || ' ' || last_name), ''), email) from profiles where id = p_id;
$$;

-- Raises unless the caller is an active account. Returns the caller id.
create or replace function public.assert_active() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_status text;
begin
  if v_uid is null then raise exception 'You are not signed in'; end if;
  select status into v_status from profiles where id = v_uid;
  if v_status is distinct from 'active' then raise exception 'Your account is not active'; end if;
  return v_uid;
end $$;

-- Admin can view anyone; members only themselves.
create or replace function public.assert_can_view(p_user uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'You are not signed in'; end if;
  if not is_admin() and p_user is distinct from auth.uid() then
    raise exception 'You can only view your own records';
  end if;
end $$;

create or replace function public.log_event(
  p_action text, p_entity_type text, p_entity_id text, p_description text,
  p_meta jsonb default '{}'::jsonb, p_subject uuid default null, p_actor uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_actor uuid := coalesce(p_actor, auth.uid());
begin
  insert into activity_logs (actor_id, actor_name, subject_id, action, entity_type, entity_id, description, meta)
  values (v_actor, coalesce(member_name(v_actor), 'System'), p_subject, p_action, p_entity_type, p_entity_id,
          coalesce(p_description, ''), coalesce(p_meta, '{}'::jsonb));
end $$;


-- ---------------------------------------------------------------------
-- 3. Profiles: auto-create on signup / invite, admin bootstrap
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, first_name, last_name, status)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data ->> 'first_name', ''),
          coalesce(new.raw_user_meta_data ->> 'last_name', ''),
          case when new.email_confirmed_at is not null then 'active' else 'invited' end)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Run once from the SQL editor:  select public.promote_to_admin('you@company.com');
create or replace function public.promote_to_admin(p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if v_id is null then
    raise exception 'No user with email %. Create it first in Authentication → Users → Add user.', p_email;
  end if;
  insert into profiles (id, email, role, status) values (v_id, lower(trim(p_email)), 'admin', 'active')
  on conflict (id) do update set role = 'admin', status = 'active', updated_at = now();
  perform log_event('admin_provisioned', 'member', v_id::text, 'Admin account set up', '{}'::jsonb, v_id, v_id);
  return 'Done — ' || p_email || ' is now the admin.';
end $$;

create or replace function public.profiles_before_update() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.profiles_before_update();

-- Used by the server (secret key) when the admin adds or edits a member.
create or replace function public.admin_save_member(p_actor uuid, p_member uuid, p_fields jsonb, p_roles text[])
returns void
language plpgsql security definer set search_path = public as $$
declare v_old text[]; v_new text[];
begin
  if not exists (select 1 from profiles where id = p_actor and role = 'admin' and status = 'active') then
    raise exception 'Only the admin can manage members';
  end if;
  update profiles set
    first_name = coalesce(p_fields ->> 'first_name', first_name),
    last_name  = coalesce(p_fields ->> 'last_name', last_name),
    phone      = case when p_fields ? 'phone' then nullif(p_fields ->> 'phone', '') else phone end,
    department = case when p_fields ? 'department' then nullif(p_fields ->> 'department', '') else department end,
    job_title  = case when p_fields ? 'job_title' then nullif(p_fields ->> 'job_title', '') else job_title end,
    joined_on  = case when p_fields ? 'joined_on' then nullif(p_fields ->> 'joined_on', '')::date else joined_on end
  where id = p_member;
  if not found then raise exception 'Member not found'; end if;

  if p_roles is not null then
    select coalesce(array_agg(role_key order by role_key), '{}') into v_old from member_roles where member_id = p_member;
    delete from member_roles where member_id = p_member;
    insert into member_roles (member_id, role_key)
      select p_member, r from unnest(p_roles) as r where r in (select key from team_roles)
      on conflict do nothing;
    select coalesce(array_agg(role_key order by role_key), '{}') into v_new from member_roles where member_id = p_member;
    if v_old is distinct from v_new then
      perform log_event('member_roles_changed', 'member', p_member::text,
        'Updated roles for ' || member_name(p_member),
        jsonb_build_object('from', v_old, 'to', v_new), p_member, p_actor);
    end if;
  end if;
end $$;

create or replace function public.admin_set_member_status(p_actor uuid, p_member uuid, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_old text; s record;
begin
  if not exists (select 1 from profiles where id = p_actor and role = 'admin' and status = 'active') then
    raise exception 'Only the admin can manage members';
  end if;
  if p_member = p_actor then raise exception 'You cannot change your own status'; end if;
  if p_status not in ('active', 'inactive', 'suspended') then raise exception 'Invalid status'; end if;
  select status into v_old from profiles where id = p_member for update;
  if v_old is null then raise exception 'Member not found'; end if;
  update profiles set status = p_status where id = p_member;
  if p_status <> 'active' then
    for s in select id from user_sessions where user_id = p_member and ended_at is null loop
      perform close_session(s.id, 'inactive', now(), false);
    end loop;
  end if;
  perform log_event(case when p_status = 'active' then 'member_activated' else 'member_deactivated' end,
    'member', p_member::text,
    case when p_status = 'active' then 'Activated ' else initcap(p_status) || ': ' end || member_name(p_member),
    jsonb_build_object('from', v_old, 'to', p_status), p_member, p_actor);
end $$;


-- ---------------------------------------------------------------------
-- 4. Settings
-- ---------------------------------------------------------------------

create or replace function public.settings_before_update() returns trigger
language plpgsql as $$
begin
  perform now() at time zone new.timezone;  -- raises on an unknown timezone
  new.updated_at := now();
  return new;
end $$;

create or replace function public.settings_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.company_name, new.timezone, new.idle_minutes) is distinct from (old.company_name, old.timezone, old.idle_minutes) then
    perform log_event('settings_changed', 'settings', '1', 'Updated app settings',
      jsonb_build_object('from', jsonb_build_object('company_name', old.company_name, 'timezone', old.timezone, 'idle_minutes', old.idle_minutes),
                         'to',   jsonb_build_object('company_name', new.company_name, 'timezone', new.timezone, 'idle_minutes', new.idle_minutes)));
  end if;
  return new;
end $$;

drop trigger if exists settings_validate on public.app_settings;
create trigger settings_validate before update on public.app_settings
  for each row execute function public.settings_before_update();
drop trigger if exists settings_log on public.app_settings;
create trigger settings_log after update on public.app_settings
  for each row execute function public.settings_after_update();


-- ---------------------------------------------------------------------
-- 5. Tasks: validation + automatic audit log
-- ---------------------------------------------------------------------

create or replace function public.tasks_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();

  if new.status = 'completed' and (tg_op = 'INSERT' or old.status <> 'completed') then new.completed_at := now(); end if;
  if new.status <> 'completed' then new.completed_at := null; end if;
  if new.status = 'in_review' and (tg_op = 'INSERT' or old.status <> 'in_review') then new.submitted_at := now(); end if;

  if new.assigned_to is not null and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) then
    if not exists (select 1 from profiles where id = new.assigned_to and status in ('active', 'invited')) then
      raise exception 'Tasks can only be assigned to active or invited members';
    end if;
  end if;

  if new.assigned_to is not null and new.team_role is not null
     and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to or new.team_role is distinct from old.team_role)
     and not exists (select 1 from member_roles where member_id = new.assigned_to and role_key = new.team_role) then
    raise exception 'This member does not have the % role', (select name from team_roles where key = new.team_role);
  end if;
  return new;
end $$;

create or replace function public.stop_task_timers(p_task_id bigint, p_why text) returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in update task_time_entries set ended_at = greatest(started_at, now()), end_reason = 'stop'
           where task_id = p_task_id and ended_at is null returning user_id loop
    perform log_event('timer_stopped', 'task', p_task_id::text, 'Timer stopped (' || p_why || ')', '{}'::jsonb, r.user_id);
  end loop;
end $$;

create or replace function public.tasks_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_changes jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    perform log_event('task_created', 'task', new.id::text, 'Created task "' || new.title || '"',
      jsonb_build_object('priority', new.priority, 'due_date', new.due_date, 'team_role', new.team_role), new.assigned_to);
    if new.assigned_to is not null then
      perform log_event('task_assigned', 'task', new.id::text,
        'Assigned "' || new.title || '" to ' || member_name(new.assigned_to), '{}'::jsonb, new.assigned_to);
    end if;
    return new;
  end if;

  if new.assigned_to is distinct from old.assigned_to then
    perform stop_task_timers(new.id, 'task reassigned');
    perform log_event('task_reassigned', 'task', new.id::text,
      'Reassigned "' || new.title || '" to ' || coalesce(member_name(new.assigned_to), 'nobody'),
      jsonb_build_object('from', member_name(old.assigned_to), 'to', member_name(new.assigned_to)), new.assigned_to);
  end if;

  if new.status is distinct from old.status then
    if new.status in ('in_review', 'completed') then
      perform stop_task_timers(new.id, case when new.status = 'in_review' then 'submitted for review' else 'task completed' end);
    end if;
    perform log_event(
      case when new.status = 'in_review' then 'task_submitted'
           when old.status = 'in_review' and new.status = 'completed' then 'task_approved'
           when old.status = 'in_review' then 'revision_requested'
           else 'task_status_changed' end,
      'task', new.id::text,
      case when new.status = 'in_review' then 'Submitted "' || new.title || '" for review'
           when old.status = 'in_review' and new.status = 'completed' then 'Approved "' || new.title || '"'
           when old.status = 'in_review' then 'Requested changes on "' || new.title || '"'
           else 'Moved "' || new.title || '" to ' || replace(new.status, '_', ' ') end,
      jsonb_build_object('from', old.status, 'to', new.status), new.assigned_to);
  end if;

  if new.title is distinct from old.title then v_changes := v_changes || jsonb_build_object('title', jsonb_build_array(old.title, new.title)); end if;
  if new.description is distinct from old.description then v_changes := v_changes || jsonb_build_object('description', 'edited'); end if;
  if new.priority is distinct from old.priority then v_changes := v_changes || jsonb_build_object('priority', jsonb_build_array(old.priority, new.priority)); end if;
  if new.due_date is distinct from old.due_date then v_changes := v_changes || jsonb_build_object('due_date', jsonb_build_array(old.due_date, new.due_date)); end if;
  if new.start_date is distinct from old.start_date then v_changes := v_changes || jsonb_build_object('start_date', jsonb_build_array(old.start_date, new.start_date)); end if;
  if new.team_role is distinct from old.team_role then v_changes := v_changes || jsonb_build_object('team_role', jsonb_build_array(old.team_role, new.team_role)); end if;
  if v_changes <> '{}'::jsonb then
    perform log_event('task_updated', 'task', new.id::text, 'Updated "' || new.title || '"', v_changes, new.assigned_to);
  end if;
  return new;
end $$;

drop trigger if exists tasks_before on public.tasks;
create trigger tasks_before before insert or update on public.tasks
  for each row execute function public.tasks_before_write();
drop trigger if exists tasks_after on public.tasks;
create trigger tasks_after after insert or update on public.tasks
  for each row execute function public.tasks_after_write();

create or replace function public.comments_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.author_id := coalesce(auth.uid(), new.author_id);
  new.author_name := coalesce(member_name(new.author_id), '');
  new.created_at := now();
  new.body := trim(new.body);
  return new;
end $$;

drop trigger if exists comments_before on public.task_comments;
create trigger comments_before before insert on public.task_comments
  for each row execute function public.comments_before_insert();

-- Member moves their own task: To do ⇄ In progress → In review (submit)
create or replace function public.task_set_status(p_task_id bigint, p_status text, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); t tasks%rowtype;
begin
  select * into t from tasks where id = p_task_id for update;
  if not found or t.assigned_to is distinct from v_uid then raise exception 'Task not found or not assigned to you'; end if;
  if not ((t.status = 'todo' and p_status in ('in_progress', 'in_review'))
       or (t.status = 'in_progress' and p_status in ('todo', 'in_review'))) then
    raise exception 'This task can''t move from % to %', replace(t.status, '_', ' '), replace(p_status, '_', ' ');
  end if;
  update tasks set status = p_status where id = p_task_id;
  if nullif(trim(coalesce(p_note, '')), '') is not null then
    insert into task_comments (task_id, author_id, body) values (p_task_id, v_uid, trim(p_note));
  end if;
end $$;

-- Admin approves or sends back a submitted task
create or replace function public.task_review(p_task_id bigint, p_approve boolean, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); t tasks%rowtype; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not is_admin() then raise exception 'Only the admin can review tasks'; end if;
  select * into t from tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found'; end if;
  if t.status <> 'in_review' then raise exception 'This task is not waiting for review'; end if;
  if not p_approve and v_note is null then raise exception 'Add a note so the member knows what to change'; end if;
  update tasks set status = case when p_approve then 'completed' else 'in_progress' end, review_note = v_note
   where id = p_task_id;
  if v_note is not null then
    insert into task_comments (task_id, author_id, body)
    values (p_task_id, v_uid, case when p_approve then 'Approved: ' else 'Changes requested: ' end || v_note);
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 6. Sessions, heartbeats, active / idle
-- ---------------------------------------------------------------------

create or replace function public.close_session(p_session_id uuid, p_reason text, p_at timestamptz, p_estimated boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare s user_sessions%rowtype; r record;
begin
  select * into s from user_sessions where id = p_session_id for update;
  if not found or s.ended_at is not null then return; end if;
  p_at := greatest(s.started_at, least(p_at, now()));
  update activity_intervals set ended_at = greatest(started_at, p_at) where session_id = s.id and ended_at is null;
  update user_sessions
     set ended_at = p_at, end_reason = p_reason, end_estimated = p_estimated, last_seen_at = greatest(last_seen_at, p_at)
   where id = s.id;
  -- an explicit logout / deactivation pauses the running task timer
  if p_reason in ('logout', 'inactive')
     and not exists (select 1 from user_sessions where user_id = s.user_id and ended_at is null) then
    for r in update task_time_entries t set ended_at = greatest(t.started_at, p_at), end_reason = 'logout'
             where t.user_id = s.user_id and t.ended_at is null returning t.task_id loop
      perform log_event('timer_paused', 'task', r.task_id::text, 'Timer paused (signed out)', '{}'::jsonb, s.user_id, s.user_id);
    end loop;
  end if;
end $$;

-- Ends sessions that stopped sending heartbeats (browser closed, offline, laptop asleep)
-- and pauses timers left running with nobody in the app for 20+ minutes.
create or replace function public.sweep_stale_sessions() returns void
language plpgsql security definer set search_path = public as $$
declare s record; t record;
begin
  for s in select id, last_seen_at from user_sessions
            where ended_at is null and last_seen_at < now() - interval '3 minutes'
            for update skip locked loop
    perform close_session(s.id, 'disconnected', s.last_seen_at, true);
  end loop;

  for t in
    select te.id, te.user_id, te.task_id, te.started_at, ls.last_end
      from task_time_entries te
      join lateral (
        select max(coalesce(us.ended_at, us.last_seen_at)) as last_end, bool_or(us.ended_at is null) as has_open
          from user_sessions us where us.user_id = te.user_id
      ) ls on true
     where te.ended_at is null
       and not coalesce(ls.has_open, false)
       and coalesce(ls.last_end, te.started_at) < now() - interval '20 minutes'
  loop
    update task_time_entries
       set ended_at = greatest(t.started_at, coalesce(t.last_end, t.started_at)), end_reason = 'auto'
     where id = t.id and ended_at is null;
    perform log_event('timer_paused', 'task', t.task_id::text,
      'Timer paused automatically (EcomHub OS was closed)', '{}'::jsonb, t.user_id, t.user_id);
  end loop;
end $$;

create or replace function public.session_start(p_user_agent text default null, p_device text default null, p_via text default 'login')
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_status text; v_id uuid;
begin
  if v_uid is null then raise exception 'You are not signed in'; end if;
  select status into v_status from profiles where id = v_uid for update;
  if v_status is null then raise exception 'No profile found for this account'; end if;
  if v_status in ('inactive', 'suspended') then raise exception 'Your account is %. Contact the admin.', v_status; end if;
  if v_status = 'invited' then
    update profiles set status = 'active' where id = v_uid;
    perform log_event('invite_accepted', 'member', v_uid::text, member_name(v_uid) || ' joined the workspace', '{}'::jsonb, v_uid);
  end if;

  perform sweep_stale_sessions();

  insert into user_sessions (user_id, user_agent, device, started_via)
  values (v_uid, left(p_user_agent, 300), left(p_device, 80), case when p_via = 'login' then 'login' else 'resume' end)
  returning id into v_id;
  insert into activity_intervals (session_id, user_id, state, started_at) values (v_id, v_uid, 'active', now());

  if p_via = 'login' then
    perform log_event('login', 'session', v_id::text, 'Signed in' || coalesce(' on ' || nullif(p_device, ''), ''), '{}'::jsonb, v_uid);
  end if;
  return v_id;
end $$;

-- Called every minute by the open app, and right away when active ⇄ idle changes.
-- p_idle_for = seconds since the last interaction (only used to backdate the idle start).
create or replace function public.session_heartbeat(p_session_id uuid, p_state text, p_idle_for int default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  s user_sessions%rowtype;
  o activity_intervals%rowtype;
  v_now timestamptz := now();
  v_switch timestamptz;
begin
  if v_uid is null then raise exception 'You are not signed in'; end if;
  if p_state not in ('active', 'idle') then raise exception 'Invalid state'; end if;

  select * into s from user_sessions where id = p_session_id and user_id = v_uid for update;
  if not found or s.ended_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'ended', 'server_now', v_now);
  end if;
  if v_now - s.last_seen_at > interval '3 minutes' then
    perform close_session(s.id, 'disconnected', s.last_seen_at, true);
    return jsonb_build_object('ok', false, 'reason', 'ended', 'server_now', v_now);
  end if;

  select * into o from activity_intervals where session_id = s.id and ended_at is null for update;
  if o.id is null or o.state <> p_state then
    v_switch := v_now;
    if p_state = 'idle' then
      v_switch := greatest(coalesce(o.started_at, s.started_at),
                           v_now - make_interval(secs => least(greatest(coalesce(p_idle_for, 0), 0), 3600)));
    end if;
    if o.id is not null then update activity_intervals set ended_at = v_switch where id = o.id; end if;
    insert into activity_intervals (session_id, user_id, state, started_at) values (s.id, v_uid, p_state, v_switch);
  end if;

  update user_sessions set last_seen_at = v_now, state = p_state where id = s.id;
  perform sweep_stale_sessions();
  return jsonb_build_object('ok', true, 'server_now', v_now);
end $$;

create or replace function public.session_end(p_session_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not exists (select 1 from user_sessions where id = p_session_id and user_id = v_uid and ended_at is null) then return; end if;
  perform close_session(p_session_id, 'logout', now(), false);
  perform log_event('logout', 'session', p_session_id::text, 'Signed out', '{}'::jsonb, v_uid);
end $$;


-- ---------------------------------------------------------------------
-- 7. Task timer
-- ---------------------------------------------------------------------

create or replace function public.timer_start(p_task_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); t tasks%rowtype; r task_time_entries%rowtype; v_last text; v_started timestamptz;
begin
  perform 1 from profiles where id = v_uid for update;   -- one timer change per member at a time
  select * into t from tasks where id = p_task_id for update;
  if not found or t.assigned_to is distinct from v_uid then raise exception 'Task not found or not assigned to you'; end if;
  if t.status in ('in_review', 'completed') then
    raise exception 'This task is % — the timer is closed', replace(t.status, '_', ' ');
  end if;

  select * into r from task_time_entries where user_id = v_uid and ended_at is null;
  if found then
    if r.task_id = p_task_id then
      return jsonb_build_object('task_id', r.task_id, 'started_at', r.started_at, 'server_now', now());
    end if;
    update task_time_entries set ended_at = greatest(started_at, now()), end_reason = 'switch' where id = r.id;
    perform log_event('timer_paused', 'task', r.task_id::text, 'Timer paused (switched to another task)', '{}'::jsonb, v_uid);
  end if;

  select end_reason into v_last from task_time_entries
   where user_id = v_uid and task_id = p_task_id order by started_at desc limit 1;
  insert into task_time_entries (task_id, user_id, started_at) values (p_task_id, v_uid, now())
  returning started_at into v_started;
  if t.status = 'todo' then update tasks set status = 'in_progress' where id = p_task_id; end if;

  if v_last is not null and v_last <> 'stop' then
    perform log_event('timer_resumed', 'task', p_task_id::text, 'Timer resumed on "' || t.title || '"', '{}'::jsonb, v_uid);
  else
    perform log_event('timer_started', 'task', p_task_id::text, 'Timer started on "' || t.title || '"', '{}'::jsonb, v_uid);
  end if;
  return jsonb_build_object('task_id', p_task_id, 'started_at', v_started, 'server_now', now());
end $$;

create or replace function public.timer_pause() returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); v_task bigint;
begin
  update task_time_entries set ended_at = greatest(started_at, now()), end_reason = 'pause'
   where user_id = v_uid and ended_at is null returning task_id into v_task;
  if v_task is null then raise exception 'No timer is running'; end if;
  perform log_event('timer_paused', 'task', v_task::text, 'Timer paused', '{}'::jsonb, v_uid);
end $$;

create or replace function public.timer_stop(p_task_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); v_id bigint;
begin
  update task_time_entries set ended_at = greatest(started_at, now()), end_reason = 'stop'
   where user_id = v_uid and task_id = p_task_id and ended_at is null returning id into v_id;
  if v_id is null then
    -- stopping a paused timer only closes it; recorded time is unchanged
    update task_time_entries set end_reason = 'stop'
     where id = (select id from task_time_entries where user_id = v_uid and task_id = p_task_id order by started_at desc limit 1)
       and end_reason is distinct from 'stop'
    returning id into v_id;
  end if;
  if v_id is null then raise exception 'There is no timer to stop on this task'; end if;
  perform log_event('timer_stopped', 'task', p_task_id::text, 'Timer stopped', '{}'::jsonb, v_uid);
end $$;

create or replace function public.my_timer() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'server_now', now(),
    'running', (select jsonb_build_object('task_id', te.task_id, 'title', t.title, 'started_at', te.started_at)
                  from task_time_entries te join tasks t on t.id = te.task_id
                 where te.user_id = auth.uid() and te.ended_at is null limit 1));
$$;

-- Per task + member totals (RLS of the caller applies)
create or replace view public.task_time_totals with (security_invoker = true) as
select task_id, user_id,
       coalesce(sum(extract(epoch from coalesce(ended_at, now()) - started_at)), 0)::int as total_seconds,
       bool_or(ended_at is null) as running,
       (array_agg(end_reason order by started_at desc))[1] as last_end_reason,
       max(started_at) filter (where ended_at is null) as running_since
  from public.task_time_entries
 group by task_id, user_id;


-- ---------------------------------------------------------------------
-- 8. Presence, sessions list, reports
-- ---------------------------------------------------------------------

create or replace function public.team_presence()
returns table (user_id uuid, presence text, last_seen_at timestamptz, session_started_at timestamptz,
               timer_task_id bigint, timer_task_title text, timer_started_at timestamptz)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not is_admin() then raise exception 'Only the admin can view team presence'; end if;
  perform sweep_stale_sessions();
  return query
  select p.id,
         coalesce(s.state, 'offline'),
         coalesce(s.last_seen_at, (select max(coalesce(x.ended_at, x.last_seen_at)) from user_sessions x where x.user_id = p.id)),
         s.started_at,
         te.task_id, t.title, te.started_at
    from profiles p
    left join lateral (
      select us.state, us.last_seen_at, us.started_at from user_sessions us
       where us.user_id = p.id and us.ended_at is null
       order by us.last_seen_at desc limit 1) s on true
    left join task_time_entries te on te.user_id = p.id and te.ended_at is null
    left join tasks t on t.id = te.task_id
   where p.role = 'member';
end $$;

create or replace function public.list_sessions(p_from date, p_to date, p_user uuid default null)
returns table (id uuid, user_id uuid, member_name text, started_at timestamptz, last_seen_at timestamptz,
               ended_at timestamptz, end_reason text, end_estimated boolean, status text,
               duration_seconds int, active_seconds int, idle_seconds int, device text, user_agent text, started_via text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_tz text := app_tz();
begin
  perform assert_can_view(p_user);
  perform sweep_stale_sessions();
  return query
  with base as (
    select s.*, coalesce(s.ended_at, s.last_seen_at) as end_at,
           (select coalesce(sum(extract(epoch from greatest(coalesce(i.ended_at, s.last_seen_at), i.started_at) - i.started_at)), 0)
              from activity_intervals i where i.session_id = s.id and i.state = 'active') as act
      from user_sessions s
     where s.started_at >= (p_from::timestamp at time zone v_tz)
       and s.started_at <  ((p_to + 1)::timestamp at time zone v_tz)
       and (p_user is null or s.user_id = p_user)
  )
  select b.id, b.user_id, member_name(b.user_id), b.started_at, b.last_seen_at, b.ended_at, b.end_reason, b.end_estimated,
         case when b.ended_at is not null then 'ended' else b.state end,
         extract(epoch from b.end_at - b.started_at)::int,
         least(b.act, extract(epoch from b.end_at - b.started_at))::int,
         greatest(extract(epoch from b.end_at - b.started_at) - b.act, 0)::int,
         b.device, b.user_agent, b.started_via
    from base b
   order by b.started_at desc
   limit 2000;
end $$;

-- Daily totals per member, split on the app timezone's midnight, overlaps merged.
--   session = time signed in, active = interacting with the app,
--   idle = session − active, timer = time recorded on tasks (independent).
create or replace function public.report_daily(p_from date, p_to date, p_user uuid default null)
returns table (day date, user_id uuid, session_seconds int, active_seconds int, idle_seconds int, timer_seconds int, sessions int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_tz text := app_tz(); v_start timestamptz; v_end timestamptz;
begin
  perform assert_can_view(p_user);
  if p_to < p_from or p_to - p_from > 370 then raise exception 'Choose a date range of up to one year'; end if;
  perform sweep_stale_sessions();
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;

  return query
  with days as (
    select g::date as d,
           (g::date)::timestamp at time zone v_tz as ds,
           (g::date + 1)::timestamp at time zone v_tz as de
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g
  ),
  raw as (
    select s.user_id as uid, 'session'::text as kind, s.started_at as t0, coalesce(s.ended_at, s.last_seen_at) as t1
      from user_sessions s
     where s.started_at < v_end and coalesce(s.ended_at, s.last_seen_at) > v_start
       and (p_user is null or s.user_id = p_user)
    union all
    select i.user_id, 'active', i.started_at, coalesce(i.ended_at, s2.last_seen_at)
      from activity_intervals i join user_sessions s2 on s2.id = i.session_id
     where i.state = 'active' and i.started_at < v_end and coalesce(i.ended_at, s2.last_seen_at) > v_start
       and (p_user is null or i.user_id = p_user)
    union all
    select te.user_id, 'timer', te.started_at, coalesce(te.ended_at, now())
      from task_time_entries te
     where te.started_at < v_end and coalesce(te.ended_at, now()) > v_start
       and (p_user is null or te.user_id = p_user)
  ),
  clipped as (
    select r.uid, r.kind, d.d, greatest(r.t0, d.ds) as t0, least(r.t1, d.de) as t1
      from raw r join days d on r.t0 < d.de and r.t1 > d.ds
     where r.t1 > r.t0
  ),
  marked as (
    select c.*,
           case when max(c.t1) over w is null or max(c.t1) over w < c.t0 then 1 else 0 end as is_new
      from clipped c
    window w as (partition by c.uid, c.kind, c.d order by c.t0, c.t1 rows between unbounded preceding and 1 preceding)
  ),
  grouped as (
    select m.*, sum(m.is_new) over (partition by m.uid, m.kind, m.d order by m.t0, m.t1 rows unbounded preceding) as grp
      from marked m
  ),
  merged as (
    select g.uid, g.kind, g.d, extract(epoch from max(g.t1) - min(g.t0)) as secs
      from grouped g group by g.uid, g.kind, g.d, g.grp
  ),
  totals as (
    select m.uid, m.d,
           coalesce(sum(m.secs) filter (where m.kind = 'session'), 0) as ses,
           coalesce(sum(m.secs) filter (where m.kind = 'active'), 0)  as act,
           coalesce(sum(m.secs) filter (where m.kind = 'timer'), 0)   as tim
      from merged m group by m.uid, m.d
  ),
  starts as (
    select s.user_id as uid, (s.started_at at time zone v_tz)::date as d, count(*) as n
      from user_sessions s
     where s.started_at >= v_start and s.started_at < v_end and (p_user is null or s.user_id = p_user)
     group by 1, 2
  )
  select coalesce(t.d, st.d), coalesce(t.uid, st.uid),
         round(coalesce(t.ses, 0))::int,
         round(least(coalesce(t.act, 0), coalesce(t.ses, 0)))::int,
         round(greatest(coalesce(t.ses, 0) - coalesce(t.act, 0), 0))::int,
         round(coalesce(t.tim, 0))::int,
         coalesce(st.n, 0)::int
    from totals t
    full join starts st on st.uid = t.uid and st.d = t.d
   order by 1, 2;
end $$;

-- Time recorded per task inside the range (clipped to the range)
create or replace function public.report_tasks(p_from date, p_to date, p_user uuid default null)
returns table (task_id bigint, title text, user_id uuid, team_role text, status text, seconds int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_tz text := app_tz(); v_start timestamptz; v_end timestamptz;
begin
  perform assert_can_view(p_user);
  v_start := p_from::timestamp at time zone v_tz;
  v_end := (p_to + 1)::timestamp at time zone v_tz;
  return query
  select t.id, t.title, te.user_id, t.team_role, t.status,
         round(sum(extract(epoch from least(coalesce(te.ended_at, now()), v_end) - greatest(te.started_at, v_start))))::int
    from task_time_entries te join tasks t on t.id = te.task_id
   where te.started_at < v_end and coalesce(te.ended_at, now()) > v_start
     and (p_user is null or te.user_id = p_user)
   group by t.id, t.title, te.user_id, t.team_role, t.status
   order by 6 desc;
end $$;

-- One day as a strip: seconds from local midnight for each active / idle / timer block
create or replace function public.day_timeline(p_day date, p_user uuid default null)
returns table (user_id uuid, kind text, start_sec int, end_sec int)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare v_tz text := app_tz(); v_ds timestamptz; v_de timestamptz;
begin
  perform assert_can_view(p_user);
  v_ds := p_day::timestamp at time zone v_tz;
  v_de := (p_day + 1)::timestamp at time zone v_tz;
  return query
  with blocks as (
    select i.user_id as uid, i.state as k, i.started_at as t0, coalesce(i.ended_at, s.last_seen_at) as t1
      from activity_intervals i join user_sessions s on s.id = i.session_id
     where i.started_at < v_de and coalesce(i.ended_at, s.last_seen_at) > v_ds
       and (p_user is null or i.user_id = p_user)
    union all
    select te.user_id, 'timer', te.started_at, coalesce(te.ended_at, now())
      from task_time_entries te
     where te.started_at < v_de and coalesce(te.ended_at, now()) > v_ds
       and (p_user is null or te.user_id = p_user)
  )
  select b.uid, b.k,
         floor(extract(epoch from greatest(b.t0, v_ds) - v_ds))::int,
         ceil(extract(epoch from least(b.t1, v_de) - v_ds))::int
    from blocks b
   where b.t1 > b.t0
   order by b.uid, b.t0;
end $$;


-- ---------------------------------------------------------------------
-- 9. Row Level Security
-- ---------------------------------------------------------------------

alter table public.app_settings       enable row level security;
alter table public.team_roles         enable row level security;
alter table public.profiles           enable row level security;
alter table public.member_roles       enable row level security;
alter table public.tasks              enable row level security;
alter table public.task_comments      enable row level security;
alter table public.task_time_entries  enable row level security;
alter table public.user_sessions      enable row level security;
alter table public.activity_intervals enable row level security;
alter table public.activity_logs      enable row level security;

drop policy if exists settings_read on public.app_settings;
create policy settings_read on public.app_settings for select to authenticated using (true);
drop policy if exists settings_admin_update on public.app_settings;
create policy settings_admin_update on public.app_settings for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists roles_read on public.team_roles;
create policy roles_read on public.team_roles for select to authenticated using (true);

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists member_roles_read on public.member_roles;
create policy member_roles_read on public.member_roles for select to authenticated
  using (member_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using (assigned_to = (select auth.uid()) or (select public.is_admin()));
drop policy if exists tasks_admin_insert on public.tasks;
create policy tasks_admin_insert on public.tasks for insert to authenticated with check ((select public.is_admin()));
drop policy if exists tasks_admin_update on public.tasks;
create policy tasks_admin_update on public.tasks for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists tasks_admin_delete on public.tasks;
create policy tasks_admin_delete on public.tasks for delete to authenticated using ((select public.is_admin()));

drop policy if exists comments_read on public.task_comments;
create policy comments_read on public.task_comments for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id
                  and (t.assigned_to = (select auth.uid()) or (select public.is_admin()))));
drop policy if exists comments_insert on public.task_comments;
create policy comments_insert on public.task_comments for insert to authenticated
  with check (author_id = (select auth.uid())
              and exists (select 1 from public.tasks t where t.id = task_id
                           and (t.assigned_to = (select auth.uid()) or (select public.is_admin()))));

drop policy if exists time_read on public.task_time_entries;
create policy time_read on public.task_time_entries for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists sessions_read on public.user_sessions;
create policy sessions_read on public.user_sessions for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists intervals_read on public.activity_intervals;
create policy intervals_read on public.activity_intervals for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

drop policy if exists logs_read on public.activity_logs;
create policy logs_read on public.activity_logs for select to authenticated
  using ((select public.is_admin()) or actor_id = (select auth.uid()) or subject_id = (select auth.uid()));


-- ---------------------------------------------------------------------
-- 10. Privileges — browsers only read; every change goes through
--     the functions above or the server (secret key).
-- ---------------------------------------------------------------------

revoke all on public.app_settings, public.team_roles, public.profiles, public.member_roles, public.tasks,
              public.task_comments, public.task_time_entries, public.user_sessions, public.activity_intervals,
              public.activity_logs, public.task_time_totals
  from anon, authenticated;

grant select on public.app_settings, public.team_roles, public.profiles, public.member_roles, public.tasks,
                public.task_comments, public.task_time_entries, public.user_sessions, public.activity_intervals,
                public.activity_logs, public.task_time_totals
  to authenticated;

grant update (first_name, last_name, phone, avatar_url) on public.profiles to authenticated;
grant update (company_name, timezone, idle_minutes) on public.app_settings to authenticated;
grant insert, update, delete on public.tasks to authenticated;
grant insert on public.task_comments to authenticated;

grant all on public.app_settings, public.team_roles, public.profiles, public.member_roles, public.tasks,
             public.task_comments, public.task_time_entries, public.user_sessions, public.activity_intervals,
             public.activity_logs, public.task_time_totals
  to service_role;
grant usage on sequence public.employee_code_seq to service_role;

revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema public from authenticated;

grant execute on function
  public.is_admin(),
  public.session_start(text, text, text),
  public.session_heartbeat(uuid, text, int),
  public.session_end(uuid),
  public.sweep_stale_sessions(),
  public.timer_start(bigint),
  public.timer_pause(),
  public.timer_stop(bigint),
  public.my_timer(),
  public.task_set_status(bigint, text, text),
  public.task_review(bigint, boolean, text),
  public.team_presence(),
  public.list_sessions(date, date, uuid),
  public.report_daily(date, date, uuid),
  public.report_tasks(date, date, uuid),
  public.day_timeline(date, uuid)
to authenticated;

grant execute on function
  public.admin_save_member(uuid, uuid, jsonb, text[]),
  public.admin_set_member_status(uuid, uuid, text)
to service_role;

-- Done. Next: create your admin user (see README, step 2).
