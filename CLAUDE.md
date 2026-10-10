# EcomHub OS — notes for Claude Code

Internal team, task and work-time tracking app for **Ecometrix Hub** (one organization, one Admin, many team members).
The owner talks in **Hinglish** and prefers short, direct answers with a clear recommendation.

## Scope (don't expand without being asked)
- Single workspace. No multi-tenant, no "add business", no billing, no subscriptions.
- Two account types: `admin` (manages everything) and `member` (works on tasks assigned to them).
- Team roles (a member can hold several, each adds a sidebar tab): Sales Representative `sales_rep`, Lead Generation `lead_gen`, Cold Caller `cold_caller`, Finance `finance`, Manager `manager`, Project Manager `project_manager`.
- **Manager role = admin-level access** (`is_manager()` in SQL, `state.isAdmin` in JS) except Settings and Permissions, which only the admin account (`state.isOwner`) can change.
- Business modules: Leads → (Mark as won → `lead_mark_won`) → Clients (onboarding, PM, invoices, contracts/files in Storage bucket `client-files`) → Finance (revenue = paid invoices, `business_summary()`).
- Leads pipeline: new → contacted → qualified → meeting → proposal → negotiation → won/lost. A won lead is converted with `lead_convert()` (sets `client_id`); "Converted to client" is a filter, not a stage. Lead form fields + options live in `public/js/lead-options.js`, shared with the public form `public/lead-form.html` (no login, posts to `POST /api/public/lead`, agents from `GET /api/public/form` = members with the Lead Generation role, or a typed name).
- Client agents: `client_members` (designer, web dev…). Agents can view their clients; the client's project manager (or admin/manager) assigns them tasks with `tasks.client_id`.
- Notifications: `notifications` table filled only by triggers (`tasks_notify`, `leads_notify`, `clients_notify`, `finance_notify`, `files_notify`, `client_members_notify`) via `notify()` / `notify_managers()` / `notify_role()`; never notify the actor. Bell UI in `public/js/notify.js`.
- Module access per role lives in `role_permissions` (leads / clients / finance × view / edit / delete), edited on the Permissions page. SQL checks: `perm()`, `pm_perm()`, `can_client()`, `can_invoice()`. Project Manager access applies only to clients where `clients.project_manager` is them.
- Not built yet on purpose: task file attachments (members paste Drive links in comments), timer corrections, custom SMTP. Build only when asked.

## Stack — keep it this way
- Frontend: plain HTML, CSS, vanilla JS ES modules in `public/`. **No React/Vue/Next, no bundler, no build step.**
- Server: Node + Express in `server.js` (Vercel zero-config Express → one function). Vercel serves `public/**` from its CDN; `express.static` only runs locally.
- Database + auth: Supabase (Postgres, Auth, RLS). Browser loads `@supabase/supabase-js` from jsDelivr, pinned to `2.117.2`.
- Keys come from env vars only (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, optional `SITE_URL`). The browser gets URL + publishable key from `GET /api/config`. **Never put the secret key in `public/` or hard-code any key.**

## Commands
```bash
npm install
npm run dev      # http://localhost:3000 (needs .env, see .env.example)
npm test         # runs supabase/schema.sql in an in-memory Postgres and checks RLS, timers, sessions, reports (121 checks)
```

## Where things live
| Path | What |
|---|---|
| `supabase/schema.sql` | All tables, RLS policies, grants, and Postgres functions (RPCs). Idempotent: safe to re-run. |
| `tests/db.test.mjs` | DB test suite (PGlite + stubbed `auth` schema). Add a test for every schema change. |
| `server.js` | Admin-only API: `POST /api/members` (invite link), `PATCH /api/members/:id`, `POST /api/members/:id/status`, `POST /api/members/:id/access-link`. Verifies the caller's JWT and admin role. |
| `public/js/app.js` | Boot, role-based sidebar, hash router (`#/route`). Admin routes vs member routes + `#/role/<key>` tabs. |
| `public/js/tracker.js` | Presence: heartbeat every 60s, idle after `idle_minutes`, never records key contents. |
| `public/js/timer.js` | Running task timer state, live clocks (`data-live-*`), top-bar pill. |
| `public/js/task-drawer.js` | Task detail drawer (timer, status, comments, review) + admin task form. |
| `public/js/components.js` | Day ribbon, period picker, bar chart, stats strip, activity-log rows. |
| `public/js/ui.js` | `esc()`, icons, toast, drawer, modal, confirm dialog, CSV download. |
| `public/js/time.js` | All date/time formatting in the app timezone (`app_settings.timezone`). |
| `public/js/data.js` | `q()`, `rpc()`, `api()` wrappers + shared queries. |
| `public/js/pages/*.js` | One file per page. Each exports `render({ el, params, arg, route, setTitle })` and may return a cleanup function. |
| `public/css/app.css` | Design tokens and every component style. |

