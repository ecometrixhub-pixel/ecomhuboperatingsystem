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

-- Admin, or an active member holding the Manager role: sees and manages the whole workspace
create or replace function public.is_manager_id(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
     where p.id = p_id and p.status = 'active'
       and (p.role = 'admin' or exists (select 1 from member_roles m where m.member_id = p.id and m.role_key = 'manager')));
$$;

create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_manager_id(auth.uid());
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
  if not is_manager() and p_user is distinct from auth.uid() then
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
  if not is_manager_id(p_actor) then
    raise exception 'Only the admin or a manager can manage members';
  end if;
  if exists (select 1 from profiles where id = p_member and role = 'admin')
     and not exists (select 1 from profiles where id = p_actor and role = 'admin') then
    raise exception 'Only the admin can edit the admin account';
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
  if not is_manager_id(p_actor) then
    raise exception 'Only the admin or a manager can manage members';
  end if;
  if exists (select 1 from profiles where id = p_member and role = 'admin') then
    raise exception 'The admin account can''t be deactivated';
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
  if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    perform log_event('settings_changed', 'settings', '1', 'Updated app settings',
      jsonb_build_object('from', to_jsonb(old) - 'updated_at' - 'id', 'to', to_jsonb(new) - 'updated_at' - 'id'));
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
  if not is_manager() then raise exception 'Only the admin or a manager can review tasks'; end if;
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
  if not is_manager() then raise exception 'Only the admin or a manager can view team presence'; end if;
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
  using (id = (select auth.uid()) or (select public.is_manager()));
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists member_roles_read on public.member_roles;
create policy member_roles_read on public.member_roles for select to authenticated
  using (member_id = (select auth.uid()) or (select public.is_manager()));

drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using (assigned_to = (select auth.uid()) or (select public.is_manager()));
drop policy if exists tasks_admin_insert on public.tasks;
create policy tasks_admin_insert on public.tasks for insert to authenticated with check ((select public.is_manager()));
drop policy if exists tasks_admin_update on public.tasks;
create policy tasks_admin_update on public.tasks for update to authenticated
  using ((select public.is_manager())) with check ((select public.is_manager()));
drop policy if exists tasks_admin_delete on public.tasks;
create policy tasks_admin_delete on public.tasks for delete to authenticated using ((select public.is_manager()));

drop policy if exists comments_read on public.task_comments;
create policy comments_read on public.task_comments for select to authenticated
  using (exists (select 1 from public.tasks t where t.id = task_id
                  and (t.assigned_to = (select auth.uid()) or (select public.is_manager()))));
drop policy if exists comments_insert on public.task_comments;
create policy comments_insert on public.task_comments for insert to authenticated
  with check (author_id = (select auth.uid())
              and exists (select 1 from public.tasks t where t.id = task_id
                           and (t.assigned_to = (select auth.uid()) or (select public.is_manager()))));

drop policy if exists time_read on public.task_time_entries;
create policy time_read on public.task_time_entries for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

drop policy if exists sessions_read on public.user_sessions;
create policy sessions_read on public.user_sessions for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

drop policy if exists intervals_read on public.activity_intervals;
create policy intervals_read on public.activity_intervals for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()));

drop policy if exists logs_read on public.activity_logs;
create policy logs_read on public.activity_logs for select to authenticated
  using ((select public.is_manager()) or actor_id = (select auth.uid()) or subject_id = (select auth.uid()));


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
  public.is_manager(),
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


-- =====================================================================
--  PART 2 — Leads, clients, finance, files, role permissions
-- =====================================================================

alter table public.app_settings add column if not exists currency text not null default 'USD';
grant update (currency) on public.app_settings to authenticated;

insert into public.team_roles (key, name, description, sort) values
  ('project_manager', 'Project Manager', 'Running delivery for the clients assigned to them', 6)
on conflict (key) do update set name = excluded.name, description = excluded.description, sort = excluded.sort;

-- ---------- What each role can see / edit / delete ----------
create table if not exists public.role_permissions (
  role_key    text not null references public.team_roles(key) on update cascade on delete cascade,
  module      text not null check (module in ('leads', 'clients', 'finance')),
  can_view    boolean not null default false,
  can_edit    boolean not null default false,
  can_delete  boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (role_key, module)
);
-- Defaults only; the admin changes them on the Permissions page (re-running keeps their choices)
insert into public.role_permissions (role_key, module, can_view, can_edit, can_delete) values
  ('lead_gen',        'leads',   true,  true,  false),
  ('lead_gen',        'clients', false, false, false),
  ('lead_gen',        'finance', false, false, false),
  ('sales_rep',       'leads',   true,  true,  false),
  ('sales_rep',       'clients', true,  false, false),
  ('sales_rep',       'finance', false, false, false),
  ('cold_caller',     'leads',   true,  true,  false),
  ('cold_caller',     'clients', false, false, false),
  ('cold_caller',     'finance', false, false, false),
  ('finance',         'leads',   false, false, false),
  ('finance',         'clients', true,  false, false),
  ('finance',         'finance', true,  true,  true),
  ('manager',         'leads',   true,  true,  true),
  ('manager',         'clients', true,  true,  true),
  ('manager',         'finance', true,  true,  true),
  ('project_manager', 'leads',   false, false, false),
  ('project_manager', 'clients', true,  true,  false),
  ('project_manager', 'finance', false, false, false)
on conflict (role_key, module) do nothing;

-- Workspace-wide permission from the caller's roles (Project Manager is assigned-clients only, so not counted here)
create or replace function public.perm(p_module text, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_manager() or exists (
    select 1 from member_roles mr
      join role_permissions rp on rp.role_key = mr.role_key and rp.module = p_module
      join profiles p on p.id = mr.member_id and p.status = 'active'
     where mr.member_id = auth.uid() and mr.role_key <> 'project_manager'
       and case p_action when 'view' then rp.can_view when 'edit' then rp.can_edit when 'delete' then rp.can_delete else false end);
$$;

-- Permission the Project Manager role gives on its assigned clients
create or replace function public.pm_perm(p_module text, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from member_roles mr
      join role_permissions rp on rp.role_key = mr.role_key and rp.module = p_module
      join profiles p on p.id = mr.member_id and p.status = 'active'
     where mr.member_id = auth.uid() and mr.role_key = 'project_manager'
       and case p_action when 'view' then rp.can_view when 'edit' then rp.can_edit when 'delete' then rp.can_delete else false end);
$$;

-- Names + roles of active members, for pickers and "added by" labels (no emails or phones)
drop function if exists public.team_directory();
create or replace function public.team_directory()
returns table (id uuid, name text, roles text[], status text, job_title text, department text, is_admin boolean)
language sql stable security definer set search_path = public as $$
  select p.id, member_name(p.id), coalesce(array_agg(mr.role_key) filter (where mr.role_key is not null), '{}'), p.status,
         p.job_title, p.department, p.role = 'admin'
    from profiles p left join member_roles mr on mr.member_id = p.id
   where auth.uid() is not null and p.status in ('active', 'invited')
   group by p.id;
$$;

-- ---------- Leads ----------
create table if not exists public.leads (
  id               bigint generated always as identity primary key,
  company          text not null check (char_length(company) between 1 and 200),
  contact_name     text,
  email            text,
  phone            text,
  website          text,
  country          text,
  industry         text,
  source           text,
  notes            text not null default '',
  status           text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost')),
  estimated_value  numeric(12, 2),
  assigned_to      uuid references public.profiles(id),
  created_by       uuid references public.profiles(id),
  client_id        bigint,
  won_at           timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists leads_status_idx on public.leads (status, created_at desc);
create index if not exists leads_assigned_idx on public.leads (assigned_to);

-- ---------- Clients ----------
create table if not exists public.clients (
  id                bigint generated always as identity primary key,
  name              text not null check (char_length(name) between 1 and 200),
  contact_name      text,
  email             text,
  phone             text,
  website           text,
  country           text,
  services          text,
  notes             text not null default '',
  status            text not null default 'onboarding' check (status in ('onboarding', 'active', 'paused', 'churned')),
  onboarding_date   date default current_date,
  monthly_retainer  numeric(12, 2),
  project_manager   uuid references public.profiles(id),
  lead_id           bigint references public.leads(id) on delete set null,
  created_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists clients_pm_idx on public.clients (project_manager);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leads_client_fk') then
    alter table public.leads add constraint leads_client_fk foreign key (client_id) references public.clients(id) on delete set null;
  end if;
end $$;

-- ---------- Invoices (revenue = paid invoices) ----------
create table if not exists public.invoices (
  id              bigint generated always as identity primary key,
  client_id       bigint not null references public.clients(id) on delete cascade,
  invoice_number  text,
  description     text not null default '',
  amount          numeric(12, 2) not null check (amount >= 0),
  issue_date      date not null default current_date,
  due_date        date,
  status          text not null default 'sent' check (status in ('draft', 'sent', 'paid', 'cancelled')),
  paid_date       date,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists invoices_client_idx on public.invoices (client_id);
create index if not exists invoices_status_idx on public.invoices (status, paid_date);

-- ---------- Client files (contracts, documents) stored in Supabase Storage ----------
create table if not exists public.client_files (
  id            bigint generated always as identity primary key,
  client_id     bigint not null references public.clients(id) on delete cascade,
  kind          text not null default 'document' check (kind in ('contract', 'document', 'invoice', 'other')),
  name          text not null,
  storage_path  text not null unique,
  size_bytes    bigint,
  uploaded_by   uuid references public.profiles(id),
  created_at    timestamptz not null default now()
);
create index if not exists client_files_client_idx on public.client_files (client_id);

-- Can the caller view / edit / delete this client (and its files)?
create or replace function public.can_client(p_client bigint, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from clients c where c.id = p_client
                   and (perm('clients', p_action) or (c.project_manager = auth.uid() and pm_perm('clients', p_action))));
$$;

-- Invoices follow the Finance permission (Project Managers only if their role allows Finance)
create or replace function public.can_invoice(p_client bigint, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select perm('finance', p_action) or exists (select 1 from clients c where c.id = p_client
                   and c.project_manager = auth.uid() and pm_perm('finance', p_action));
$$;

-- ---------- Triggers: timestamps, validation, audit ----------
create or replace function public.biz_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if tg_table_name = 'client_files' then new.uploaded_by := coalesce(auth.uid(), new.uploaded_by);
    else new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now(); end if;
  end if;
  if tg_table_name <> 'client_files' then new.updated_at := now(); end if;

  if tg_table_name = 'leads' then
    if new.status = 'won' and (tg_op = 'INSERT' or old.status <> 'won') then new.won_at := now(); end if;
    if new.status <> 'won' then new.won_at := null; end if;
  elsif tg_table_name = 'clients' then
    if new.project_manager is not null and (tg_op = 'INSERT' or new.project_manager is distinct from old.project_manager)
       and not exists (select 1 from member_roles where member_id = new.project_manager and role_key = 'project_manager') then
      raise exception 'Pick a member with the Project Manager role';
    end if;
  elsif tg_table_name = 'invoices' then
    if new.status = 'paid' and new.paid_date is null then new.paid_date := current_date; end if;
    if new.status <> 'paid' then new.paid_date := null; end if;
  end if;
  return new;
end $$;

create or replace function public.biz_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_client text;
begin
  if tg_table_name = 'leads' then
    if tg_op = 'INSERT' then
      perform log_event('lead_created', 'lead', new.id::text, 'Added lead "' || new.company || '"', jsonb_build_object('source', new.source), new.assigned_to);
    elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
      perform log_event(case when new.status = 'won' then 'lead_won' when new.status = 'lost' then 'lead_lost' else 'lead_status_changed' end,
        'lead', new.id::text, 'Moved lead "' || new.company || '" to ' || new.status,
        jsonb_build_object('from', old.status, 'to', new.status), new.assigned_to);
    elsif tg_op = 'DELETE' then
      perform log_event('lead_deleted', 'lead', old.id::text, 'Deleted lead "' || old.company || '"');
    end if;
  elsif tg_table_name = 'clients' then
    if tg_op = 'INSERT' then
      perform log_event('client_created', 'client', new.id::text, 'Added client "' || new.name || '"', '{}'::jsonb, new.project_manager);
    elsif tg_op = 'UPDATE' and new.project_manager is distinct from old.project_manager and new.project_manager is not null then
      perform log_event('client_pm_assigned', 'client', new.id::text,
        'Assigned "' || new.name || '" to ' || member_name(new.project_manager), '{}'::jsonb, new.project_manager);
    elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
      perform log_event('client_status_changed', 'client', new.id::text, 'Moved client "' || new.name || '" to ' || new.status,
        jsonb_build_object('from', old.status, 'to', new.status), new.project_manager);
    elsif tg_op = 'DELETE' then
      perform log_event('client_deleted', 'client', old.id::text, 'Deleted client "' || old.name || '"');
    end if;
  elsif tg_table_name = 'invoices' then
    select name into v_client from clients where id = coalesce(new.client_id, old.client_id);
    if tg_op = 'INSERT' then
      perform log_event('invoice_created', 'client', new.client_id::text,
        'Added invoice ' || coalesce(new.invoice_number, '#' || new.id) || ' for ' || coalesce(v_client, 'client') || ' (' || new.amount || ')');
    elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
      perform log_event(case when new.status = 'paid' then 'invoice_paid' else 'invoice_updated' end, 'client', new.client_id::text,
        'Invoice ' || coalesce(new.invoice_number, '#' || new.id) || ' for ' || coalesce(v_client, 'client') || ' is ' || new.status);
    elsif tg_op = 'DELETE' then
      perform log_event('invoice_deleted', 'client', old.client_id::text, 'Deleted invoice ' || coalesce(old.invoice_number, '#' || old.id));
    end if;
  elsif tg_table_name = 'client_files' then
    select name into v_client from clients where id = coalesce(new.client_id, old.client_id);
    if tg_op = 'INSERT' then
      perform log_event('file_uploaded', 'client', new.client_id::text, 'Uploaded ' || new.kind || ' "' || new.name || '" for ' || coalesce(v_client, 'client'));
    elsif tg_op = 'DELETE' then
      perform log_event('file_deleted', 'client', old.client_id::text, 'Deleted ' || old.kind || ' "' || old.name || '"');
    end if;
  end if;
  return coalesce(new, old);
end $$;

do $$ declare t text; begin
  foreach t in array array['leads', 'clients', 'invoices', 'client_files'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_before', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.biz_before_write()', t || '_before', t);
    execute format('drop trigger if exists %I on public.%I', t || '_after', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.biz_after_write()', t || '_after', t);
  end loop;
end $$;

create or replace function public.permissions_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform log_event('permission_changed', 'settings', new.role_key || ':' || new.module,
    'Changed ' || (select name from team_roles where key = new.role_key) || ' access to ' || new.module,
    jsonb_build_object('view', new.can_view, 'edit', new.can_edit, 'delete', new.can_delete));
  return new;
end $$;
drop trigger if exists role_permissions_log on public.role_permissions;
create trigger role_permissions_log after update on public.role_permissions
  for each row execute function public.permissions_after_update();

-- ---------- Won lead → client ----------
create or replace function public.lead_mark_won(p_lead bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); l leads%rowtype; v_client bigint;
begin
  if not perm('leads', 'edit') then raise exception 'You don''t have permission to update leads'; end if;
  select * into l from leads where id = p_lead for update;
  if not found then raise exception 'Lead not found'; end if;
  if l.client_id is not null then
    update leads set status = 'won' where id = p_lead and status <> 'won';
    return l.client_id;
  end if;
  insert into clients (name, contact_name, email, phone, website, country, notes, lead_id, monthly_retainer, created_by)
  values (l.company, l.contact_name, l.email, l.phone, l.website, l.country, l.notes, l.id, l.estimated_value, v_uid)
  returning id into v_client;
  update leads set status = 'won', client_id = v_client where id = p_lead;
  return v_client;
end $$;

-- ---------- Business numbers for the dashboard ----------
create or replace function public.business_summary() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tz text := app_tz(); v_today date := (now() at time zone app_tz())::date; v_month date; r jsonb;
begin
  if not (perm('finance', 'view') or is_manager()) then raise exception 'You don''t have access to finance'; end if;
  v_month := date_trunc('month', v_today)::date;
  select jsonb_build_object(
    'currency', (select currency from app_settings where id = 1),
    'revenue_month', coalesce((select sum(amount) from invoices where status = 'paid' and paid_date >= v_month), 0),
    'revenue_last_month', coalesce((select sum(amount) from invoices where status = 'paid' and paid_date >= (v_month - interval '1 month')::date and paid_date < v_month), 0),
    'revenue_total', coalesce((select sum(amount) from invoices where status = 'paid'), 0),
    'outstanding', coalesce((select sum(amount) from invoices where status = 'sent'), 0),
    'overdue_count', (select count(*) from invoices where status = 'sent' and due_date < v_today),
    'overdue_amount', coalesce((select sum(amount) from invoices where status = 'sent' and due_date < v_today), 0),
    'mrr', coalesce((select sum(monthly_retainer) from clients where status in ('onboarding', 'active')), 0),
    'active_clients', (select count(*) from clients where status in ('onboarding', 'active')),
    'leads_open', (select count(*) from leads where status not in ('won', 'lost')),
    'leads_month', (select count(*) from leads where (created_at at time zone v_tz)::date >= v_month),
    'won_month', (select count(*) from leads where status = 'won' and (won_at at time zone v_tz)::date >= v_month),
    'months', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
                 'revenue', coalesce((select sum(amount) from invoices where status = 'paid' and paid_date >= m and paid_date < m + interval '1 month'), 0)) order by m), '[]'::jsonb)
                 from generate_series(v_month - interval '11 months', v_month, interval '1 month') m)
  ) into r;
  return r;
end $$;

-- ---------- Row Level Security for part 2 ----------
alter table public.role_permissions enable row level security;
alter table public.leads            enable row level security;
alter table public.clients          enable row level security;
alter table public.invoices         enable row level security;
alter table public.client_files     enable row level security;

drop policy if exists perms_read on public.role_permissions;
create policy perms_read on public.role_permissions for select to authenticated using (true);
drop policy if exists perms_admin_update on public.role_permissions;
create policy perms_admin_update on public.role_permissions for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists leads_read on public.leads;
create policy leads_read on public.leads for select to authenticated using ((select public.perm('leads', 'view')));
drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads for insert to authenticated with check ((select public.perm('leads', 'edit')));
drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads for update to authenticated
  using ((select public.perm('leads', 'edit'))) with check ((select public.perm('leads', 'edit')));
drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads for delete to authenticated using ((select public.perm('leads', 'delete')));

drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated
  using ((select public.perm('clients', 'view')) or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'view'))));
