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
- Projects (`projects`, part 4 of schema): a client has one or more projects. Admin/manager creates a project (Client drawer → Create project) and sets `project_manager` (must have the Project Manager role). The PM sees only their projects: the client's basic details, tasks / invoices / files tagged with `project_id`.
- Project team (`project_members`) is written only through RPCs: `project_member_request` → `project_member_decide` / `project_member_cancel` / `project_member_remove`. Approval rule: admin/manager adds → `approver='pm'` (only that project's PM approves); PM adds → `approver='manager'` (admin or any manager approves); project with no PM, or a manager who is its PM → `approver='auto'`. Rows are never deleted: status pending → approved / rejected / cancelled, approved → removed, with requested_by/at, decided_by/at, removed_by/at as the history.
- Project workspace: `#/project/<id>` (`public/js/pages/project.js`), tabs Overview / Live view (website snapshot via WordPress mShots + optional iframe, social links from `projects.socials`) / Requirements (`project_requirements` checklist) / Tasks (board of `tasks.project_id`) / Files / Finances / Settings (details + team). Top-left button is the project switcher. Project tasks are hidden from the main Tasks page (`project_id is null`).
- Founding team: 4 co-founders in `FOUNDERS` (server.js + `team-config.js`) get job_title `Co-Founder`, their department and the Manager role via `POST /api/setup/founders` (admin only; Team page banner "Set up founding team"). Co-Founder is not in the `DESIGNATIONS` list (A–Z sorted).
- Adding to a project team: pick a designation (`PROJECT_ROLES` in `team-config.js`, matched against `profiles.job_title`), then a person who already has it. PMs can't create accounts.
- Leads can only be assigned to members with the Sales Representative role, and only a Sales Representative, a manager or the admin can assign (`leads_assign_check`). Lead Generation's form has no assign field. Every new lead notifies admin + managers; unassigned ones also notify the Sales team, who pick them up from the Sales Representative tab ("Not assigned yet" panel, `bindLeadsPanel`) or Leads → "Not assigned yet".
- Business finance (part 7): `expenses`, `recurring_expenses` (tools, salaries, rent; `auto_post` = card subscription charged automatically), `investments`. Finance page tabs: Dashboard (`finance_overview()`), Expenses, Bills & salaries (`recurring_mark_paid`, `recurring_skip`), Investments, Invoices, Monthly report (`finance_report(month)`, print/PDF + CSV). Salaries (`category='salary'`) are readable only by admin/managers (`can_money()`); reports show salary totals to the Finance role but not names. `finance_sweep()` (called by app.js on every app load, idempotent) sends due/upcoming reminders, posts auto charges, and once a month a "report ready" notice, to admin + managers (+ Finance team except for salaries) via `notify_finance_people()`.
- Currencies (part 8): expenses / bills / investments store `currency`, `amount_original` and `fx_rate`; `amount` is always converted to the app currency (Settings) by `money_before_write()` and used in every total. UI picker in `public/js/currency.js` (currency first, then amount; live rate from open.er-api.com, editable).
- Bills (part 9): frequency `once | weekly | monthly | quarterly | yearly`. The bill form asks for the **Paid on** date (or "Not paid yet" + due date) and shows the renewal date and days left (`addFreq()` in finance.js mirrors `advance_due()`). A new, already-paid bill also records that payment as an expense. Paying a one-time bill closes it (`active=false`). Clicking any date input opens the calendar (app.js).
- Invoices (part 10): every client gets `clients.buid` (`BUID-1001…`, sequence `client_buid_seq`) and a unique 2-letter `invoice_code` (`invoice_initials()`: two words → first letters, one word → first + last letter, taken → another code from the name; never changes after creation). `invoices.kind` = `client` (needs `client_id`) or `business` (our own invoice for someone outside the app: `bill_to` jsonb, no client). The trigger `invoices_details_before()` makes the number (`INV-BUID-HF001` per client / `INV-<company initials>001` for business, counters in `invoice_counters`), `reference_no` (`REF-YYMMDD-<id>`), `issued_by` + name + title snapshot (`issuer_title()`: designation, else Admin, else team roles), the total from `items` (discount first, then `tax_percent`) and the currency conversion (`currency`, `amount_original`, `fx_rate` → `amount` in app currency). Number, reference, issuer and kind are locked after insert. UI: `public/js/invoices.js` (choose client → editor with line items → invoice view → Print / save PDF through a hidden iframe). The template is `invoiceDocHTML()` + `INVOICE_CSS`; company address / payment details come from `app_settings.invoice_details` (Settings → Invoice details). Finance tabs: Client invoices, Business invoices. `invoice_next_number(kind, client)` previews the next number.
- Invoice template (part 11): the printed invoice follows the owner's Ecometrix Hub template (`Ecometrix_Hub_07_Invoice.docx`): TAX INVOICE header with the number, a meta table (invoice date, due date, `invoices.billing_period`, currency, reference, status), Billed to (client name, contact, `clients.address` + country, email, BUID), items (# / Description / Qty / Rate / Amount), Subtotal / Discount / Tax (x%) / Total due, Payment details table (account title, bank, IBAN, SWIFT, Wise/Payoneer, Reference = invoice number), a Terms box built by `termsText()` from `due_days` / `pause_days`, the ad-spend note, "Issued by" name + designation, footer email · website · phone and "Confidential — Prepared by …". All company/payment values live in `app_settings.invoice_details` (jsonb keys: logo (small image data URL, png/jpg/webp/svg ≤ 300 KB, checked by `safeLogo()`), logo_has_name, address, email, phone, website, account_title, bank, iban, swift, wallet, payment, due_days, pause_days, footer_note, terms); `INVOICE_DEFAULTS` fills email/website/phone/days/note when empty. New invoices get due date = issue date + `due_days` and billing period = that month (`monthPeriod()`); both move when the date changes. Print fits one A4 page.
- Legacy: `clients.project_manager` and `client_members` still work in SQL, but the UI no longer sets them; the part 4 migration moves them into a project once.
- Notifications: `notifications` table filled only by triggers (`tasks_notify`, `leads_notify`, `clients_notify`, `finance_notify`, `files_notify`, `client_members_notify`) via `notify()` / `notify_managers()` / `notify_role()`; never notify the actor. Bell UI in `public/js/notify.js`.
- Module access per role lives in `role_permissions` (leads / clients / finance / projects × view / edit / delete), edited on the Permissions page. SQL checks: `perm()`, `pm_perm()`, `can_client()`, `can_invoice()`, `can_project()`, `can_manage_project()`, `client_via_project()`, `can_project_invoice()`, `can_storage_file()`. Project Manager access applies only to projects where `projects.project_manager` is them. Project files are stored at `<client>/p<project>/…`.
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
npm test         # runs supabase/schema.sql in an in-memory Postgres and checks RLS, timers, sessions, reports (243 checks)
```

## Where things live
| Path | What |
|---|---|
| `supabase/schema.sql` | All tables, RLS policies, grants, and Postgres functions (RPCs). Idempotent: safe to re-run. |
| `tests/db.test.mjs` | DB test suite (PGlite + stubbed `auth` schema). Add a test for every schema change. |
| `server.js` | Admin-only API: `POST /api/members` (invite link), `PATCH /api/members/:id`, `POST /api/members/:id/status`, `POST /api/members/:id/access-link`, `POST /api/setup/founders`. Verifies the caller's JWT and admin role. |
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