## Data and security rules
- Browsers only **read** tables (RLS decides which rows). All writes go through:
  - Postgres functions (`security definer`, use `auth.uid()` and `now()`): `session_start`, `session_heartbeat`, `session_end`, `timer_start`, `timer_pause`, `timer_stop`, `my_timer`, `task_set_status`, `task_review`, `team_presence`, `list_sessions`, `report_daily`, `report_tasks`, `day_timeline`; or
  - direct table writes the grants allow: admin insert/update/delete on `tasks` (RLS checks `is_admin()`), comments insert, own profile name/phone, admin settings update; or
  - `server.js` with the secret key (members, roles, status, invite/reset links) via `admin_save_member` / `admin_set_member_status`.
- Never trust client timestamps or durations. Server time (`now()`) is the source of truth; times are stored in UTC and shown in the app timezone.
- Activity logs are append-only. Write them with `log_event(...)` inside functions or from `server.js`; never log tokens or passwords.
- Never hard-delete members, sessions, time entries or logs. Deactivate instead.

## Tracking semantics (keep these separate, never add them up)
- **Signed in** = session open time. **Active** = interacting with the EcomHub OS tab. **Idle** = signed in − active. **Task timer** = explicit time on tasks.
- One running timer per member (unique partial index). Starting another task pauses the first (`switch`).
- Session with no heartbeat for 3 min → ended as `disconnected` at last heartbeat (`end_estimated = true`).
- Running timer with nobody in the app for 20 min → auto-paused at the last presence (`auto`). Logout / deactivation pauses it immediately.
- Reports split intervals at the app timezone's midnight and merge overlaps per member (`report_daily`).

## Changing the database
1. Edit `supabase/schema.sql`. New tables: `create table if not exists`. New columns on existing tables: add `alter table ... add column if not exists ...` (because `create table if not exists` won't add them). Functions: `create or replace`. Policies: `drop policy if exists` then `create policy`.
2. Add/adjust checks in `tests/db.test.mjs`, run `npm test`, all must pass.
3. Remind the owner to paste the updated `schema.sql` into Supabase → SQL Editor → Run.

## UI conventions
- Light theme with the tokens at the top of `app.css` (white / `#F8FAFC` canvas, ink `#0F172A`, accent indigo `#4F46E5`, success `#16A34A`, warning `#D97706`, error `#DC2626`). Font: Geist.
- Active time = indigo, idle = pale indigo, task timer = green, everywhere (ribbon, charts, legends).
- Escape all user content with `esc()` before putting it in HTML.
- Sentence-case copy, plain verbs, no ALL-CAPS labels. Every list has an empty state; every action shows a toast or inline error.
- Must work at 390px width with no horizontal scroll (tables scroll inside `.table-wrap`).
- Use real data only. No fake stats or demo accounts.

## Adding a new team role
Insert into `team_roles` and default rows into `role_permissions` (in `schema.sql`), add the key to `ROLE_KEYS` in `server.js`, add `--role-<key>` + `[data-role="<key>"]` in `app.css`, and an icon in `ROLE_ICONS` (`ui.js`).

## Before saying something is done
Run `npm test`, run `node --check` on changed JS files, and open the changed page in the browser. Say clearly what was verified and what wasn't (e.g. anything that needs the live Supabase project).