drop policy if exists clients_insert on public.clients;
create policy clients_insert on public.clients for insert to authenticated with check ((select public.perm('clients', 'edit')));
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients for update to authenticated
  using ((select public.perm('clients', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'edit'))))
  with check ((select public.perm('clients', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'edit'))));
drop policy if exists clients_delete on public.clients;
create policy clients_delete on public.clients for delete to authenticated using ((select public.perm('clients', 'delete')));

drop policy if exists invoices_read on public.invoices;
create policy invoices_read on public.invoices for select to authenticated using (public.can_invoice(client_id, 'view'));
drop policy if exists invoices_insert on public.invoices;
create policy invoices_insert on public.invoices for insert to authenticated with check (public.can_invoice(client_id, 'edit'));
drop policy if exists invoices_update on public.invoices;
create policy invoices_update on public.invoices for update to authenticated
  using (public.can_invoice(client_id, 'edit')) with check (public.can_invoice(client_id, 'edit'));
drop policy if exists invoices_delete on public.invoices;
create policy invoices_delete on public.invoices for delete to authenticated using (public.can_invoice(client_id, 'delete'));

drop policy if exists files_read on public.client_files;
create policy files_read on public.client_files for select to authenticated using (public.can_client(client_id, 'view'));
drop policy if exists files_insert on public.client_files;
create policy files_insert on public.client_files for insert to authenticated with check (public.can_client(client_id, 'edit'));
drop policy if exists files_delete on public.client_files;
create policy files_delete on public.client_files for delete to authenticated using (public.can_client(client_id, 'delete'));

revoke all on public.role_permissions, public.leads, public.clients, public.invoices, public.client_files from anon, authenticated;
grant select on public.role_permissions, public.leads, public.clients, public.invoices, public.client_files to authenticated;
grant update (can_view, can_edit, can_delete) on public.role_permissions to authenticated;
grant insert, update, delete on public.leads, public.clients, public.invoices to authenticated;
grant insert, delete on public.client_files to authenticated;
grant all on public.role_permissions, public.leads, public.clients, public.invoices, public.client_files to service_role;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public.biz_before_write(), public.biz_after_write(), public.permissions_after_update() from authenticated;
grant execute on function
  public.perm(text, text), public.pm_perm(text, text), public.can_client(bigint, text), public.can_invoice(bigint, text),
  public.team_directory(), public.lead_mark_won(bigint), public.business_summary()
to authenticated;

-- ---------- Storage bucket for contracts & documents (Supabase only) ----------
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('client-files', 'client-files', false, 26214400)
    on conflict (id) do nothing;
    execute 'drop policy if exists "client files read" on storage.objects';
    execute 'create policy "client files read" on storage.objects for select to authenticated using (bucket_id = ''client-files'' and public.can_client(((storage.foldername(name))[1])::bigint, ''view''))';
    execute 'drop policy if exists "client files upload" on storage.objects';
    execute 'create policy "client files upload" on storage.objects for insert to authenticated with check (bucket_id = ''client-files'' and public.can_client(((storage.foldername(name))[1])::bigint, ''edit''))';
    execute 'drop policy if exists "client files delete" on storage.objects';
    execute 'create policy "client files delete" on storage.objects for delete to authenticated using (bucket_id = ''client-files'' and public.can_client(((storage.foldername(name))[1])::bigint, ''delete''))';
  end if;
end $$;


-- =====================================================================
--  PART 3 — Richer leads, convert to client, client agents, notifications
-- =====================================================================

-- ---------- Leads: more fields + pipeline stages ----------
alter table public.leads add column if not exists service        text;
alter table public.leads add column if not exists budget         numeric(12, 2);
alter table public.leads add column if not exists currency       text not null default 'USD';
alter table public.leads add column if not exists priority       text not null default 'medium';
alter table public.leads add column if not exists next_follow_up date;
alter table public.leads add column if not exists agent_id       uuid references public.profiles(id);
alter table public.leads add column if not exists agent_name     text;
alter table public.leads add column if not exists converted_at   timestamptz;
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check
  check (status in ('new', 'contacted', 'qualified', 'meeting', 'proposal', 'negotiation', 'won', 'lost'));
alter table public.leads drop constraint if exists leads_priority_check;
alter table public.leads add constraint leads_priority_check check (priority in ('low', 'medium', 'high', 'urgent'));
create index if not exists leads_agent_idx on public.leads (agent_id);

