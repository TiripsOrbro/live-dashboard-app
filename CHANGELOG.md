# Dashboard changelog

Plain-English summary of what changed in each release — written for store managers and admins, not developers.

**Current live branch:** `Version-0.4`

---

## How to update this file

Do this **every time you cut a new version branch** (e.g. `Version-0.4`) and push it live:

1. Add a **new section at the top** of [Release history](#release-history) (below this guide).
2. Use the version name, date, and four lists where they apply:
   - **Added** — new screens, buttons, reports, or behaviour
   - **Changed** — things that still exist but work differently
   - **Fixed** — bugs or reliability improvements
   - **Removed** — features or pages taken away (say what to use instead)
3. Add a **“What you need to do”** note if stores or the Pi need anything (hard refresh, new bookmark, etc.).
4. Update the **Current live branch** line at the top of this file.
5. Commit `CHANGELOG.md` in the same release commit or the first commit on the new branch.

Tip: skim the git log since the last release tag (`git log Version-0.3..HEAD --oneline`) and translate each meaningful change into one bullet.

---

## Release history


### Version 0.4.3 – June 2026

**Added**

- **Feature requests** — super-admin `/requests` page with tabs, priorities, milestones, and expandable panels.
- **Admin user creation** — create crew accounts from **View accounts** with auto-generated temporary passwords.
- **First sign-in setup** — new users link Macromatix (Manager/MIC) and set a personal password before using the dashboard.
- **Create account UI** — access level, store, market, and area pickers use clear tick-box lists instead of broken dropdowns.

**Changed**

- **Feature request tabs** — empty tabs hide from the bar; urgent tabs sort leftmost; Unassigned replaces All.
- **Create account flow** — no manual password or MMX at create time when using temporary passwords; MMX is verified on first login.

**Fixed**

- **Tab creation** — clearer errors and reliable category updates when creating tabs from the requests page.

**What you need to do**

- On the Pi: `git pull origin Version-0.4 && npm install && pm2 restart dashboard`
- Hard refresh once (Ctrl+F5) on tablets and admin pages after deploy.

---

### Version 0.4.2 – June 2026

**Added**

- **Sales progress chart** — hourly actual vs last-year pace on the live dashboard.
- **Forecast scheduler** — scheduled forecast runs via PM2 and manual-pack helpers.
- **Lifelenz forecast scraper** — login, day-parts, and probe scripts for Lifelenz integration.

**Changed**

- **MIC overview SSSG** — recomputed live from hourly actuals and scraped LY slots instead of stale snapshot values.
- **Admin forecast & build-to** — expanded settings UI, styles, and catalog override tooling.

**Fixed**

- **SSSG for WA stores** — last-year Macromatix grid uses Melbourne-time rows (+2h offset for Perth stores) so SSSG matches Macromatix cumulative display.
- **SSSG date keys** — Perth stores use local trading date, not Melbourne date, for LY cache lookups.

**What you need to do**

- On the Pi: `git pull origin Version-0.4 && npm install && pm2 restart dashboard`
- Hard refresh once (Ctrl+F5) on MIC overview after deploy.

---

### Version 0.4.1 – June 2026

**Added**

- **Admin settings menu** — forecast submit/history, global build-to overrides, and managed store accounts (role-gated from MIC settings).
- **Forecast automation** — Macromatix forecast scraper, history/status ledgers, dashboard APIs, and import/probe npm scripts.
- **FORECAST_SCRAPER_HEADLESS** — optional env flag for watching forecast browser sessions (see .env.example).

**Changed**

- Dashboard and MIC settings use the shared admin menu shell; Macromatix scraper exports helpers used by forecast and SSSG fast paths.
### Version 0.4.0 — June 2026

**Added**

- **CORE Operations & CORE Food Safety self-score audits** — weekly store audits with PDF reports; all crew (above team member) can start and complete.
- **Visiting as a Coach & Visiting as a Customer** — area-coach-and-above visit audits at each store, with role-gated hub tiles and APIs.
- **Market compliance view** — market managers and IT see areas as columns on `/tacaudit/summary` with `n/total` rollups; **Area | Market** toggle on the compliance toolbar.
- **Audit compliance grid** — Operations, Food Safety, Coach visit, and Customer visit rows now reflect live weekly completion (replacing manual splash clicks for CORE).
- **Domain layout** — code reorganised into `dashboard/`, `tacaudit/`, `mmx/`, `stores/`, `users/`, `vendors/` modules with shared `src/paths.js` routing.
- **PDF question import** — `npm run import-audit-pdf` regenerates audit schemas from source PDFs.

**Changed**

- **TacAudit compliance capture** — wider store columns; single outer border on copy-image captures (no double outline).
- **Package version** — app reports **0.4.0** via Settings and login footer.

**Fixed**

- CORE and coach rows on the area grid use live audit status instead of manual placeholder splash state.

**What you need to do**

- On the Pi: `git pull origin Version-0.4 && npm install && pm2 restart dashboard`
- Run `node scripts/migrate-domain-layout.js` once if upgrading from 0.3.x on an existing Pi data tree.
- Hard refresh once (Ctrl+F5) on tablets after deploy.

---

### Version 0.3.7 — June 2026

**Added**

- **TacoAudit** — audit history, settings, and weekly forms (Pest Walk, RGM Cleaning, PSI, Square One) with PDF email on completion.
- **Admin area summary** — traffic-light grid across stores (PERIOD/WEEK, regions, PSI, Pest, DFSC actions, RGM, Square One); open from `/tacaudit/summary` or any audit tile on MIC overview.
- **Daily stock count** — enter counts by location tab in the app and submit to Macromatix (open-count detection, variance review).
- **MIC overview** — unified `/overview` for store, area, and admin scopes; area/market multi-store tiles; PSI tile on store overview.
- **Markets config** — `config/markets.json` for area/market groupings (example file included).

**Changed**

- **Admin MIC overview** — DFSC tile restored (links to TacAudit safety-culture row); Area summary tile removed (audit tiles already open the grid).
- **Store MIC layout** — VOC/DFSC and Daily count/Orders rows align in equal-width columns.
- **Stock count** — **Send to MMX** always visible; saves then sends when you tap it.
- **Daily count** — smaller Macromatix check popup; **Back to Overview** button.
- **URLs** — `/overview` landing; legacy admin/store paths redirect where needed.
- **DFSC mobile** — edge-to-edge question cards, scroll preservation, group auto-collapse.

**Fixed**

- **PSI on store MIC** — no longer dropped when two Square One areas are due the same week.
- **Stock count** — combined-vendor tabs detect unsaved counts correctly before send.

**Removed**

- Standalone **admin overview** and **stores** pages (replaced by `/overview` and MIC tiles).

**What you need to do**

- On the Pi: `git pull origin Version-0.3 && pm2 restart dashboard`
- Hard refresh once (Ctrl+F5) on tablets after deploy.

---

### Version 0.3.6 — June 2026

**Fixed**

- **DFSC mobile** — question cards edge-to-edge; scroll position preserved when expanding groups.

**What you need to do**

- Hard refresh once after deploy.

---

### Version 0.3.5 — June 2026

**Added**

- **Vendor catalog in git** — `vendors/` (Americold, item codes, ConvertToBox) is tracked so Pi deploys match your catalog.
- **ISE spot-check logging** — after each Inventory Special Event download, pm2 logs cheese and nacho day-by-day usage for build-to audits.
- **Catalog ISE audit script** — `npm run audit-catalog-ise -- 3811` checks fridge/freezer/dry coverage against reports.

**Changed**

- **Build-to order rounding** — shortages round to the nearest whole carton (not always up). Small gaps under 1 carton no longer trigger an order.
- **Oil `order=8` lines** — scheduled orders use Stock On Hand from reports (not just manual count) when reports are available, so overstocked stores get zero order.
- **Cheese blend item code** — canonical code is **37876** (40255 / 40266 remain aliases for MMX forms).
- **MMX wait overlay** — single fading progress stream during stock count / report download (no dot checklist).

**Fixed**

- **Fridge build-to orders** — cheese blend orders 2 instead of 3 when shortage is ~2.2; oil no longer orders when SOH is above the fixed target.
- **Dry supplies** — Mexican seasoning and straws no longer order 1 when on-hand is within ~0.03 of build-to.
- **Stock count → MMX** — more reliable tab detection, pipeline recovery after idle/restart, and clearer progress on phones.
- **ISE name-match fallback** — build-to can match items by name when item codes differ between catalog and reports.

**What you need to do**

- On the Pi: `git pull origin Version-0.3 && pm2 restart dashboard`
- Hard refresh once on tablets after deploy.

---

### Version 0.3.4 — June 2026

**Changed**

- All pages scroll when content overflows, with **hidden scrollbars** (login, create-account, dashboards, stock count, DFSC, etc.).
- Sales dashboard still **scales to fit** the screen; scroll only kicks in when content is taller than the viewport.
- **Stock count** chip (“Stock count”) now appears in **mobile landscape** on the sales dashboard, not only portrait.
- Stock count **landscape layout**: tighter item boxes and input spacing on phones held sideways.

**What you need to do**

- Hard refresh once (Ctrl+F5) after deploy.

---

### Version 0.3.3 — June 2026

**Changed**

- **Canonical URL namespaces** for managers and admins:
  - **`/MIC/Overview`** — MIC home (tiles, mini dashboard)
  - **`/MIC/3811`** — MIC store sales dashboard
  - **`/Admin/Overview`** — admin home
  - **`/Admin/A22`** — admin area workspace: all stores in the area preload; **store tabs switch in-page** with no reload
- Old paths redirect automatically (`/3811/mic` → `/MIC/Overview`, `/admin/overview` → `/Admin/Overview`, `/3811` → `/MIC/3811` or `/Admin/A##` for admins).
- Combined area totals (VIC/WA grids) remain at **`/A22`** from the store picker “Area Dashboard” tile.

**What you need to do**

- Update bookmarks to the new paths above.
- Hard refresh (Ctrl+F5) once after deploy.

---

### Version 0.3.2 — June 2026

**Added**

- **Instant area dashboard tabs** — all four area dashboards load in one go; switching **Area 1 / 2 / 21 / 22** is instant with no full page reload.
- **Sign out** — available from the settings menu (gear icon).

**Changed**

- **Macromatix login on the Pi** — the scraper signs in on the store picker screen so all stores (including Queensland) appear and scrape correctly.
- **Single `.env` file** — the Pi and dev PC both use one `.env` at the project root (no separate `.env.production`).

**Fixed**

- **Queensland & Victoria store sales** — stores outside Area 22 now scrape and show on area dashboards after login credentials and store selection were corrected on the Pi.
- **First-login password** — you can keep the same password when it matches the temporary one (no forced change to an identical password).

**What you need to do**

- On the Pi: `git pull origin Version-0.3`, then `pm2 delete dashboard && pm2 start ecosystem.config.cjs --only dashboard && pm2 save`.
- Hard refresh once on tablets (`Update now` on login, or Ctrl+Shift+R) so area dashboard tabs load the new script.

---

### Version 0.3.1 — June 2026

**Added**

- **Update now on login** — after a server restart, the sign-in screen shows an **Update now** link so tablets can hard-refresh and load the latest pages.
- **What's new** — release notes are available from **Settings → What's new** (and a version number at the bottom of the login screen).
- **First-login password setup** — new accounts must set a proper password before using the dashboard (passwords are stored encrypted in `.Users`).
- **DFSC crew accounts** — managers can create crew logins with encrypted name and Macromatix details; primary store logins cannot open DFSC (use a crew account instead).

**Changed**

- Login **Update now** and the version label sit at the bottom of the sign-in screen, styled like **Create account**.

**Fixed**

- Nothing else in this patch beyond the login layout tweak.

**What you need to do**

- On the Pi: pull branch `Version-0.3`, run `npm install`, restart PM2 (`pm2 restart dashboard`).
- After restart, tap **Update now** on the login screen if it appears (or hard refresh once).

---

### Version 0.3 — June 2026

**Added**

- **DFSC (Daily Food Safety Checklist)** — full digital inspection at `/{store}/dfsc` (e.g. `/3811/dfsc`). Covers initial checks, cook temps, cold holding, cleaning, and sign-off with a name and signature.
- **DFSC history** — view past completed inspections, download a PDF report, or reopen a completed inspection to edit it.
- **Report for CORE** — 30-day DFSC completion summary plus open audits/actions, downloadable as a PDF from the DFSC landing page.
- **Bluetooth thermometer (Blue2)** — connect once at the top of the DFSC form; **Capture Temp** buttons fill temperature fields from the probe when connected.
- **MIC dashboard refresh** — manager overview at `/{store}/mic` with sales pace, SSSG, upselling, stock count, and a link to DFSC.
- **MIC mini dashboard** — compact MIC view for smaller screens.
- **Admin DFSC status** — admin overview shows which stores completed AM/PM DFSC today.
- **Store areas in `.storelist`** — stores can be grouped by area (e.g. Area 21, Area 22, Queensland) for the admin overview and area dashboards.
- **Per-store time zones** — Western Australia and Queensland stores can use their local time zone for trading hours and pace.

**Changed**

- **Single login for everyone** — admins can sign in at `/login` (same page as store managers) and are taken straight to the admin overview after login. The separate `/admin` login page still works.
- **First-login password setup** — accounts with a temporary plain-text password in `.Users` must choose a new password before using the dashboard. The new password is saved encrypted in `.Users`. Admins need a capital letter, special character, and number; store accounts need at least one of those (minimum 8 characters).
- **Macromatix scraping** — each store is logged into separately (better for accounts that only allow one store per login). Scraping also pulls **last year’s sales** data used for live **SSSG %**.
- **Upselling leaderboard** — scoring and storage updates for the podium display.

**Fixed**

- **Capture Temp** — only reads from the Blue2 when the thermometer is actually connected (no surprise Bluetooth pairing popup).
- **Macromatix store selection** — scraper navigates to the correct Change Store screen before clicking Select, with clearer errors when a store is not on the account.

**Removed**

- Nothing major was taken away in this release.

**What you need to do**

- On the Pi: pull branch `Version-0.3`, run `npm install`, restart PM2 (`pm2 restart dashboard`).
- Update `.storelist` on the Pi with all stores, areas, and time zones you want scraped.
- Hard refresh (`Ctrl+Shift+R`) or clear cache on tablets after the update so DFSC and MIC load the new pages.
- DFSC PDF export needs Chromium on the Pi (same as the sales scraper).

---

### Version 0.2 — May 2026

**Added**

- **Live SSSG %** — “same store sales growth” shown on store dashboards and MIC, calculated from today’s sales vs last year (scraped automatically from Macromatix).
- **SSSG week-to-date ledger** — tracks daily actual vs last year across the week (optional manual import for corrections).
- **Admin overview refresh** — cleaner tile layout, area filtering, and a promo banner slot.
- **MIC settings cog** — managers can adjust certain MIC display options from the MIC screen (shared settings module).
- **Scrape-driven refresh** — background sales refresh timed to match full scrape cycles on the Pi.

**Changed**

- **Default store area** — stores without an area in `.storelist` default to “Area 22”.
- **Admin overview tiles** — SSSG, VOC placeholders, stock count, and store snapshots updated to match the new layout.

**Fixed**

- More reliable sales cache timing when many stores are scraped in one cycle.

**Removed**

- Nothing major was taken away in this release.

**What you need to do**

- Ensure `.env.production` on the Pi has a long enough scrape timeout (`SCRAPE_TIMEOUT_MS=900000`) if you added many stores.
- First SSSG numbers may take one full scrape cycle to appear after upgrade.

---

### Version 0.1 — May 2026

**Added**

- **Admin overview** (`/admin/overview`) — see all stores at a glance: sales pace, SSSG/VOC placeholders, stock count status, grouped by area.
- **Admin store tabs** — admins can switch between store dashboards without going back to the picker.
- **Store pace bars** — visual on-track / behind / ahead indicator on sales and MIC views.
- **Western Australia time zone** — Perth stores (3901–3904) use `Australia/Perth` for pace and “today” calculations so bars match local trading hours.
- **Store snapshot rows** — compact store summary rows on admin and area views (name, actual/forecast, SSSG, status bar).
- **Stock count notifications** — in-app alerts when stock count needs attention.
- **Upselling podium hook** — foundation for the upselling leaderboard display on MIC.
- **Area dashboards** — view stores grouped by area.

**Changed**

- **Navigation** — improved back button and admin chrome across dashboard pages.
- **Stock count UI** — layout and styling updates on the stock count screen.

**Fixed**

- Pace calculations respect per-store time zones (especially WA vs Melbourne).

**Removed**

- Nothing major was taken away in this release.

**What you need to do**

- Admin accounts need `access: *` or `all` in `.Users` to reach `/admin/overview`.
- Add `area` and `timeZone` columns to `.storelist` when you want area grouping and correct WA/QLD hours.

---

## Before Version 0.1

Earlier releases focused on the core live sales grid, scheduled orders, stock count, and multi-store scraping. Those features are still the foundation — Version 0.1 and later built MIC, admin overview, SSSG, and DFSC on top of them.
