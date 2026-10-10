# EcomHub OS — Handbook for Claude (read this first in every new chat)

> **For Claude:** This document is the single source of truth for EcomHub OS as it is built today (October 2026). Where it disagrees with the older "Project Instructions" text (which was the original v1 brief), **this handbook wins**. Read it fully before answering, then work from the code in the user's repo when you need exact details.

---

## 1. Who you're working with

- **Owner:** runs **Ecometrix Hub** (ecometrixhub.com), a performance-marketing and ecommerce growth agency (UK/USA clients), based in Pakistan. Account email: ecometrixhub@gmail.com.
- **Language:** talk in **Hinglish** (Roman Urdu/Hindi + English). Short, direct, clear recommendation, no long option lists.
- **How he works:** not a developer. He uses VS Code + terminal (PowerShell on Windows) only to `git add . / git commit / git push`, and the Supabase SQL Editor to run `schema.sql`. Always end a code change with these exact steps.
- **Never** ask him for the Supabase secret key, and never put it in frontend code.

### Leadership (the "founding team")
| Co-founder | Department | Email | App role |
|---|---|---|---|
| Maliha Khan | Digital Marketing & Client Accounts & Finance | khanmaliha99909@gmail.com | Manager |
| Haseeb Gul | Tech & Operations | haseebg0012@gmail.com | Manager (or the Admin account itself, if that email is the admin) |
| Taha Khan | Growth & Sales (Online) | tk9715495@gmail.com | Manager |
| Tahir Khan | Business Development (Field) | tk247454@gmail.com | Manager |

- Designation for all four = **"Co-Founder"** (not part of the designation dropdown).
- There is exactly **one Admin** account. Co-founders are **Managers**, not admins.

---

## 2. Where everything lives

| Thing | Location |
|---|---|
| Live app | https://ecomhuboperatingsystem.vercel.app (Vercel, auto-deploys on push to `main`) |
| GitHub repo | `ecometrixhub-pixel/ecomhuboperatingsystem` (branch `main`) |
| Owner's local folder | `D:\Ecometrix Hub\EcomHub-OS\ECOMHUB FROM CLAUDE` |
| Database + login | Supabase (Postgres, Auth, RLS, Storage bucket `client-files`) |
| Developer notes in repo | `CLAUDE.md` (architecture + rules, keep it updated) |
| Owner guide in repo | `README.md` (Hinglish setup steps) |