-- Tasks can belong to a client (so its project manager can assign work to the client's agents)
alter table public.tasks add column if not exists client_id bigint references public.clients(id) on delete set null;
create index if not exists tasks_client_idx on public.tasks (client_id);

-- ---------- Client agents: people working on a client (designer, web dev, …) ----------
create table if not exists public.client_members (
  client_id   bigint not null references public.clients(id) on delete cascade,
  member_id   uuid not null references public.profiles(id) on delete cascade,
  role_label  text not null default 'Agent',
  added_by    uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  primary key (client_id, member_id)
);
create index if not exists client_members_member_idx on public.client_members (member_id);

-- ---------- Notifications ----------
create table if not exists public.notifications (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null default 'info',
  title       text not null,
  body        text not null default '',
  link        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where read_at is null;

-- ---------- Helpers ----------
create or replace function public.is_client_pm(p_client bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from clients c where c.id = p_client and c.project_manager = auth.uid()) and pm_perm('clients', 'view');
$$;

create or replace function public.is_client_agent(p_client bigint, p_member uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from client_members where client_id = p_client and member_id = p_member);
$$;

-- Clients: workspace permission, the assigned project manager, or (view only) an agent on the client
create or replace function public.can_client(p_client bigint, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from clients c where c.id = p_client
                   and (perm('clients', p_action)
                        or (c.project_manager = auth.uid() and pm_perm('clients', p_action))
                        or (p_action = 'view' and exists (select 1 from client_members m where m.client_id = c.id and m.member_id = auth.uid()))));
$$;

create or replace function public.can_see_task(p_task bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tasks t where t.id = p_task
                   and (t.assigned_to = auth.uid() or is_manager() or (t.client_id is not null and is_client_pm(t.client_id))));
$$;

-- "Taha Khan (Co-Founder & COO)" — name plus designation, used in notifications
create or replace function public.member_label(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select member_name(p.id) || coalesce(' (' || nullif(p.job_title, '') || ')', case when p.role = 'admin' then ' (Admin)' else '' end)
    from profiles p where p.id = p_id;
$$;

-- Send a notification (never to the person who caused it, never to inactive accounts)
create or replace function public.notify(p_user uuid, p_kind text, p_title text, p_body text default '', p_link text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user is null or p_user = auth.uid() then return; end if;
  if not exists (select 1 from profiles where id = p_user and status = 'active') then return; end if;
  insert into notifications (user_id, kind, title, body, link) values (p_user, p_kind, left(p_title, 200), left(coalesce(p_body, ''), 500), p_link);
end $$;

create or replace function public.notify_managers(p_kind text, p_title text, p_body text default '', p_link text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select p.id from profiles p where p.status = 'active'
             and (p.role = 'admin' or exists (select 1 from member_roles m where m.member_id = p.id and m.role_key = 'manager')) loop
    perform notify(r.id, p_kind, p_title, p_body, p_link);
  end loop;
end $$;

create or replace function public.notify_role(p_role text, p_kind text, p_title text, p_body text default '', p_link text default null)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select m.member_id as id from member_roles m join profiles p on p.id = m.member_id
            where m.role_key = p_role and p.status = 'active' loop
    perform notify(r.id, p_kind, p_title, p_body, p_link);
  end loop;
end $$;

-- ---------- Convert a won lead into a client ----------
create or replace function public.lead_convert(p_lead bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); l leads%rowtype; v_client bigint; v_cur text;
begin
  if not perm('leads', 'edit') then raise exception 'You don''t have permission to convert leads'; end if;
  select * into l from leads where id = p_lead for update;
  if not found then raise exception 'Lead not found'; end if;
  if l.status <> 'won' then raise exception 'Mark the lead as won before converting it'; end if;
  if l.client_id is not null then return l.client_id; end if;
  select currency into v_cur from app_settings where id = 1;
  insert into clients (name, contact_name, email, phone, website, country, services, notes, lead_id, monthly_retainer, created_by)
  values (coalesce(nullif(l.company, ''), l.contact_name), l.contact_name, l.email, l.phone, l.website, l.country, l.service, l.notes, l.id,
          case when upper(l.currency) = upper(v_cur) then l.budget end, v_uid)
  returning id into v_client;
  update leads set client_id = v_client, converted_at = now() where id = p_lead;
  perform log_event('lead_converted', 'lead', p_lead::text, 'Converted "' || l.company || '" to a client', jsonb_build_object('client_id', v_client));
  perform notify_managers('client', 'New client: ' || l.company, member_name(v_uid) || ' converted a won lead. Assign a project manager.', '#/clients?open=' || v_client);
  return v_client;
end $$;

-- Kept for older screens: won + convert in one step
create or replace function public.lead_mark_won(p_lead bigint) returns bigint
language plpgsql security definer set search_path = public as $$
begin
  if not perm('leads', 'edit') then raise exception 'You don''t have permission to update leads'; end if;
  update leads set status = 'won' where id = p_lead and status <> 'won';
  return lead_convert(p_lead);
end $$;

-- Task review: the client's project manager can review tasks on their client too
create or replace function public.task_review(p_task_id bigint, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); t tasks%rowtype; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into t from tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found'; end if;
  if not (is_manager() or (t.client_id is not null and is_client_pm(t.client_id))) then
    raise exception 'Only the admin, a manager or the client''s project manager can review this task';
  end if;
  if t.status <> 'in_review' then raise exception 'This task is not waiting for review'; end if;
  if not p_approve and v_note is null then raise exception 'Add a note so the member knows what to change'; end if;
  update tasks set status = case when p_approve then 'completed' else 'in_progress' end, review_note = v_note where id = p_task_id;
  if v_note is not null then
    insert into task_comments (task_id, author_id, body)
    values (p_task_id, v_uid, case when p_approve then 'Approved: ' else 'Changes requested: ' end || v_note);
  end if;
end $$;

-- ---------- Notification triggers ----------
create or replace function public.tasks_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text := '#/my-tasks'; v_pm uuid;
begin
  if new.client_id is not null then select project_manager into v_pm from clients where id = new.client_id; end if;
  if tg_op = 'INSERT' then
    perform notify(new.assigned_to, 'task', 'New task: ' || new.title, 'Assigned by ' || coalesce(member_label(auth.uid()), 'the admin'), v_link);
    return new;
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    perform notify(new.assigned_to, 'task', 'New task: ' || new.title, 'Assigned by ' || coalesce(member_label(auth.uid()), 'the admin'), v_link);
  end if;
  if new.status is distinct from old.status then
    if new.status = 'in_review' then
      perform notify_managers('review', 'Ready for review: ' || new.title, 'Submitted by ' || coalesce(member_name(new.assigned_to), 'a member'), '#/tasks?status=in_review');
      perform notify(v_pm, 'review', 'Ready for review: ' || new.title, 'Submitted by ' || coalesce(member_name(new.assigned_to), 'a member'), '#/clients?open=' || new.client_id);
    elsif old.status = 'in_review' and new.status = 'completed' then
      perform notify(new.assigned_to, 'task', 'Approved: ' || new.title, coalesce(new.review_note, ''), v_link);
    elsif old.status = 'in_review' then
      perform notify(new.assigned_to, 'task', 'Changes requested: ' || new.title, coalesce(new.review_note, ''), v_link);
    elsif new.assigned_to is not distinct from old.assigned_to then
      perform notify(new.assigned_to, 'task', 'Task moved to ' || replace(new.status, '_', ' ') || ': ' || new.title, '', v_link);
    end if;
  elsif new.assigned_to is not distinct from old.assigned_to
        and (new.title, new.description, new.priority, new.due_date) is distinct from (old.title, old.description, old.priority, old.due_date) then
    perform notify(new.assigned_to, 'task', 'Task updated: ' || new.title, 'Check the latest details', v_link);
  end if;
  return new;
end $$;
drop trigger if exists tasks_notify on public.tasks;
create trigger tasks_notify after insert or update on public.tasks for each row execute function public.tasks_notify();

create or replace function public.leads_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text := '#/leads?open=' || new.id; v_who text := coalesce(member_name(auth.uid()), coalesce('Lead form (' || new.agent_name || ')', 'Lead form'));
begin
  if tg_op = 'INSERT' then
    perform notify(new.assigned_to, 'lead', 'New lead assigned: ' || new.company, 'Added by ' || v_who, v_link);
    if auth.uid() is null then
      perform notify_managers('lead', 'New lead from the form: ' || new.company, coalesce('Agent: ' || coalesce(member_name(new.agent_id), new.agent_name), ''), v_link);
      perform notify(new.agent_id, 'lead', 'Lead submitted for you: ' || new.company, 'Came in through the lead form', v_link);
    end if;
    return new;
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    perform notify(new.assigned_to, 'lead', 'Lead assigned to you: ' || new.company, 'By ' || v_who, v_link);
  end if;
  if new.status is distinct from old.status then
    if new.status in ('won', 'lost') then
      perform notify_managers('lead', 'Lead ' || new.status || ': ' || new.company, 'By ' || v_who || case when new.status = 'won' then '. Convert it to a client.' else '' end, v_link);
    end if;
    perform notify(new.assigned_to, 'lead', new.company || ' moved to ' || new.status, 'By ' || v_who, v_link);
    perform notify(coalesce(new.agent_id, new.created_by), 'lead', 'Your lead ' || new.company || ' is ' || new.status, 'By ' || v_who, v_link);
  end if;
  return new;
end $$;
drop trigger if exists leads_notify on public.leads;
create trigger leads_notify after insert or update on public.leads for each row execute function public.leads_notify();

create or replace function public.clients_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text := '#/clients?open=' || new.id; v_who text := coalesce(member_name(auth.uid()), 'System');
begin
  if tg_op = 'INSERT' then
    perform notify(new.project_manager, 'client', 'Client assigned to you: ' || new.name, 'By ' || v_who, v_link);
    return new;
  end if;
  if new.project_manager is distinct from old.project_manager then
    perform notify(new.project_manager, 'client', 'Client assigned to you: ' || new.name, 'By ' || v_who, v_link);
  elsif (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    perform notify(new.project_manager, 'client', 'Client updated: ' || new.name, 'By ' || v_who, v_link);
    if new.project_manager = auth.uid() then
      perform notify_managers('client', 'Client updated: ' || new.name, 'By ' || v_who || ' (project manager)', v_link);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists clients_notify on public.clients;
create trigger clients_notify after insert or update on public.clients for each row execute function public.clients_notify();

create or replace function public.client_members_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  select name into v_name from clients where id = coalesce(new.client_id, old.client_id);
  if tg_op = 'INSERT' then
    new.added_by := coalesce(auth.uid(), new.added_by);
    perform notify(new.member_id, 'client', 'You were added to ' || v_name, 'As ' || new.role_label || ', by ' || coalesce(member_name(auth.uid()), 'the admin'), '#/clients?open=' || new.client_id);
    perform log_event('client_agent_added', 'client', new.client_id::text, 'Added ' || member_name(new.member_id) || ' to "' || v_name || '" as ' || new.role_label, '{}'::jsonb, new.member_id);
    return new;
  end if;
  perform log_event('client_agent_removed', 'client', old.client_id::text, 'Removed ' || member_name(old.member_id) || ' from "' || v_name || '"', '{}'::jsonb, old.member_id);
  return old;
end $$;
drop trigger if exists client_members_before on public.client_members;
create trigger client_members_before before insert on public.client_members for each row execute function public.client_members_notify();
drop trigger if exists client_members_after_delete on public.client_members;
create trigger client_members_after_delete after delete on public.client_members for each row execute function public.client_members_notify();

-- Finance changes → admin, managers and the Finance team
create or replace function public.finance_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_client text; v_title text; v_who text := coalesce(member_name(auth.uid()), 'System'); v_cid bigint := coalesce(new.client_id, old.client_id);
begin
  select name into v_client from clients where id = v_cid;
  v_title := case
    when tg_op = 'INSERT' then 'New invoice for ' || v_client || ': ' || new.amount
    when tg_op = 'DELETE' then 'Invoice deleted for ' || v_client
    when new.status = 'paid' and old.status <> 'paid' then 'Invoice paid by ' || v_client || ': ' || new.amount
    else 'Invoice updated for ' || v_client end;
  perform notify_managers('finance', v_title, 'By ' || v_who, '#/finance');
  perform notify_role('finance', 'finance', v_title, 'By ' || v_who, '#/finance');
  return coalesce(new, old);
end $$;
drop trigger if exists invoices_notify on public.invoices;
create trigger invoices_notify after insert or update or delete on public.invoices for each row execute function public.finance_notify();

-- Contracts / documents on a client → its project manager
create or replace function public.files_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare c clients%rowtype;
begin
  select * into c from clients where id = coalesce(new.client_id, old.client_id);
  perform notify(c.project_manager, 'client',
    case when tg_op = 'INSERT' then 'New ' || new.kind || ' on ' || c.name else 'File removed from ' || c.name end,
    coalesce(new.name, old.name), '#/clients?open=' || c.id);
  return coalesce(new, old);
end $$;
drop trigger if exists files_notify on public.client_files;
create trigger files_notify after insert or delete on public.client_files for each row execute function public.files_notify();

-- ---------- RLS for part 3 ----------
alter table public.client_members enable row level security;
alter table public.notifications  enable row level security;

drop policy if exists client_members_read on public.client_members;
create policy client_members_read on public.client_members for select to authenticated
  using (member_id = (select auth.uid()) or public.can_client(client_id, 'view'));
drop policy if exists client_members_insert on public.client_members;
create policy client_members_insert on public.client_members for insert to authenticated
  with check ((select public.is_manager()) or public.is_client_pm(client_id));
drop policy if exists client_members_delete on public.client_members;
create policy client_members_delete on public.client_members for delete to authenticated
  using ((select public.is_manager()) or public.is_client_pm(client_id));

drop policy if exists notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications for delete to authenticated using (user_id = (select auth.uid()));

-- Clients: agents can see the clients they work on
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated
  using ((select public.perm('clients', 'view'))
         or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'view')))
         or public.is_client_agent(id, (select auth.uid())));

-- Tasks: a client's project manager can create and manage tasks for that client's agents
drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using (assigned_to = (select auth.uid()) or (select public.is_manager()) or (client_id is not null and public.is_client_pm(client_id)));
drop policy if exists tasks_admin_insert on public.tasks;
create policy tasks_admin_insert on public.tasks for insert to authenticated
  with check ((select public.is_manager())
              or (client_id is not null and public.is_client_pm(client_id)
                  and (assigned_to is null or assigned_to = (select auth.uid()) or public.is_client_agent(client_id, assigned_to))));
drop policy if exists tasks_admin_update on public.tasks;
create policy tasks_admin_update on public.tasks for update to authenticated
  using ((select public.is_manager()) or (client_id is not null and public.is_client_pm(client_id)))
  with check ((select public.is_manager())
              or (client_id is not null and public.is_client_pm(client_id)
                  and (assigned_to is null or assigned_to = (select auth.uid()) or public.is_client_agent(client_id, assigned_to))));
drop policy if exists tasks_admin_delete on public.tasks;
create policy tasks_admin_delete on public.tasks for delete to authenticated
  using ((select public.is_manager()) or (client_id is not null and public.is_client_pm(client_id) and created_by = (select auth.uid())));

drop policy if exists comments_read on public.task_comments;
create policy comments_read on public.task_comments for select to authenticated using (public.can_see_task(task_id));
drop policy if exists comments_insert on public.task_comments;
create policy comments_insert on public.task_comments for insert to authenticated
  with check (author_id = (select auth.uid()) and public.can_see_task(task_id));
drop policy if exists time_read on public.task_time_entries;
create policy time_read on public.task_time_entries for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_manager()) or public.can_see_task(task_id));

revoke all on public.client_members, public.notifications from anon, authenticated;
grant select, insert, delete on public.client_members to authenticated;
grant select, delete on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;
grant all on public.client_members, public.notifications to service_role;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public.member_label(uuid), public.notify(uuid, text, text, text, text), public.notify_managers(text, text, text, text),
  public.notify_role(text, text, text, text, text), public.tasks_notify(), public.leads_notify(), public.clients_notify(),
  public.client_members_notify(), public.finance_notify(), public.files_notify() from authenticated;
grant execute on function public.is_client_pm(bigint), public.is_client_agent(bigint, uuid), public.can_see_task(bigint),
  public.lead_convert(bigint), public.lead_mark_won(bigint), public.task_review(bigint, boolean, text) to authenticated;



-- =====================================================================
--  PART 4 — Projects: one client can have several projects, each with a
--  project manager and a team. Adding people needs an approval.
-- =====================================================================

-- ---------- Permissions: new "projects" module ----------
alter table public.role_permissions drop constraint if exists role_permissions_module_check;
alter table public.role_permissions add constraint role_permissions_module_check
  check (module in ('leads', 'clients', 'finance', 'projects'));

-- First time only: Project Managers can see the finances of their own projects
do $$ begin
  if not exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'projects') then
    update public.role_permissions set can_view = true where role_key = 'project_manager' and module = 'finance';
  end if;
