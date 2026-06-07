# Dashboard changelog

Plain-English summary of what changed in each release — written for store managers and admins, not developers.

**Current live branch:** `Version-0.3.1`

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