**Vercel env vars:** `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (server only), `SITE_URL` = https://ecomhuboperatingsystem.vercel.app.
**Supabase Auth → URL config:** Site URL = live URL; redirect URL = `<live URL>/set-password.html`.

### Delivery routine after every change
1. Edit files, run `npm test` (DB tests, currently **243 passing**), `node --check` the changed JS, and check the page in a headless browser.
2. Copy the changed files to the owner's local folder (when his computer is linked), or give them to him.
3. Tell him in Hinglish:
   - Run the whole `supabase/schema.sql` in Supabase → SQL Editor, **only if the schema changed**. It is safe to re-run.
   - Then run:
     ```
     git add .
     git commit -m "<short message>"
     git push
     ```
4. Vercel deploys automatically. If no new deployment appears, push an empty commit (`git commit --allow-empty -m "Trigger deploy"`). Never "Redeploy" an old deployment.

---

## 3. Tech stack (don't change it)

- **Frontend:** plain HTML + CSS + vanilla JS ES modules in `public/`. No React, no bundler, no build step.
- **Server:** Node + Express in `server.js`. On Vercel it runs as one function, and `public/**` is served by the CDN.
- **Database:** Supabase. All tables, RLS, triggers and RPCs live in **`supabase/schema.sql`**, an idempotent file in **11 parts**. New changes go in a new part at the bottom.
- **Browser Supabase client:** `@supabase/supabase-js@2.117.2` from jsDelivr. The browser gets the URL + publishable key from `GET /api/config`.
- **Tests:** `tests/db.test.mjs` runs the whole schema in PGlite (in-memory Postgres) and checks RLS, permissions, timers, notifications and finance. Add tests for every schema change.
- **Design:**
  - Light theme, font Geist, accent indigo `#4F46E5`.
  - Success `#16A34A`, warning `#D97706`, error `#DC2626`.
  - Sentence-case copy, real data only, must work at 390px width.

---

## 4. Roles and access

**Account types:** `admin` (one account) and `member`. A member can hold **several team roles**, and each role adds a tab in the sidebar ("My roles").

| Role key | Name | What it's for |
|---|---|---|
| `sales_rep` | Sales Representative | Works leads, updates stage, assigns leads, converts won leads |
| `lead_gen` | Lead Generation | Adds leads (form / CSV / public form). **Cannot assign** leads |
| `cold_caller` | Cold Caller | Calls leads |
| `finance` | Finance | Invoices, expenses, bills (not salaries) |
| `manager` | Manager | **Admin-level access**, except Settings and Permissions (owner-only) |
| `project_manager` | Project Manager | Runs only the projects assigned to them |

- **Permissions page (admin only):**
  - Modules: Leads / Clients / Projects / Finance.
  - Actions: can see / edit / delete, per role.
  - Project Manager permissions apply only to their own projects.
- **Designations (job titles), A–Z:** Ads Specialist, Cold Caller, Content Writer, Creatives & Posting Agent, Finance Executive, Graphic Designer, Intern, Lead Generation Agent, Outreach Agent, Project Manager, Sales Representative, SEO Specialist, Social Media Manager, UI/UX Designer, Video Editor, Web Developer (+ "Other").
- **Departments, A–Z:** Business Development (Field) · Digital Marketing & Client Accounts & Finance · Growth & Sales (Online) · Tech & Operations.
- Everything is enforced **in the database (RLS + functions)**, not just hidden in the UI.

---

## 5. Every module and how it flows

### 5.1 Login and accounts
- No public signup. The admin was created in Supabase and promoted with `select public.promote_to_admin('email')`.
- **Team → Add team member:**
  - Fields: name, email, phone, joining date, Department, Designation, Roles.
  - Saving gives a **one-time invite link** (copy / WhatsApp). The member sets a password at `/set-password.html`.
- **Team → Set up founding team** (admin only): creates or updates the 4 co-founders as Managers with title + department, and shows their invite links. Endpoint: `POST /api/setup/founders`.
- Member profile drawer:
  - Roles, this week's time, Projects (with **Add to a project**).
  - Records links, new invite / password-reset link, deactivate.
  - Deactivate keeps all history.
- **Top-right avatar menu:** Edit profile, Settings, Permissions (admin), My activity, Sign out. The sidebar is collapsible.

### 5.2 Tasks and time tracking
- Tasks have title, description, role, assignee, priority, start/due date, and status To do → In progress → In review → Completed.
- Assignee **sees "Assigned by Name, Designation"**.
- **Task timer:** Start / Pause / Stop, one running timer per person, server timestamps. It auto-pauses after 20 min away.
- **Presence:** heartbeat every 60s. Idle after N minutes (Settings, default 5). A session with no heartbeat for 3 min ends as "disconnected" (estimated).
- Keep **Signed in / Active / Idle / Task timer** separate and never add them together. Nothing records keystrokes or screenshots.
- **Pages:**
  - Work tracking: daily/weekly/monthly/custom reports, charts, CSV.
  - Login history.
  - Activity logs: append-only audit trail with filters.
- The main **Tasks page hides project tasks**; those live inside each project. A member's "My tasks" still shows their project tasks, so they can run the timer.

### 5.3 Leads
1. **Pipeline:** New → Contacted → Qualified → Meeting → Proposal → Negotiation → Won / Lost.
2. **Lead form fields:**
   - Name, Company (required), email, phone, website.
   - Country (Pakistan/USA/UK/Others + text), Niche (Clothing, Jewelry, Cosmetics, Skincare, Shoes, Home Decor, Restaurants, Salons, Real Estate, Gyms, Clinics, Other).
   - Service, **Currency first then Budget**, Source, Stage, Priority, Agent, Follow-up date, Notes.
3. **Public lead form:** `/lead-form.html`, no login. The agent dropdown lists Lead Generation members + "Other" (name typed and auto-formatted, e.g. "Haseeb Gul"). It has a honeypot and rate limit.
4. **Lead Generation** adds leads but **cannot assign**.
5. Every new lead notifies **Admin + Managers**. Unassigned leads also notify the **Sales team**.
6. **Assigning:** only **Sales Representatives** can be assigned. Only Sales Rep / Manager / Admin can assign.
   - Leads table "Assigned to" dropdown.
   - Sales Rep tab **"Not assigned yet"** panel with **Take it** / Assign to….
   - Leads filter "Not assigned yet".
7. **Won** → notification to managers → **Convert to client** (confirm). The app then asks **"Create a project now?"**. Filter "Converted to client".
8. CSV import is available for leads.

### 5.4 Clients
- Fields: onboarding date, status (Onboarding/Active/Paused/Churned), retainer, services, notes.
- Every client gets a **Business ID (BUID)** automatically: BUID-1001, BUID-1002 … and a 2-letter invoice code from the name (Him Fashions → HF; one word → first + last letter; if taken, another unique code from the name). Both never change.
- Tabs: **Projects**, Tasks, Invoices, Files (contracts/documents in Supabase Storage).
- **Create project** button lives on the client.

### 5.5 Projects
1. A client can have many projects. The Admin/Manager sets the **Project Manager**, who gets a notification.
2. **Projects page** = cards. A PM only sees their own projects, and approved team members see the projects they're on.
3. **Project workspace** (`#/project/<id>`). The **top-left heading is a switcher** to jump between your projects. Tabs:
   1. **Overview:** tasks done, requirements met, time on tasks, paid amount, scope, client details, team.
   2. **Live view:** website snapshot (WordPress mShots) + optional live iframe + "Open site"; social cards (Instagram, Facebook, TikTok, YouTube, LinkedIn, X).
   3. **Requirements:** checklist; tick off with who/when.
   4. **Tasks:** board, only this project's tasks.
   5. **Files**, and **Finances** (this project's invoices only).
   6. **Settings:** project details (website, socials, dates, status, scope) + team.
4. **Adding people (approval flow):**
   - Pick a **role/designation first**, then a person who already has it. A PM can't create accounts.
   - Admin/Manager adds → the **PM approves**.
   - PM adds → **Admin or any Manager** approves (first one wins).
   - No PM yet → added directly.
   - Full **history**: who asked, who approved/rejected, when, and the note.
   - Removing a member is also logged.

### 5.6 Finance (business money)
- **Finance page tabs:**
  1. **Dashboard:**
     - Cash in business = invested + earned − spent.
     - Revenue / Expenses / Profit this month vs last month.
     - Fixed costs per month and runway; unpaid invoices.
     - 12-month revenue vs expenses chart; spend by category; upcoming bills; recent expenses.
  2. **Expenses:**
     - Categories: Tools & software, Salaries, Rent & office, Ads & marketing, Freelancers, Internet & utilities, Equipment, Travel & meals, Taxes & fees, Other.
     - Month filter, CSV, "Paid by" a co-founder.
  3. **Bills & salaries:**
     - Recurring tools, salaries, rent; frequency One time / Weekly / Monthly / Every 3 months / Yearly.
     - **Paid on** date, or "Not paid yet" + due date. The form shows **"Renews on" + days left**.
     - A new, already-paid bill records that payment as an expense.
     - **Charged automatically** posts the expense on the renewal date. Otherwise press **Mark paid**; **Skip** is also available.
     - Paying a one-time bill closes it.
  4. **Investments:** who put money in (co-founder or outside), capital/loan/grant.
  5. **Client invoices:** choose the client first (search by name or BUID) → add lines (description, qty, price), discount, tax %, any currency → **Create invoice** → the invoice opens → **Print / save PDF**. Number is automatic: **INV-BUID-HF001**, HF002 … per client. Date, reference (REF-YYMMDD-id) and **Issued by (name + designation)** are automatic too. CSV.
  6. **Business invoices:** our own invoices for someone who isn't a client in the app (type name/company). Numbers **INV-EH001**, EH002 … Paid ones count as revenue too.
  - Company address, email, phone and **payment/bank details** for the invoice: Settings → **Invoice details** (admin).
  - **Invoice template = owner's own design** (`Ecometrix_Hub_07_Invoice.docx`), one A4 page:
    1. Header: **logo** (upload in Settings → Invoice details; PNG/JPG/WEBP/SVG up to 300 KB; tick "logo already shows the name" to hide the text name) + company + "TAX INVOICE" (just "INVOICE" when tax is 0%) + **Invoice INV-BUID-HF001**.
    2. Table: Invoice date · Due date · **Billing period** (e.g. "1–31 October 2026") · Currency · Reference no. · Status.
    3. **Billed to:** client name, contact person, **address** + country, email, BUID chip. (Client address is a field on Clients → Edit.)
    4. Items # / Description / Qty / Rate / Amount → Subtotal, Discount, Tax (x%), **Total due**.
    5. **Payment details** table: Account title, Bank, IBAN, SWIFT, Wise / Payoneer, **Reference = invoice number** (automatic).
    6. **Terms** box: "Payment is due within [7] days … Services may pause on invoices more than [14] days overdue …" — the 7 and 14 come from Settings.
    7. Ad-spend note + thank you, **Issued by** (name + designation of whoever created it), footer: connect@ecometrixhub.com · www.ecometrixhub.com · +92 341 34288187 · "Confidential — Prepared by Ecometrix Hub".
  - Auto on every new invoice: number, reference, invoice date (today), due date (= date + due days), billing period (= that month), issued by. Changing the date moves due date and period too; all except number/reference/issuer can be edited.
  7. **Monthly report:** any month; revenue, expenses, salaries, profit/loss, cash at month end, by category, all rows. **Print / save PDF** and CSV.
- **Any currency:** pick currency first, then amount. A live exchange rate (open.er-api.com) is filled in and can be edited. Totals are in the **app currency from Settings** (recommendation: set it to PKR).
- **Salaries are visible only to Admin + Managers.** The Finance role sees salary totals in reports but no names.
- **Reminders** (run whenever anyone opens the app, idempotent):
  - "Coming up" X days before, "Due today", "Overdue", "Charged: …".
  - A monthly **"Finance report ready"** notice on the 1st.
  - Sent to Admin + Managers (+ the Finance team, except salary reminders).
- **Revenue** = paid invoices.

### 5.7 Notifications
- Bell, top right, polls every 30s and is created only by DB triggers. **The person who caused an event is never notified.**
- Covers tasks (assigned, review, approved, changes), leads, clients, projects (assigned, approvals), files, finance.

### 5.8 Dashboards
- **Admin/Manager dashboard:** team online/active/idle, task stats, review queue, deadlines, today's ribbon, revenue block.
- **Member dashboard:** my tasks, today's tracked time, running timer, deadlines, recent activity.

---

## 6. File map (most-used)

```
supabase/schema.sql      Parts 1–10: core, leads/clients/finance perms, notifications, projects,
                         workspace, sales routing, business finance, currencies, one-time bills, invoices v2 (BUID), invoice template fields (Part 11)
tests/db.test.mjs        DB test suite (243 checks)
server.js                /api/config, /api/members*, /api/setup/founders, /api/public/form, /api/public/lead
public/app.html          The app shell; login.html, set-password.html, lead-form.html
public/js/app.js         Boot, sidebar per role, router (#/route, #/role/<key>, #/project/<id>), finance_sweep on load
public/js/state.js       Roles/permissions in the browser (isOwner, isAdmin=manager-level, perms, pmPerms)
public/js/team-config.js FOUNDERS, DEPARTMENTS, DESIGNATIONS (A–Z), PROJECT_ROLES
public/js/currency.js    Currency picker, live rates, fmtCur/fmtPaid
public/js/invoices.js    Invoice editor, invoice template (invoiceDocHTML + INVOICE_CSS), viewer, print/PDF
public/js/lead-options.js Lead form fields (shared with the public form)
public/js/pages/         One file per page: admin-dashboard, member-home, team, tasks, my-tasks, leads,
                         clients, projects (cards + helpers), project (workspace), finance, permissions,
                         tracking, logins, logs, settings, profile, my-activity
public/css/app.css       All styles
```

---

## 7. Rules for Claude in this project

1. Fresh features go in **small, tested steps**: schema part → tests → UI → browser check → hand over with steps.
2. Never weaken security: RLS stays on, all writes go through allowed grants/RPCs, the secret key stays server-only, and timestamps come from the server.
3. Never hard-delete history (members, sessions, time, logs, project requests). Deactivate or mark a status instead.
4. Use real data only; no fake stats or demo accounts in production.
5. Don't add unrequested modules. Ask in one line if a request is ambiguous; otherwise build.
6. Keep `CLAUDE.md` and this handbook in sync when behavior changes.
7. Say clearly what was tested and what still needs checking on the live Supabase.

**Known limits / not built yet (only build when asked):**
- Task file attachments (links in comments instead) and timer corrections.
- Email/WhatsApp notifications (in-app bell only); custom SMTP for reset emails.
- The invoice design follows the owner's template (Part 11). To change it, edit `invoiceDocHTML()` / `INVOICE_CSS` in `public/js/invoices.js`.
- Many sites block the iframe live view; the snapshot + "Open site" always work.

---

## 8. Making the complete video guide (for the next chat)

The owner wants a **full walkthrough video of EcomHub OS** for the team. When he asks for it in a new chat, produce these deliverables:

1. **Video plan + script**, in a **Docs artifact**: chapters, on-screen steps, voice-over lines in **Hinglish**, and the length of each part.
2. **Shot list / recording checklist**: which account to log in with, which page, what to click, and what to say.
3. Optional **per-role short videos** (2–4 min each) so each person only watches their part.
4. If asked, **slides** (Slides artifact) for intro/outro and chapter cards, and **thumbnail/cover** ideas.

### Suggested structure (≈ 25–35 min full, or split per role)

| # | Chapter | Show | Account to use |
|---|---|---|---|
| 0 | Intro (1 min) | What EcomHub OS is, who uses it, the login page | — |
| 1 | Getting in (2 min) | Invite link → set password → dashboard; profile menu; collapse sidebar; bell | New member |
| 2 | Admin setup (4 min) | Team → Add member (department, designation, roles) → invite link; Set up founding team; Permissions; Settings (currency, timezone, idle minutes) | Admin |
| 3 | Daily work & time (4 min) | My tasks, Start/Pause timer, submit for review, "Assigned by"; Work tracking, Login history, Activity logs | Member + Manager |
| 4 | Leads (4 min) | Lead Gen adds a lead (form + public form + CSV); Sales Rep "Not assigned yet" → Take it; move stages; Won → Convert to client → Create project | Lead Gen, Sales Rep |
| 5 | Clients (2 min) | Client page, files/contracts, invoices, projects tab | Manager |
| 6 | Projects (6 min) | Create project + PM; PM's Projects cards → workspace; switcher; Live view; Requirements; Tasks board; Settings → add by role → approval flow + history | Manager, PM |
| 7 | Finance (6 min) | Dashboard; add expense (currency → amount → rate); add bill (paid date, renews on, days left, one-time); salaries; Mark paid; investments; monthly report → PDF | Admin / Co-founder |
| 8 | Privacy & rules (1 min) | What's tracked and what isn't; salaries are private; approvals | — |
| 9 | Outro (1 min) | Where to get help, who to ask | — |

### Before recording (tell the owner)
- Create **demo data in a test way**: a sample lead "Demo Brand", a demo client and project, a few tasks, one expense and bill. Delete or mark them afterwards. Never show real client data or salaries in a shared video.
- Use separate browser profiles or incognito windows for each role account.
- Record at 1920×1080 with browser zoom at 100–110%. Hide bookmarks; turn off notifications.
- Tools: OBS Studio (free) or Loom; edit in CapCut / DaVinci Resolve.
- Voice-over in Hinglish, short sentences, one action per sentence.

---

*Last updated: 10 Oct 2026, after Part 11 (invoice template from Ecometrix_Hub_07_Invoice.docx: billing period, client address, bank/Wise table, terms days).*