end $$;

insert into public.role_permissions (role_key, module, can_view, can_edit, can_delete)
select r.key, 'projects', r.key in ('manager', 'project_manager'), r.key in ('manager', 'project_manager'), r.key = 'manager'
  from public.team_roles r
on conflict (role_key, module) do nothing;

-- ---------- Tables ----------
create table if not exists public.projects (
  id               bigint generated always as identity primary key,
  client_id        bigint not null references public.clients(id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 200),
  description      text not null default '',
  status           text not null default 'planning' check (status in ('planning', 'active', 'on_hold', 'completed', 'cancelled')),
  project_manager  uuid references public.profiles(id),
  start_date       date default current_date,
  due_date         date,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists projects_client_idx on public.projects (client_id);
create index if not exists projects_pm_idx on public.projects (project_manager);

-- Every add request is kept: pending → approved / rejected / cancelled, and approved → removed
create table if not exists public.project_members (
  id             bigint generated always as identity primary key,
  project_id     bigint not null references public.projects(id) on delete cascade,
  member_id      uuid not null references public.profiles(id) on delete cascade,
  role_label     text not null default 'Member',
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'removed')),
  approver       text not null default 'pm' check (approver in ('pm', 'manager', 'auto')),
  requested_by   uuid references public.profiles(id),
  requested_at   timestamptz not null default now(),
  decided_by     uuid references public.profiles(id),
  decided_at     timestamptz,
  decision_note  text,
  removed_by     uuid references public.profiles(id),
  removed_at     timestamptz
);
create unique index if not exists project_members_open_uq on public.project_members (project_id, member_id) where status in ('pending', 'approved');
create index if not exists project_members_member_idx on public.project_members (member_id, status);
create index if not exists project_members_project_idx on public.project_members (project_id, status);

alter table public.tasks        add column if not exists project_id bigint references public.projects(id) on delete set null;
alter table public.invoices     add column if not exists project_id bigint references public.projects(id) on delete set null;
alter table public.client_files add column if not exists project_id bigint references public.projects(id) on delete set null;
create index if not exists tasks_project_idx on public.tasks (project_id);
create index if not exists invoices_project_idx on public.invoices (project_id);
create index if not exists client_files_project_idx on public.client_files (project_id);

-- ---------- Access helpers ----------
-- Caller is this project's project manager (and the role allows projects)
create or replace function public.is_project_pm(p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects where id = p_project and project_manager = auth.uid()) and pm_perm('projects', 'view');
$$;

create or replace function public.is_project_member(p_project bigint, p_member uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from project_members where project_id = p_project and member_id = p_member and status = 'approved');
$$;

