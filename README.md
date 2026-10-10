# EcomHub OS

Ecometrix Hub ka internal workspace: team, roles, tasks, task timers, aur login/activity tracking.
HTML + CSS + JavaScript (frontend), Node/Express (server), Supabase (database + login), Vercel (live).

---

## Live karne ke 6 steps (≈ 20 minute)

### 1. Supabase project banao
1. https://supabase.com → **New project** (region: Singapore ya Mumbai, Pakistan ke qareeb).
2. Project ready hone ke baad: **SQL Editor → New query**.
3. `supabase/schema.sql` ka pura content paste karo → **Run**. "Success" aana chahiye.

### 2. Apna Admin account banao
1. **Authentication → Users → Add user → Create new user**
   - Email + password daalo, **Auto Confirm User** ✓ on rakho.
2. **SQL Editor** mein ye chalao (apni email ke saath):
   ```sql
   select public.promote_to_admin('aapki@email.com');
   ```
   Ab ye account Admin hai. Public signup se koi Admin nahi ban sakta.

### 3. Keys copy karo
**Project Settings → API Keys** (aur **Data API** se Project URL):

| Vercel variable | Kahan se |
|---|---|
| `SUPABASE_URL` | Project URL, jaise `https://abcd.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key (`sb_publishable_...`) ya legacy **anon** key |
| `SUPABASE_SECRET_KEY` | Secret key (`sb_secret_...`) ya legacy **service_role** key. **Ye kisi ko mat dena.** |
| `SITE_URL` | Aapka live link, jaise `https://ecomhub-os.vercel.app` (step 4 ke baad) |

### 4. Vercel pe deploy karo
1. Ye folder GitHub pe push karo (new repo, private).
2. https://vercel.com → **Add New → Project → Import** wo repo.
3. Framework khud **Express** detect hoga. Kuch change nahi karna.
4. **Environment Variables** mein upar wale 3 keys daalo → **Deploy**.
5. Live URL mil jaye to `SITE_URL` bhi add karo aur **Redeploy** karo.

### 5. Supabase ko live link batao
**Authentication → URL Configuration**:
- **Site URL**: `https://ecomhub-os.vercel.app`
- **Redirect URLs** mein add karo: `https://ecomhub-os.vercel.app/set-password.html`
  (local testing ke liye `http://localhost:3000/set-password.html` bhi)

### 6. Team add karo
1. Live link kholo → Admin email/password se sign in.
2. **Team → Add team member** → naam, email, aur **ek ya zyada roles** select karo.
3. Invite link milega → **Copy** ya **Share on WhatsApp**.
4. Member link kholta hai → password set karta hai → seedha apne dashboard mein.

---

## Roles kaise kaam karte hain
- **Admin**: sab kuch manage karta hai (team, tasks, review, reports, settings).
- **Team member**: sirf apne assigned tasks pe kaam karta hai.
- Team roles: Sales Representative, Lead Generation, Cold Caller, Finance, Manager.
  Ek member ke multiple roles ho sakte hain. Jitne roles, utne tabs uske sidebar mein (jaise Cold Caller + Lead Generation = 2 tabs).
- Task banate waqt **Role** chuno → "Assign to" list mein sirf us role wale members aate hain → task us member ke **My tasks** aur us role ke tab mein foran dikhta hai.

## Public lead form
Leads → **Share lead form** se link milta hai: `https://aapka-link/lead-form.html`. Login nahi chahiye. Agent list mein Lead Generation role wale members aate hain, aur "Other" pe naam type hota hai. Nayi lead pe admin aur managers ko notification jati hai.

## Tracking kya record hota hai
| Cheez | Matlab |
|---|---|
| Signed in | Session kitni der open raha |
| Active | EcomHub OS tab mein click / key / scroll hota raha |
| Idle | 5 minute (Settings se change) koi interaction nahi |
| Task timer | Member ne task pe Start/Pause/Stop se jo time lagaya |

- Har minute heartbeat jata hai. Browser band ya internet gaya to session ~3 minute baad "Connection lost" (est.) se band hota hai.
- Timer chalta rehta hai agar tab open hai (chahe member Photoshop/Figma mein ho). App 20+ minute band rahe to timer khud pause ho jata hai.
- Typing, screenshots, ya doosri apps kabhi record nahi hoti. Members apna record **My activity** aur **My work time** mein dekh sakte hain.
- Saara time server ki ghadi se, UTC mein save hota hai. Reports Settings wali timezone (default `Asia/Karachi`) mein dikhti hain.

## Local pe chalana (optional)
```bash
npm install
cp .env.example .env      # keys daalo
npm run dev               # http://localhost:3000
npm test                  # database tests (security, timers, reports)
```
Claude Code mein ye folder kholo: `CLAUDE.md` mein project ke rules aur architecture hain, Claude Code usse khud padhta hai.
Node 20.6+ chahiye.

## Zaroori notes
- **Password reset email**: Supabase ka built-in email sirf kuch emails/hour bhejta hai. Agar member ko email na mile to Admin **Team → member → Get password reset link** se link bana ke WhatsApp kar de. Baad mein Supabase → Authentication → SMTP mein apna email provider (Resend/Brevo) laga sakte ho.
- **Deactivate** karne se member sign out ho jata hai aur login band. Uska purana data (tasks, time, logs) safe rehta hai.
- Jis task pe time track ho chuka hai wo delete nahi hota (record ke liye). Usse Completed mark karo.

## Files
```
public/            Frontend (HTML, CSS, JS) — Vercel CDN se serve hota hai
  login.html, set-password.html, app.html
  css/app.css      Design system
  js/app.js        Shell + navigation (role ke hisaab se)
  js/tracker.js    Active/idle + heartbeat
  js/timer.js      Task timer
  js/pages/        Har page ki file
server.js          Express API: members add/edit, roles, invite links, activate/deactivate
supabase/schema.sql  Tables, security (RLS), timers, sessions, reports
```