-- view / edit / delete a project: workspace permission, its project manager (per the PM role), or (view) an approved member
create or replace function public.can_project(p_project bigint, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select perm('projects', p_action)
      or (exists (select 1 from projects where id = p_project and project_manager = auth.uid()) and pm_perm('projects', p_action))
      or (p_action = 'view' and is_project_member(p_project, auth.uid()));
$$;

-- Can run the project day to day (tasks, team requests)
create or replace function public.can_manage_project(p_project bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select perm('projects', 'edit')
      or (exists (select 1 from projects where id = p_project and project_manager = auth.uid()) and pm_perm('projects', 'edit'));
$$;

-- A client is visible to the PM / members of one of its projects (basic details only; files and invoices follow the project)
create or replace function public.client_via_project(p_client bigint, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from projects pr where pr.client_id = p_client
                   and ((pr.project_manager = auth.uid() and pm_perm('clients', p_action))
                        or (p_action = 'view' and is_project_member(pr.id, auth.uid()))));
$$;

-- Invoices tagged to a project: its project manager, if the PM role allows Finance
create or replace function public.can_project_invoice(p_project bigint, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_project is not null
     and exists (select 1 from projects where id = p_project and project_manager = auth.uid())
     and pm_perm('finance', p_action);
$$;

-- Storage paths: "<client>/<file>" (client files) or "<client>/p<project>/<file>" (project files)
create or replace function public.can_storage_file(p_name text, p_action text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare parts text[] := string_to_array(p_name, '/'); v_client bigint; v_project bigint;
begin
  if parts[1] !~ '^\d+$' then return false; end if;
  v_client := parts[1]::bigint;
  if can_client(v_client, p_action) then return true; end if;
  if array_length(parts, 1) >= 3 and parts[2] ~ '^p\d+$' then
    v_project := substr(parts[2], 2)::bigint;
    return exists (select 1 from projects where id = v_project and client_id = v_client) and can_project(v_project, p_action);
  end if;
  return false;
end $$;

-- ---------- Triggers ----------
-- Tasks / invoices / files that belong to a project always carry that project's client
create or replace function public.project_link_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.project_id is not null then
    select client_id into new.client_id from projects where id = new.project_id;
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['tasks', 'invoices', 'client_files'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_project_link', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.project_link_before()', t || '_project_link', t);
  end loop;
end $$;

create or replace function public.projects_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  else
    new.created_by := old.created_by; new.created_at := old.created_at; new.client_id := old.client_id;
  end if;
  new.updated_at := now();
  if new.project_manager is not null and (tg_op = 'INSERT' or new.project_manager is distinct from old.project_manager) then
    if not exists (select 1 from member_roles m join profiles p on p.id = m.member_id
                    where m.member_id = new.project_manager and m.role_key = 'project_manager' and p.status in ('active', 'invited')) then
      raise exception 'Pick a member with the Project Manager role';
    end if;
  end if;
  if auth.uid() is not null and tg_op = 'UPDATE' and new.project_manager is distinct from old.project_manager and not perm('projects', 'edit') then
    raise exception 'Only the admin or a manager can change the project manager';
  end if;
  if new.due_date is not null and new.start_date is not null and new.due_date < new.start_date then
    raise exception 'The due date is before the start date';
  end if;
  return new;
end $$;
drop trigger if exists projects_before on public.projects;
create trigger projects_before before insert or update on public.projects for each row execute function public.projects_before_write();

create or replace function public.projects_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text; v_who text := coalesce(member_label(auth.uid()), 'System'); v_client text;
begin
  if tg_op = 'DELETE' then
    perform log_event('project_deleted', 'project', old.id::text, 'Deleted project "' || old.name || '"');
    return old;
  end if;
  v_link := '#/projects?open=' || new.id;
  select name into v_client from clients where id = new.client_id;
  if tg_op = 'INSERT' then
    perform log_event('project_created', 'project', new.id::text, 'Created project "' || new.name || '" for ' || coalesce(v_client, 'a client'),
      jsonb_build_object('client_id', new.client_id), new.project_manager);
    perform notify(new.project_manager, 'project', 'Project assigned to you: ' || new.name, 'Client ' || coalesce(v_client, '') || '. By ' || v_who, v_link);
    return new;
  end if;
  if new.project_manager is distinct from old.project_manager then
    perform log_event('project_pm_assigned', 'project', new.id::text,
      'Project manager of "' || new.name || '" is now ' || coalesce(member_name(new.project_manager), 'nobody'),
      jsonb_build_object('from', member_name(old.project_manager), 'to', member_name(new.project_manager)), new.project_manager);
    perform notify(new.project_manager, 'project', 'Project assigned to you: ' || new.name, 'Client ' || coalesce(v_client, '') || '. By ' || v_who, v_link);
    perform notify(old.project_manager, 'project', 'Project moved to another PM: ' || new.name, 'By ' || v_who, v_link);
  end if;
  if new.status is distinct from old.status then
    perform log_event('project_status_changed', 'project', new.id::text, 'Moved project "' || new.name || '" to ' || replace(new.status, '_', ' '),
      jsonb_build_object('from', old.status, 'to', new.status), new.project_manager);
    if new.project_manager = auth.uid() then
      perform notify_managers('project', 'Project ' || replace(new.status, '_', ' ') || ': ' || new.name, 'By ' || v_who, v_link);
    elsif new.project_manager is not distinct from old.project_manager then
      perform notify(new.project_manager, 'project', 'Project ' || replace(new.status, '_', ' ') || ': ' || new.name, 'By ' || v_who, v_link);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists projects_after on public.projects;
create trigger projects_after after insert or update or delete on public.projects for each row execute function public.projects_after_write();

-- ---------- Project team: request, approve, cancel, remove ----------
-- Admin/manager adds someone → the project manager approves.
-- Project manager adds someone → the admin or any manager approves.
-- No project manager yet (or the manager runs it themselves) → added straight away.
create or replace function public.project_member_request(p_project bigint, p_member uuid, p_role text default 'Member')
returns bigint language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); pr projects%rowtype; v_approver text; v_id bigint;
        v_label text := left(coalesce(nullif(trim(p_role), ''), 'Member'), 60); v_name text; v_link text;
begin
  select * into pr from projects where id = p_project for update;
  if not found then raise exception 'Project not found'; end if;
  if pr.status in ('completed', 'cancelled') then raise exception 'This project is closed. Reopen it to add people.'; end if;
  if not exists (select 1 from profiles where id = p_member and status in ('active', 'invited')) then raise exception 'Pick an active team member'; end if;
  v_name := member_name(p_member);
  if p_member = pr.project_manager then raise exception '% already runs this project as project manager', v_name; end if;
  if exists (select 1 from project_members where project_id = p_project and member_id = p_member and status = 'approved') then
    raise exception '% is already on this project', v_name; end if;
  if exists (select 1 from project_members where project_id = p_project and member_id = p_member and status = 'pending') then
    raise exception 'A request to add % is already waiting for approval', v_name; end if;

  if is_manager() then
    v_approver := case when pr.project_manager is null or pr.project_manager = v_uid then 'auto' else 'pm' end;
  elsif can_manage_project(p_project) then
    v_approver := 'manager';
  else
    raise exception 'Only the admin, a manager or this project''s project manager can add people';
  end if;

  insert into project_members (project_id, member_id, role_label, status, approver, requested_by, decided_by, decided_at, decision_note)
  values (p_project, p_member, v_label, case when v_approver = 'auto' then 'approved' else 'pending' end, v_approver, v_uid,
          case when v_approver = 'auto' then v_uid end, case when v_approver = 'auto' then now() end,
          case when v_approver = 'auto' then case when pr.project_manager is null then 'Added directly (no project manager yet)' else 'Added by the project manager' end end)
  returning id into v_id;

  v_link := '#/projects?open=' || p_project || '&tab=team';
  if v_approver = 'auto' then
    perform log_event('project_member_added', 'project', p_project::text, 'Added ' || v_name || ' to "' || pr.name || '" as ' || v_label, '{}'::jsonb, p_member);
    perform notify(p_member, 'project', 'You were added to ' || pr.name, 'As ' || v_label || ', by ' || member_label(v_uid), v_link);
  else
    perform log_event('project_member_requested', 'project', p_project::text, 'Asked to add ' || v_name || ' to "' || pr.name || '" as ' || v_label,
      jsonb_build_object('approver', v_approver), p_member);
    if v_approver = 'pm' then
      perform notify(pr.project_manager, 'approval', 'Approval needed: add ' || v_name || ' to ' || pr.name, 'As ' || v_label || '. Requested by ' || member_label(v_uid), v_link);
    else
      perform notify_managers('approval', 'Approval needed: add ' || v_name || ' to ' || pr.name, 'As ' || v_label || '. Requested by ' || member_label(v_uid), v_link);
    end if;
  end if;
  return v_id;
end $$;

create or replace function public.project_member_decide(p_id bigint, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); r project_members%rowtype; pr projects%rowtype; v_name text; v_link text;
        v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into r from project_members where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  if r.status <> 'pending' then raise exception 'This request was already %', r.status; end if;
  select * into pr from projects where id = r.project_id;
  if r.approver = 'pm' and pr.project_manager is distinct from v_uid then
    raise exception 'Only the project manager (%) can approve this', coalesce(member_name(pr.project_manager), 'not assigned');
  end if;
  if r.approver = 'manager' and not is_manager() then raise exception 'Only the admin or a manager can approve this'; end if;
  if r.requested_by = v_uid then raise exception 'You can''t approve your own request'; end if;

  update project_members set status = case when p_approve then 'approved' else 'rejected' end,
         decided_by = v_uid, decided_at = now(), decision_note = v_note
   where id = p_id;

  v_name := member_name(r.member_id);
  v_link := '#/projects?open=' || r.project_id || '&tab=team';
  perform log_event(case when p_approve then 'project_member_approved' else 'project_member_rejected' end, 'project', r.project_id::text,
    case when p_approve then 'Approved ' else 'Rejected ' end || v_name || ' on "' || pr.name || '"',
    jsonb_build_object('requested_by', member_name(r.requested_by), 'note', v_note), r.member_id);
  perform notify(r.requested_by, 'approval', case when p_approve then 'Approved: ' else 'Not approved: ' end || v_name || ' on ' || pr.name,
    'By ' || member_label(v_uid) || coalesce('. ' || v_note, ''), v_link);
  if p_approve then
    perform notify(r.member_id, 'project', 'You were added to ' || pr.name, 'As ' || r.role_label || ', approved by ' || member_label(v_uid), v_link);
    if r.approver = 'manager' then  -- tell the other managers it's handled
      perform notify(pr.project_manager, 'project', v_name || ' joined ' || pr.name, 'Approved by ' || member_label(v_uid), v_link);
    end if;
  end if;
end $$;

create or replace function public.project_member_cancel(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); r project_members%rowtype;
begin
  select * into r from project_members where id = p_id for update;
  if not found then raise exception 'Request not found'; end if;
  if r.status <> 'pending' then raise exception 'Only waiting requests can be cancelled'; end if;
  if r.requested_by is distinct from v_uid and not is_manager() then raise exception 'Only the person who asked can cancel this request'; end if;
  update project_members set status = 'cancelled', decided_by = v_uid, decided_at = now(), decision_note = 'Request cancelled' where id = p_id;
  perform log_event('project_member_cancelled', 'project', r.project_id::text,
    'Cancelled the request to add ' || member_name(r.member_id), '{}'::jsonb, r.member_id);
end $$;

create or replace function public.project_member_remove(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); r project_members%rowtype; pr projects%rowtype;
begin
  select * into r from project_members where id = p_id for update;
  if not found then raise exception 'Member not found'; end if;
  if r.status <> 'approved' then raise exception 'They are not on this project'; end if;
  if not (is_manager() or can_manage_project(r.project_id)) then raise exception 'Only the admin, a manager or the project manager can remove people'; end if;
  select * into pr from projects where id = r.project_id;
  update project_members set status = 'removed', removed_by = v_uid, removed_at = now() where id = p_id;
  perform log_event('project_member_removed', 'project', r.project_id::text,
    'Removed ' || member_name(r.member_id) || ' from "' || pr.name || '"', '{}'::jsonb, r.member_id);
  perform notify(r.member_id, 'project', 'You were removed from ' || pr.name, 'By ' || member_label(v_uid), '#/projects');
end $$;

-- ---------- Updated functions: project managers run their project's tasks ----------
create or replace function public.can_see_task(p_task bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tasks t where t.id = p_task
                   and (t.assigned_to = auth.uid() or is_manager()
                        or (t.client_id is not null and is_client_pm(t.client_id))
                        or (t.project_id is not null and is_project_pm(t.project_id))));
$$;

create or replace function public.task_review(p_task_id bigint, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); t tasks%rowtype; v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into t from tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found'; end if;
  if not (is_manager() or (t.client_id is not null and is_client_pm(t.client_id)) or (t.project_id is not null and is_project_pm(t.project_id))) then
    raise exception 'Only the admin, a manager or the project manager can review this task';
  end if;
  if t.status <> 'in_review' then raise exception 'This task is not waiting for review'; end if;
  if not p_approve and v_note is null then raise exception 'Add a note so the member knows what to change'; end if;
  update tasks set status = case when p_approve then 'completed' else 'in_progress' end, review_note = v_note where id = p_task_id;
  if v_note is not null then
    insert into task_comments (task_id, author_id, body)
    values (p_task_id, v_uid, case when p_approve then 'Approved: ' else 'Changes requested: ' end || v_note);
  end if;
end $$;

create or replace function public.tasks_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text := '#/my-tasks'; v_pm uuid; v_pm_link text;
begin
  if new.project_id is not null then
    select project_manager into v_pm from projects where id = new.project_id;
    v_pm_link := '#/projects?open=' || new.project_id || '&tab=tasks';
  elsif new.client_id is not null then
    select project_manager into v_pm from clients where id = new.client_id;
    v_pm_link := '#/clients?open=' || new.client_id;
  end if;
  if tg_op = 'INSERT' then
    perform notify(new.assigned_to, 'task', 'New task: ' || new.title, 'Assigned by ' || coalesce(member_label(auth.uid()), 'the admin'), v_link);
    return new;
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    perform notify(new.assigned_to, 'task', 'New task: ' || new.title, 'Assigned by ' || coalesce(member_label(auth.uid()), 'the admin'), v_link);
  end if;
  if new.status is distinct from old.status then
    if new.status = 'in_review' then
      perform notify_managers('review', 'Ready for review: ' || new.title, 'Submitted by ' || coalesce(member_name(new.assigned_to), 'a member'), '#/tasks?status=in_review');
      perform notify(v_pm, 'review', 'Ready for review: ' || new.title, 'Submitted by ' || coalesce(member_name(new.assigned_to), 'a member'), v_pm_link);
    elsif old.status = 'in_review' and new.status = 'completed' then
      perform notify(new.assigned_to, 'task', 'Approved: ' || new.title, coalesce(new.review_note, ''), v_link);
    elsif old.status = 'in_review' then
      perform notify(new.assigned_to, 'task', 'Changes requested: ' || new.title, coalesce(new.review_note, ''), v_link);
    elsif new.assigned_to is not distinct from old.assigned_to then
      perform notify(new.assigned_to, 'task', 'Task moved to ' || replace(new.status, '_', ' ') || ': ' || new.title, '', v_link);
    end if;
  elsif new.assigned_to is not distinct from old.assigned_to
        and (new.title, new.description, new.priority, new.due_date) is distinct from (old.title, old.description, old.priority, old.due_date) then
    perform notify(new.assigned_to, 'task', 'Task updated: ' || new.title, 'Check the latest details', v_link);
  end if;
  return new;
end $$;

-- Invoices: tagging an invoice to a project is not news; everything else still notifies finance
create or replace function public.finance_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_client text; v_title text; v_who text := coalesce(member_name(auth.uid()), 'System'); v_cid bigint := coalesce(new.client_id, old.client_id);
        v_pm uuid;
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'project_id' - 'updated_at') = (to_jsonb(old) - 'project_id' - 'updated_at') then return new; end if;
  select name into v_client from clients where id = v_cid;
  v_title := case
    when tg_op = 'INSERT' then 'New invoice for ' || v_client || ': ' || new.amount
    when tg_op = 'DELETE' then 'Invoice deleted for ' || v_client
    when new.status = 'paid' and old.status <> 'paid' then 'Invoice paid by ' || v_client || ': ' || new.amount
    else 'Invoice updated for ' || v_client end;
  perform notify_managers('finance', v_title, 'By ' || v_who, '#/finance');
  perform notify_role('finance', 'finance', v_title, 'By ' || v_who, '#/finance');
  select project_manager into v_pm from projects where id = coalesce(new.project_id, old.project_id);
  if v_pm is not null and not is_manager_id(v_pm) and not exists (select 1 from member_roles where member_id = v_pm and role_key = 'finance') then
    perform notify(v_pm, 'finance', v_title, 'By ' || v_who, '#/projects?open=' || coalesce(new.project_id, old.project_id) || '&tab=invoices');
  end if;
  return coalesce(new, old);
end $$;

-- Files on a project → its project manager
create or replace function public.files_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare c clients%rowtype; v_pm uuid; v_pid bigint := coalesce(new.project_id, old.project_id);
begin
  select * into c from clients where id = coalesce(new.client_id, old.client_id);
  if v_pid is not null then select project_manager into v_pm from projects where id = v_pid; else v_pm := c.project_manager; end if;
  perform notify(v_pm, 'client',
    case when tg_op = 'INSERT' then 'New ' || new.kind || ' on ' || c.name else 'File removed from ' || c.name end,
    coalesce(new.name, old.name), case when v_pid is not null then '#/projects?open=' || v_pid || '&tab=files' else '#/clients?open=' || c.id end);
  return coalesce(new, old);
end $$;

create or replace function public.lead_convert(p_lead bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); l leads%rowtype; v_client bigint; v_cur text;
begin
  if not perm('leads', 'edit') then raise exception 'You don''t have permission to convert leads'; end if;
  select * into l from leads where id = p_lead for update;
  if not found then raise exception 'Lead not found'; end if;
  if l.status <> 'won' then raise exception 'Mark the lead as won before converting it'; end if;
  if l.client_id is not null then return l.client_id; end if;
  select currency into v_cur from app_settings where id = 1;
  insert into clients (name, contact_name, email, phone, website, country, services, notes, lead_id, monthly_retainer, created_by)
  values (coalesce(nullif(l.company, ''), l.contact_name), l.contact_name, l.email, l.phone, l.website, l.country, l.service, l.notes, l.id,
          case when upper(l.currency) = upper(v_cur) then l.budget end, v_uid)
  returning id into v_client;
  update leads set client_id = v_client, converted_at = now() where id = p_lead;
  perform log_event('lead_converted', 'lead', p_lead::text, 'Converted "' || l.company || '" to a client', jsonb_build_object('client_id', v_client));
  perform notify_managers('client', 'New client: ' || l.company, member_name(v_uid) || ' converted a won lead. Create a project and assign a project manager.', '#/clients?open=' || v_client);
  return v_client;
end $$;

-- ---------- RLS for part 4 ----------
alter table public.projects        enable row level security;
alter table public.project_members enable row level security;

drop policy if exists projects_read on public.projects;
create policy projects_read on public.projects for select to authenticated
  using ((select public.perm('projects', 'view'))
         or (project_manager = (select auth.uid()) and (select public.pm_perm('projects', 'view')))
         or public.is_project_member(id, (select auth.uid())));
drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects for insert to authenticated with check ((select public.perm('projects', 'edit')));
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using ((select public.perm('projects', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('projects', 'edit'))))
  with check ((select public.perm('projects', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('projects', 'edit'))));
drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects for delete to authenticated
  using ((select public.perm('projects', 'delete')) or (project_manager = (select auth.uid()) and (select public.pm_perm('projects', 'delete'))));

drop policy if exists project_members_read on public.project_members;
create policy project_members_read on public.project_members for select to authenticated
  using (member_id = (select auth.uid()) or requested_by = (select auth.uid()) or public.can_project(project_id, 'view'));

-- Clients: the PM / members of one of its projects see the client's basic details
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select to authenticated
  using ((select public.perm('clients', 'view'))
         or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'view')))
         or public.is_client_agent(id, (select auth.uid()))
         or public.client_via_project(id, 'view'));
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients for update to authenticated
  using ((select public.perm('clients', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'edit'))) or public.client_via_project(id, 'edit'))
  with check ((select public.perm('clients', 'edit')) or (project_manager = (select auth.uid()) and (select public.pm_perm('clients', 'edit'))) or public.client_via_project(id, 'edit'));

-- Invoices: also the project manager of the invoice's project (if the PM role allows Finance)
drop policy if exists invoices_read on public.invoices;
create policy invoices_read on public.invoices for select to authenticated
  using (public.can_invoice(client_id, 'view') or public.can_project_invoice(project_id, 'view'));
drop policy if exists invoices_insert on public.invoices;
create policy invoices_insert on public.invoices for insert to authenticated
  with check (public.can_invoice(client_id, 'edit') or public.can_project_invoice(project_id, 'edit'));
drop policy if exists invoices_update on public.invoices;
create policy invoices_update on public.invoices for update to authenticated
  using (public.can_invoice(client_id, 'edit') or public.can_project_invoice(project_id, 'edit'))
  with check (public.can_invoice(client_id, 'edit') or public.can_project_invoice(project_id, 'edit'));
drop policy if exists invoices_delete on public.invoices;
create policy invoices_delete on public.invoices for delete to authenticated
  using (public.can_invoice(client_id, 'delete') or public.can_project_invoice(project_id, 'delete'));

-- Files: client-wide files follow the client; project files follow the project
drop policy if exists files_read on public.client_files;
create policy files_read on public.client_files for select to authenticated
  using (public.can_client(client_id, 'view') or (project_id is not null and public.can_project(project_id, 'view')));
drop policy if exists files_insert on public.client_files;
create policy files_insert on public.client_files for insert to authenticated
  with check (public.can_client(client_id, 'edit') or (project_id is not null and public.can_project(project_id, 'edit')));
drop policy if exists files_delete on public.client_files;
create policy files_delete on public.client_files for delete to authenticated
  using (public.can_client(client_id, 'delete') or (project_id is not null and public.can_project(project_id, 'delete')));

-- Tasks: the project manager creates and manages tasks for the project's approved members
drop policy if exists tasks_read on public.tasks;
create policy tasks_read on public.tasks for select to authenticated
  using (assigned_to = (select auth.uid()) or (select public.is_manager())
         or (client_id is not null and public.is_client_pm(client_id))
         or (project_id is not null and public.is_project_pm(project_id)));
drop policy if exists tasks_admin_insert on public.tasks;
create policy tasks_admin_insert on public.tasks for insert to authenticated
  with check ((select public.is_manager())
              or (project_id is not null and public.can_manage_project(project_id)
                  and (assigned_to is null or assigned_to = (select auth.uid()) or public.is_project_member(project_id, assigned_to)))
              or (project_id is null and client_id is not null and public.is_client_pm(client_id)
                  and (assigned_to is null or assigned_to = (select auth.uid()) or public.is_client_agent(client_id, assigned_to))));
drop policy if exists tasks_admin_update on public.tasks;
create policy tasks_admin_update on public.tasks for update to authenticated
  using ((select public.is_manager())
         or (project_id is not null and public.can_manage_project(project_id))
         or (client_id is not null and public.is_client_pm(client_id)))
  with check ((select public.is_manager())
              or (project_id is not null and public.can_manage_project(project_id)
                  and (assigned_to is null or assigned_to = (select auth.uid()) or public.is_project_member(project_id, assigned_to)))
              or (project_id is null and client_id is not null and public.is_client_pm(client_id)
                  and (assigned_to is null or assigned_to = (select auth.uid()) or public.is_client_agent(client_id, assigned_to))));
drop policy if exists tasks_admin_delete on public.tasks;
create policy tasks_admin_delete on public.tasks for delete to authenticated
  using ((select public.is_manager())
         or (project_id is not null and public.can_manage_project(project_id) and created_by = (select auth.uid()))
         or (client_id is not null and public.is_client_pm(client_id) and created_by = (select auth.uid())));

revoke all on public.projects, public.project_members from anon, authenticated;
grant select, insert, delete on public.projects to authenticated;
grant update (name, description, status, project_manager, start_date, due_date) on public.projects to authenticated;
grant select on public.project_members to authenticated;
grant all on public.projects, public.project_members to service_role;
grant update (project_id) on public.invoices to authenticated;

-- Storage: project files live under "<client>/p<project>/…"
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    execute 'drop policy if exists "client files read" on storage.objects';
    execute 'create policy "client files read" on storage.objects for select to authenticated using (bucket_id = ''client-files'' and public.can_storage_file(name, ''view''))';
    execute 'drop policy if exists "client files upload" on storage.objects';
    execute 'create policy "client files upload" on storage.objects for insert to authenticated with check (bucket_id = ''client-files'' and public.can_storage_file(name, ''edit''))';
    execute 'drop policy if exists "client files delete" on storage.objects';
    execute 'create policy "client files delete" on storage.objects for delete to authenticated using (bucket_id = ''client-files'' and public.can_storage_file(name, ''delete''))';
  end if;
end $$;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public.project_link_before(), public.projects_before_write(), public.projects_after_write(),
  public.member_label(uuid), public.notify(uuid, text, text, text, text), public.notify_managers(text, text, text, text),
  public.notify_role(text, text, text, text, text), public.tasks_notify(), public.finance_notify(), public.files_notify() from authenticated;
grant execute on function public.is_project_pm(bigint), public.is_project_member(bigint, uuid), public.can_project(bigint, text),
  public.can_manage_project(bigint), public.client_via_project(bigint, text), public.can_project_invoice(bigint, text),
  public.can_storage_file(text, text), public.project_member_request(bigint, uuid, text), public.project_member_decide(bigint, boolean, text),
  public.project_member_cancel(bigint), public.project_member_remove(bigint), public.can_see_task(bigint),
  public.task_review(bigint, boolean, text), public.lead_convert(bigint) to authenticated;

-- ---------- One-time move: client-level project manager + agents → a project ----------
-- Each client that had a project manager or agents gets a project with the same name; its
-- invoices, files and tasks move into it. Safe to re-run (only clients with no project yet).
do $$
declare c record; v_pid bigint; v_pm uuid;
begin
  for c in select cl.* from clients cl
            where (cl.project_manager is not null or exists (select 1 from client_members m where m.client_id = cl.id))
              and not exists (select 1 from projects p where p.client_id = cl.id) loop
    v_pm := case when exists (select 1 from member_roles where member_id = c.project_manager and role_key = 'project_manager') then c.project_manager end;
    insert into projects (client_id, name, status, project_manager, start_date, created_by)
    values (c.id, c.name, case c.status when 'active' then 'active' when 'paused' then 'on_hold' when 'churned' then 'cancelled' else 'planning' end,
            v_pm, coalesce(c.onboarding_date, current_date), c.created_by)
    returning id into v_pid;
    insert into project_members (project_id, member_id, role_label, status, approver, requested_by, requested_at, decided_by, decided_at, decision_note)
    select v_pid, m.member_id, m.role_label, 'approved', 'auto', m.added_by, m.created_at, m.added_by, m.created_at, 'Moved from the client team'
      from client_members m where m.client_id = c.id and m.member_id is distinct from v_pm;
    update tasks set project_id = v_pid where client_id = c.id and project_id is null;
    update invoices set project_id = v_pid where client_id = c.id and project_id is null;
    update client_files set project_id = v_pid where client_id = c.id and project_id is null;
    update clients set project_manager = null where id = c.id;
  end loop;
end $$;
alter table public.client_members disable trigger client_members_after_delete;
delete from public.client_members cm where exists (select 1 from public.projects p where p.client_id = cm.client_id);
alter table public.client_members enable trigger client_members_after_delete;



-- =====================================================================
--  PART 5 — Project workspace (website, socials, requirements) and
--  leads assigned to Sales Representatives only
-- =====================================================================

-- ---------- Leads: only a Sales Representative can be assigned ----------
create or replace function public.leads_assign_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is not null and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to)
     and not exists (select 1 from member_roles m join profiles p on p.id = m.member_id
                      where m.member_id = new.assigned_to and m.role_key = 'sales_rep' and p.status in ('active', 'invited')) then
    raise exception 'Leads can only be assigned to a Sales Representative';
  end if;
  return new;
end $$;
drop trigger if exists leads_assign_check on public.leads;
create trigger leads_assign_check before insert or update on public.leads for each row execute function public.leads_assign_check();

-- ---------- Projects: live website + social links ----------
alter table public.projects add column if not exists website_url text;
alter table public.projects add column if not exists socials jsonb not null default '{}'::jsonb;
alter table public.projects drop constraint if exists projects_socials_check;
alter table public.projects add constraint projects_socials_check check (jsonb_typeof(socials) = 'object');
grant update (website_url, socials) on public.projects to authenticated;

-- ---------- Requirements checklist per project ----------
create table if not exists public.project_requirements (
  id          bigint generated always as identity primary key,
  project_id  bigint not null references public.projects(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 300),
  details     text not null default '',
  is_done     boolean not null default false,
  sort        int not null default 0,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  done_by     uuid references public.profiles(id),
  done_at     timestamptz,
  updated_at  timestamptz not null default now()
);
create index if not exists project_requirements_project_idx on public.project_requirements (project_id, sort, id);

create or replace function public.requirements_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now();
  else
    new.created_by := old.created_by; new.created_at := old.created_at; new.project_id := old.project_id;
  end if;
  new.updated_at := now();
  if new.is_done and (tg_op = 'INSERT' or not old.is_done) then new.done_by := auth.uid(); new.done_at := now(); end if;
  if not new.is_done then new.done_by := null; new.done_at := null; end if;
  return new;
end $$;
drop trigger if exists requirements_before on public.project_requirements;
create trigger requirements_before before insert or update on public.project_requirements for each row execute function public.requirements_before_write();

create or replace function public.requirements_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  select name into v_name from projects where id = coalesce(new.project_id, old.project_id);
  if tg_op = 'INSERT' then
    perform log_event('requirement_added', 'project', new.project_id::text, 'Added requirement "' || new.title || '" to ' || coalesce(v_name, 'project'));
  elsif tg_op = 'UPDATE' and new.is_done is distinct from old.is_done then
    perform log_event(case when new.is_done then 'requirement_done' else 'requirement_reopened' end, 'project', new.project_id::text,
      case when new.is_done then 'Completed requirement "' else 'Reopened requirement "' end || new.title || '"');
  elsif tg_op = 'DELETE' then
    perform log_event('requirement_deleted', 'project', old.project_id::text, 'Removed requirement "' || old.title || '"');
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists requirements_after on public.project_requirements;
create trigger requirements_after after insert or update or delete on public.project_requirements for each row execute function public.requirements_after_write();

alter table public.project_requirements enable row level security;
drop policy if exists requirements_read on public.project_requirements;
create policy requirements_read on public.project_requirements for select to authenticated using (public.can_project(project_id, 'view'));
drop policy if exists requirements_insert on public.project_requirements;
create policy requirements_insert on public.project_requirements for insert to authenticated with check (public.can_manage_project(project_id));
drop policy if exists requirements_update on public.project_requirements;
create policy requirements_update on public.project_requirements for update to authenticated
  using (public.can_manage_project(project_id)) with check (public.can_manage_project(project_id));
drop policy if exists requirements_delete on public.project_requirements;
create policy requirements_delete on public.project_requirements for delete to authenticated using (public.can_manage_project(project_id));

revoke all on public.project_requirements from anon, authenticated;
grant select, insert, delete on public.project_requirements to authenticated;
grant update (title, details, is_done, sort) on public.project_requirements to authenticated;
grant all on public.project_requirements to service_role;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public.leads_assign_check(), public.requirements_before_write(), public.requirements_after_write() from authenticated;



-- =====================================================================
--  PART 6 — Leads land with the Sales team. Only a Sales Representative,
--  a manager or the admin can assign them.
-- =====================================================================

create or replace function public.leads_assign_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.assigned_to is not null) or (tg_op = 'UPDATE' and new.assigned_to is distinct from old.assigned_to) then
    if auth.uid() is not null and not (is_manager() or exists (select 1 from member_roles where member_id = auth.uid() and role_key = 'sales_rep')) then
      raise exception 'Only a Sales Representative, a manager or the admin can assign leads';
    end if;
    if new.assigned_to is not null and not exists (select 1 from member_roles m join profiles p on p.id = m.member_id
                      where m.member_id = new.assigned_to and m.role_key = 'sales_rep' and p.status in ('active', 'invited')) then
      raise exception 'Leads can only be assigned to a Sales Representative';
    end if;
  end if;
  return new;
end $$;

-- New lead → admin + managers, and the Sales team when nobody is assigned yet
create or replace function public.leads_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_link text := '#/leads?open=' || new.id;
        v_who text := coalesce(member_label(auth.uid()), coalesce('Lead form (' || coalesce(member_name(new.agent_id), new.agent_name) || ')', 'Lead form'));
begin
  if tg_op = 'INSERT' then
    perform notify_managers('lead', case when auth.uid() is null then 'New lead from the form: ' else 'New lead: ' end || new.company,
      'Added by ' || v_who || case when new.assigned_to is null then '. Not assigned yet.' else '' end, v_link);
    if new.assigned_to is null then
      perform notify_role('sales_rep', 'lead', 'New lead to pick up: ' || new.company, 'Added by ' || v_who, '#/leads?scope=unassigned');
    else
      perform notify(new.assigned_to, 'lead', 'New lead assigned: ' || new.company, 'Added by ' || v_who, v_link);
    end if;
    if auth.uid() is null then
      perform notify(new.agent_id, 'lead', 'Lead submitted for you: ' || new.company, 'Came in through the lead form', v_link);
    end if;
    return new;
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    perform notify(new.assigned_to, 'lead', 'Lead assigned to you: ' || new.company, 'By ' || v_who, v_link);
    perform notify(old.assigned_to, 'lead', 'Lead moved to someone else: ' || new.company, 'By ' || v_who, v_link);
  end if;
  if new.status is distinct from old.status then
    if new.status in ('won', 'lost') then
      perform notify_managers('lead', 'Lead ' || new.status || ': ' || new.company, 'By ' || v_who || case when new.status = 'won' then '. Convert it to a client.' else '' end, v_link);
    end if;
    perform notify(new.assigned_to, 'lead', new.company || ' moved to ' || new.status, 'By ' || v_who, v_link);
    perform notify(coalesce(new.agent_id, new.created_by), 'lead', 'Your lead ' || new.company || ' is ' || new.status, 'By ' || v_who, v_link);
  end if;
  return new;
end $$;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public.leads_assign_check(), public.leads_notify() from authenticated;



-- =====================================================================
--  PART 7 — Business finance: expenses, investments, recurring bills
--  (tools, salaries) with reminders, monthly report and dashboard.
--  Salaries are visible only to the admin and managers.
-- =====================================================================

create table if not exists public.recurring_expenses (
  id                    bigint generated always as identity primary key,
  title                 text not null check (char_length(title) between 1 and 200),
  category              text not null default 'tools',
  amount                numeric(12, 2) not null check (amount >= 0),
  frequency             text not null default 'monthly' check (frequency in ('weekly', 'monthly', 'quarterly', 'yearly')),
  next_due              date not null,
  vendor                text,
  payee_member          uuid references public.profiles(id),
  auto_post             boolean not null default false,
  remind_days           int not null default 3 check (remind_days between 0 and 30),
  active                boolean not null default true,
  notes                 text not null default '',
  reminded_upcoming_for date,
  reminded_due_for      date,
  created_by            uuid references public.profiles(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists recurring_due_idx on public.recurring_expenses (active, next_due);

create table if not exists public.expenses (
  id            bigint generated always as identity primary key,
  title         text not null check (char_length(title) between 1 and 200),
  category      text not null default 'other',
  amount        numeric(12, 2) not null check (amount >= 0),
  spent_on      date not null default current_date,
  vendor        text,
  notes         text not null default '',
  paid_by       uuid references public.profiles(id),
  payee_member  uuid references public.profiles(id),
  recurring_id  bigint references public.recurring_expenses(id) on delete set null,
  period        date,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists expenses_spent_idx on public.expenses (spent_on desc);
create index if not exists expenses_category_idx on public.expenses (category, spent_on);
create unique index if not exists expenses_recurring_period_uq on public.expenses (recurring_id, period) where recurring_id is not null;

create table if not exists public.investments (
  id           bigint generated always as identity primary key,
  source       text not null check (char_length(source) between 1 and 200),
  investor_id  uuid references public.profiles(id),
  kind         text not null default 'capital' check (kind in ('capital', 'loan', 'grant', 'other')),
  amount       numeric(12, 2) not null check (amount >= 0),
  invested_on  date not null default current_date,
  notes        text not null default '',
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists investments_date_idx on public.investments (invested_on desc);

create table if not exists public.finance_report_log (
  month       date primary key,
  created_at  timestamptz not null default now()
);

-- Finance permission, and salaries only for the admin / managers
create or replace function public.can_money(p_category text, p_action text) returns boolean
language sql stable security definer set search_path = public as $$
  select perm('finance', p_action) and (p_category is distinct from 'salary' or is_manager());
$$;

create or replace function public.fmt_money(p numeric) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select currency from app_settings where id = 1), 'USD') || ' ' || to_char(round(coalesce(p, 0)), 'FM999,999,999,990');
$$;

create or replace function public.advance_due(p_date date, p_freq text) returns date
language sql immutable as $$
  select case p_freq when 'weekly' then p_date + 7
                     when 'quarterly' then (p_date + interval '3 months')::date
                     when 'yearly' then (p_date + interval '1 year')::date
                     else (p_date + interval '1 month')::date end;
$$;

-- Notification to the admin, managers (co-founders) and, unless it's about salaries, the Finance team
create or replace function public.notify_finance_people(p_salary boolean, p_title text, p_body text, p_link text)
returns void language plpgsql security definer set search_path = public as $$
declare r record;
begin
  for r in select p.id from profiles p where p.status = 'active'
             and (p.role = 'admin' or exists (select 1 from member_roles m where m.member_id = p.id and m.role_key = 'manager')
                  or (not p_salary and exists (select 1 from member_roles m where m.member_id = p.id and m.role_key = 'finance'))) loop
    insert into notifications (user_id, kind, title, body, link) values (r.id, 'finance', left(p_title, 200), left(coalesce(p_body, ''), 500), p_link);
  end loop;
end $$;

-- ---------- Triggers ----------
create or replace function public.money_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by); new.created_at := now();
  else
    new.created_by := old.created_by; new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  if tg_table_name = 'recurring_expenses' then
    if new.category = 'salary' and new.payee_member is null then raise exception 'Pick the team member this salary is for'; end if;
  end if;
  return new;
end $$;

create or replace function public.money_after_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_who text := coalesce(member_name(auth.uid()), 'System'); v_sal boolean;
begin
  if tg_table_name = 'expenses' then
    v_sal := coalesce(new.category, old.category) = 'salary';
    if tg_op = 'INSERT' then
      perform log_event('expense_added', 'finance', new.id::text,
        case when v_sal then 'Recorded a salary payment' else 'Added expense "' || new.title || '" (' || fmt_money(new.amount) || ')' end);
      if new.recurring_id is null and auth.uid() is not null and not v_sal then
        perform notify_managers('finance', 'New expense: ' || new.title || ' ' || fmt_money(new.amount), 'By ' || v_who, '#/finance?tab=expenses');
      end if;
    elsif tg_op = 'UPDATE' then
      perform log_event('expense_updated', 'finance', new.id::text, case when v_sal then 'Updated a salary payment' else 'Updated expense "' || new.title || '"' end);
    else
      perform log_event('expense_deleted', 'finance', old.id::text, case when v_sal then 'Deleted a salary payment' else 'Deleted expense "' || old.title || '"' end);
    end if;
  elsif tg_table_name = 'recurring_expenses' then
    v_sal := coalesce(new.category, old.category) = 'salary';
    if tg_op = 'INSERT' then
      perform log_event('recurring_added', 'finance', new.id::text, case when v_sal then 'Added a monthly salary' else 'Added recurring bill "' || new.title || '"' end);
    elsif tg_op = 'DELETE' then
      perform log_event('recurring_deleted', 'finance', old.id::text, case when v_sal then 'Removed a salary' else 'Removed recurring bill "' || old.title || '"' end);
    end if;
  elsif tg_table_name = 'investments' then
    if tg_op = 'INSERT' then
      perform log_event('investment_added', 'finance', new.id::text, 'Added investment from ' || new.source || ' (' || fmt_money(new.amount) || ')');
      perform notify_managers('finance', 'New investment: ' || fmt_money(new.amount) || ' from ' || new.source, 'By ' || v_who, '#/finance?tab=investments');
    elsif tg_op = 'DELETE' then
      perform log_event('investment_deleted', 'finance', old.id::text, 'Deleted investment from ' || old.source);
    end if;
  end if;
  return coalesce(new, old);
end $$;

do $$ declare t text; begin
  foreach t in array array['expenses', 'recurring_expenses', 'investments'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_before', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.money_before_write()', t || '_before', t);
    execute format('drop trigger if exists %I on public.%I', t || '_after', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.money_after_write()', t || '_after', t);
  end loop;
end $$;

-- ---------- Recurring bills: pay / skip ----------
-- Internal: records the expense for the bill's current due date and moves the due date on
create or replace function public.recurring_post(p_id bigint, p_amount numeric, p_paid_on date) returns bigint
language plpgsql security definer set search_path = public as $$
declare r recurring_expenses%rowtype; v_id bigint;
begin
  select * into r from recurring_expenses where id = p_id for update;
  insert into expenses (title, category, amount, spent_on, vendor, payee_member, recurring_id, period, notes)
  values (r.title, r.category, coalesce(p_amount, r.amount), coalesce(p_paid_on, r.next_due), r.vendor, r.payee_member, r.id, r.next_due,
          case r.frequency when 'monthly' then 'For ' || to_char(r.next_due, 'Mon YYYY') else 'Due ' || to_char(r.next_due, 'DD Mon YYYY') end)
  on conflict (recurring_id, period) where recurring_id is not null do nothing
  returning id into v_id;
  update recurring_expenses set next_due = advance_due(r.next_due, r.frequency) where id = p_id;
  return v_id;
end $$;

create or replace function public.recurring_mark_paid(p_id bigint, p_amount numeric default null, p_paid_on date default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); r recurring_expenses%rowtype; v_id bigint;
begin
  select * into r from recurring_expenses where id = p_id for update;
  if not found then raise exception 'Bill not found'; end if;
  if not can_money(r.category, 'edit') then raise exception 'You don''t have permission to record this payment'; end if;
  if p_amount is not null and p_amount < 0 then raise exception 'Amount can''t be negative'; end if;
  v_id := recurring_post(p_id, p_amount, coalesce(p_paid_on, (now() at time zone app_tz())::date));
  perform log_event('recurring_paid', 'finance', p_id::text,
    case when r.category = 'salary' then 'Paid salary of ' || coalesce(member_name(r.payee_member), 'a member') || ' for ' || to_char(r.next_due, 'Mon YYYY')
         else 'Paid "' || r.title || '" due ' || to_char(r.next_due, 'DD Mon YYYY') end);
  return v_id;
end $$;

create or replace function public.recurring_skip(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := assert_active(); r recurring_expenses%rowtype;
begin
  select * into r from recurring_expenses where id = p_id for update;
  if not found then raise exception 'Bill not found'; end if;
  if not can_money(r.category, 'edit') then raise exception 'You don''t have permission to change this bill'; end if;
  update recurring_expenses set next_due = advance_due(r.next_due, r.frequency) where id = p_id;
  perform log_event('recurring_skipped', 'finance', p_id::text, 'Skipped ' || case when r.category = 'salary' then 'a salary' else '"' || r.title || '"' end || ' due ' || to_char(r.next_due, 'DD Mon YYYY'));
end $$;

-- ---------- Reminders + auto charges + monthly report notice ----------
-- Safe to call any number of times (the app calls it when someone opens it); each step happens once.
create or replace function public.finance_sweep() returns int
language plpgsql security definer set search_path = public as $$
declare r recurring_expenses%rowtype; v_today date := (now() at time zone app_tz())::date; n int := 0; g int;
        v_sal boolean; v_label text; v_prev date; v_rev numeric; v_exp numeric; v_link text := '#/finance?tab=recurring';
begin
  if auth.uid() is not null then perform assert_active(); end if;
  perform pg_advisory_xact_lock(hashtext('ehos_finance_sweep'));
  for r in select * from recurring_expenses where active and next_due <= v_today + remind_days order by next_due loop
    v_sal := r.category = 'salary';
    v_label := case when v_sal then 'Salary: ' || coalesce(member_name(r.payee_member), r.title) else r.title end;
    if r.auto_post and r.next_due <= v_today then
      g := 0;
      while r.next_due <= v_today and g < 24 loop
        perform recurring_post(r.id, null, r.next_due);
        perform notify_finance_people(v_sal, 'Charged: ' || v_label || ' ' || fmt_money(r.amount),
          'Recorded as an expense for ' || to_char(r.next_due, 'DD Mon YYYY'), '#/finance?tab=expenses');
        select * into r from recurring_expenses where id = r.id;
        g := g + 1; n := n + 1;
      end loop;
    elsif r.next_due <= v_today then
      if r.reminded_due_for is distinct from r.next_due then
        perform notify_finance_people(v_sal, case when r.next_due < v_today then 'Overdue: ' else 'Due today: ' end || v_label || ' ' || fmt_money(r.amount),
          'Was due ' || to_char(r.next_due, 'DD Mon YYYY') || '. Mark it paid in Finance.', v_link);
        update recurring_expenses set reminded_due_for = r.next_due where id = r.id;
        n := n + 1;
      end if;
    elsif r.reminded_upcoming_for is distinct from r.next_due then
      perform notify_finance_people(v_sal, 'Coming up: ' || v_label || ' ' || fmt_money(r.amount),
        'Due ' || to_char(r.next_due, 'DD Mon YYYY') || ' (in ' || (r.next_due - v_today) || ' days)' || case when r.auto_post then '. Charged automatically.' else '' end, v_link);
      update recurring_expenses set reminded_upcoming_for = r.next_due where id = r.id;
      n := n + 1;
    end if;
  end loop;

  -- Last month's report, once, if there is any money data at all
  v_prev := (date_trunc('month', v_today) - interval '1 month')::date;
  if not exists (select 1 from finance_report_log where month = v_prev)
     and (exists (select 1 from expenses) or exists (select 1 from invoices) or exists (select 1 from investments)) then
    insert into finance_report_log (month) values (v_prev) on conflict do nothing;
    select coalesce(sum(amount), 0) into v_rev from invoices where status = 'paid' and paid_date >= v_prev and paid_date < (v_prev + interval '1 month')::date;
    select coalesce(sum(amount), 0) into v_exp from expenses where spent_on >= v_prev and spent_on < (v_prev + interval '1 month')::date;
    perform notify_finance_people(false, 'Finance report ready: ' || to_char(v_prev, 'FMMonth YYYY'),
      'Revenue ' || fmt_money(v_rev) || ', expenses ' || fmt_money(v_exp) || ', ' || case when v_rev - v_exp >= 0 then 'profit ' else 'loss ' end || fmt_money(abs(v_rev - v_exp)),
      '#/finance?tab=report&month=' || to_char(v_prev, 'YYYY-MM'));
    n := n + 1;
  end if;
  return n;
end $$;

-- ---------- Numbers for the dashboard ----------
create or replace function public.finance_overview() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_today date := (now() at time zone app_tz())::date; v_m date; v_sal boolean := is_manager(); r jsonb;
        v_inv numeric; v_rev numeric; v_exp numeric; v_burn numeric;
begin
  if not perm('finance', 'view') then raise exception 'You don''t have access to finance'; end if;
  v_m := date_trunc('month', v_today)::date;
  select coalesce(sum(amount), 0) into v_inv from investments;
  select coalesce(sum(amount), 0) into v_rev from invoices where status = 'paid';
  select coalesce(sum(amount), 0) into v_exp from expenses;
  select coalesce(sum(amount), 0) / 3 into v_burn from expenses where spent_on >= (v_m - interval '3 months')::date and spent_on < v_m;
  select jsonb_build_object(
    'currency', (select currency from app_settings where id = 1),
    'month', to_char(v_m, 'YYYY-MM'),
    'revenue_month', coalesce((select sum(amount) from invoices where status = 'paid' and paid_date >= v_m), 0),
    'expenses_month', coalesce((select sum(amount) from expenses where spent_on >= v_m), 0),
    'revenue_last', coalesce((select sum(amount) from invoices where status = 'paid' and paid_date >= (v_m - interval '1 month')::date and paid_date < v_m), 0),
    'expenses_last', coalesce((select sum(amount) from expenses where spent_on >= (v_m - interval '1 month')::date and spent_on < v_m), 0),
    'invested_total', v_inv, 'revenue_total', v_rev, 'expenses_total', v_exp, 'cash', v_inv + v_rev - v_exp,
    'burn', round(v_burn, 2), 'runway_months', case when v_burn > 0 then round((v_inv + v_rev - v_exp) / v_burn, 1) end,
    'outstanding', coalesce((select sum(amount) from invoices where status = 'sent'), 0),
    'monthly_fixed', coalesce((select sum(case frequency when 'weekly' then amount * 52 / 12 when 'quarterly' then amount / 3 when 'yearly' then amount / 12 else amount end)
                                 from recurring_expenses where active), 0),
    'salaries_monthly', case when v_sal then coalesce((select sum(case frequency when 'weekly' then amount * 52 / 12 when 'quarterly' then amount / 3 when 'yearly' then amount / 12 else amount end)
                                 from recurring_expenses where active and category = 'salary'), 0) end,
    'months', (select coalesce(jsonb_agg(jsonb_build_object('month', to_char(m, 'YYYY-MM'),
                 'revenue', coalesce((select sum(amount) from invoices where status = 'paid' and paid_date >= m and paid_date < m + interval '1 month'), 0),
                 'expenses', coalesce((select sum(amount) from expenses where spent_on >= m and spent_on < m + interval '1 month'), 0)) order by m), '[]'::jsonb)
               from generate_series(v_m - interval '11 months', v_m, interval '1 month') m),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'total', t) order by t desc), '[]'::jsonb)
               from (select category, sum(amount) t from expenses where spent_on >= v_m group by category) x),
    'upcoming', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', case when category = 'salary' then 'Salary: ' || coalesce(member_name(payee_member), title) else title end,
                 'category', category, 'amount', amount, 'next_due', next_due, 'auto_post', auto_post) order by next_due), '[]'::jsonb)
               from recurring_expenses where active and next_due <= v_today + 30 and (category <> 'salary' or v_sal))
  ) into r;
  return r;
end $$;

-- ---------- Monthly report ----------
create or replace function public.finance_report(p_month date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_from date := date_trunc('month', p_month)::date; v_to date; v_prev date; v_sal boolean := is_manager(); r jsonb;
        v_rev numeric; v_exp numeric;
begin
  if not perm('finance', 'view') then raise exception 'You don''t have access to finance'; end if;
  v_to := (v_from + interval '1 month')::date; v_prev := (v_from - interval '1 month')::date;
  select coalesce(sum(amount), 0) into v_rev from invoices where status = 'paid' and paid_date >= v_from and paid_date < v_to;
  select coalesce(sum(amount), 0) into v_exp from expenses where spent_on >= v_from and spent_on < v_to;
  select jsonb_build_object(
    'month', to_char(v_from, 'YYYY-MM'), 'currency', (select currency from app_settings where id = 1), 'show_salaries', v_sal,
    'revenue', v_rev, 'expenses', v_exp, 'net', v_rev - v_exp,
    'salaries', coalesce((select sum(amount) from expenses where category = 'salary' and spent_on >= v_from and spent_on < v_to), 0),
    'invoiced', coalesce((select sum(amount) from invoices where status in ('sent', 'paid') and issue_date >= v_from and issue_date < v_to), 0),
    'investments', coalesce((select sum(amount) from investments where invested_on >= v_from and invested_on < v_to), 0),
    'cash_end', coalesce((select sum(amount) from investments where invested_on < v_to), 0)
              + coalesce((select sum(amount) from invoices where status = 'paid' and paid_date < v_to), 0)
              - coalesce((select sum(amount) from expenses where spent_on < v_to), 0),
    'prev', jsonb_build_object(
      'revenue', coalesce((select sum(amount) from invoices where status = 'paid' and paid_date >= v_prev and paid_date < v_from), 0),
      'expenses', coalesce((select sum(amount) from expenses where spent_on >= v_prev and spent_on < v_from), 0)),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'total', t, 'count', c) order by t desc), '[]'::jsonb)
               from (select category, sum(amount) t, count(*) c from expenses where spent_on >= v_from and spent_on < v_to group by category) x),
    'expense_rows', (select coalesce(jsonb_agg(jsonb_build_object('title', case when category = 'salary' and not v_sal then 'Salaries' else title end,
                 'category', category, 'amount', amount, 'spent_on', spent_on, 'vendor', vendor,
                 'payee', case when v_sal then member_name(payee_member) end) order by spent_on, id), '[]'::jsonb)
               from expenses where spent_on >= v_from and spent_on < v_to),
    'revenue_rows', (select coalesce(jsonb_agg(jsonb_build_object('client', c.name, 'invoice', coalesce(i.invoice_number, '#' || i.id), 'amount', i.amount, 'paid_date', i.paid_date) order by i.paid_date), '[]'::jsonb)
               from invoices i left join clients c on c.id = i.client_id where i.status = 'paid' and i.paid_date >= v_from and i.paid_date < v_to),
    'investment_rows', (select coalesce(jsonb_agg(jsonb_build_object('source', source, 'kind', kind, 'amount', amount, 'invested_on', invested_on) order by invested_on), '[]'::jsonb)
               from investments where invested_on >= v_from and invested_on < v_to)
  ) into r;
  return r;
end $$;

-- ---------- RLS ----------
alter table public.expenses           enable row level security;
alter table public.recurring_expenses enable row level security;
alter table public.investments        enable row level security;
alter table public.finance_report_log enable row level security;

do $$ declare t text; begin
  foreach t in array array['expenses', 'recurring_expenses'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.can_money(category, ''view''))', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (public.can_money(category, ''edit''))', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('create policy %I on public.%I for update to authenticated using (public.can_money(category, ''edit'')) with check (public.can_money(category, ''edit''))', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using (public.can_money(category, ''delete''))', t || '_delete', t);
  end loop;
end $$;
drop policy if exists investments_read on public.investments;
create policy investments_read on public.investments for select to authenticated using ((select public.perm('finance', 'view')));
drop policy if exists investments_insert on public.investments;
create policy investments_insert on public.investments for insert to authenticated with check ((select public.perm('finance', 'edit')));
drop policy if exists investments_update on public.investments;
create policy investments_update on public.investments for update to authenticated using ((select public.perm('finance', 'edit'))) with check ((select public.perm('finance', 'edit')));
drop policy if exists investments_delete on public.investments;
create policy investments_delete on public.investments for delete to authenticated using ((select public.perm('finance', 'delete')));

revoke all on public.expenses, public.recurring_expenses, public.investments, public.finance_report_log from anon, authenticated;
grant select, insert, delete on public.expenses, public.recurring_expenses, public.investments to authenticated;
grant update (title, category, amount, spent_on, vendor, notes, paid_by, payee_member) on public.expenses to authenticated;
grant update (title, category, amount, frequency, next_due, vendor, payee_member, auto_post, remind_days, active, notes) on public.recurring_expenses to authenticated;
grant update (source, investor_id, kind, amount, invested_on, notes) on public.investments to authenticated;
grant all on public.expenses, public.recurring_expenses, public.investments, public.finance_report_log to service_role;

revoke execute on all functions in schema public from public, anon;
revoke execute on function public.notify_finance_people(boolean, text, text, text), public.money_before_write(), public.money_after_write(),
  public.recurring_post(bigint, numeric, date) from authenticated;
grant execute on function public.can_money(text, text), public.fmt_money(numeric), public.advance_due(date, text),
  public.recurring_mark_paid(bigint, numeric, date), public.recurring_skip(bigint), public.finance_sweep(),
  public.finance_overview(), public.finance_report(date) to authenticated;

-- Done. Next: create your admin user (see README, step 2).
