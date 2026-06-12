# Live Dashboard App

## Overview
The Live Dashboard App is a web application designed to pull data from a website that requires user authentication. This application runs on a Raspberry Pi and provides a live dashboard interface to display the scraped data.

## Project Structure

Domain-based layout — each area owns `src/`, `public/`, `data/`, and `config/`:

```
live-dashboard-app/
├── src/
│   ├── app.js          # Express entry + schedulers
│   ├── paths.js        # Central path registry
│   └── services/       # Re-export shims (legacy require paths)
├── dashboard/          # Sales grid, upselling, SSSG
├── vendors/            # Stock counts, build-to, catalogs, reports
├── stores/             # .storelist, markets, store hours
├── users/              # Auth, MIC UI, per-role accounts/
├── mmx/                # Macromatix Puppeteer scraping
├── tacaudit/           # Operational audits (named audit folders)
├── smg/                # SMG/VOC placeholder
├── nsf/                # NSF/CORE scraping placeholder
├── public/shared/      # Cross-cutting client assets
└── scripts/            # CLI tools + migrate-domain-layout.js
```

After pulling on the Pi, run `npm run migrate-domain-layout` once if upgrading from the old flat layout.

## Installation
1. Clone the repository:
   ```
   git clone <repository-url>
   cd live-dashboard-app
   ```

2. Install dependencies:
   ```
   npm install
   ```
   Puppeteer's bundled Chromium download is **skipped** (see `.npmrc`) because it has no ARM64 build and the scraper uses the system Chromium instead. See [Raspberry Pi setup](#raspberry-pi-setup-pm2) for installing Chromium.

3. Copy `.env.example` to `.env` and fill in Macromatix credentials and other settings. The app and PM2 load **only** `.env` (Pi and dev use the same file).

## Usage
1. Start the application:
   ```
   npm start
   ```

2. Open your web browser and navigate to `http://localhost:3000` to view the live dashboard.

## Changelog

Release notes in plain English (for store managers and admins) are in **[CHANGELOG.md](CHANGELOG.md)**. Update that file whenever you cut a new version branch — see the “How to update” section at the top.

## Raspberry Pi setup (PM2)

This is the current production setup (Pi 4, user `orbro`, sibling to `mmx-report-automation`). PM2 keeps the dashboard running, restarts it on crash, and brings it back after reboot.

### 1. System Chromium (required)

Puppeteer uses the system browser — there is no bundled Chromium on the Pi.

```sh
sudo apt update
sudo apt install -y chromium     # older Raspberry Pi OS: chromium-browser
which chromium || which chromium-browser
```

Put the resulting path in `.env` as `SCRAPER_EXECUTABLE_PATH` (e.g. `/usr/bin/chromium`). If you skip this, the app auto-detects common paths and otherwise exits with a clear error telling you to install Chromium.

### 2. Install dependencies

```sh
cd ~/live-dashboard-app
git pull
npm install        # Chromium download is skipped via .npmrc
```

### 3. `.env`

Create `~/live-dashboard-app/.env` (readable only by the Pi user):

```ini
NODE_ENV=production
DASHBOARD_TIME_ZONE=Australia/Melbourne
# Multi-store scrapes take minutes (~45-60s per store), so cache the whole cycle.
SALES_CACHE_SECONDS=300
# Background refresh keeps the cache warm for every store (0 disables it).
SALES_REFRESH_SECONDS=240
# Keep today's sales on screen for this many hours after close (default 2).
SCRAPE_POST_CLOSE_RETAIN_HOURS=2
# Full cycle = login + every store's labour + orders. ~1 min/store; allow plenty on a slow Pi.
SCRAPE_TIMEOUT_MS=900000
CONFIRMED_EMPTY_ORDER_CHECKS=2

# Multi-store: the stores to scrape/show and their hours live in `.storelist` (see "Multiple stores" below).
# DASHBOARD_STORE_NUMBERS is DEPRECATED — `.storelist` is now the master list.

# System Chromium (from step 1)
SCRAPER_EXECUTABLE_PATH=/usr/bin/chromium
SCRAPER_HEADLESS=true

# Speed: scrape stores in parallel using isolated browser sessions (each logs in once).
# Default 3. Lower to 2 if a Pi runs low on memory; set 1 to force sequential.
SCRAPER_CONCURRENCY=3
# Abort image/media/font requests for faster page loads (default on). Set 0 to disable.
SCRAPER_BLOCK_RESOURCES=true

# Dashboard access protection. Set a long random value.
DASHBOARD_ACCESS_KEY=change-this-long-random-dashboard-key

# Macromatix credentials — must be a login with access to every store you want to show.
SCRAPER_USERNAME=your-macromatix-username
SCRAPER_PASSWORD=your-macromatix-password
```

## Dashboard login accounts

Per-store logins live in `.Users` on the server (copy from `.Users.example`). This file is git-ignored — create it on the Pi and give each store their own username/password.

```
# Admin
admin |
your-admin-password |
*

# Chirnside Park
3811 |
CB3811 |
store-3811-password |
3811

# Dandenong South
3806 |
CB3806 |
store-3806-password |
3806
```

Each block is one store (or person). The `#` line is a display name shown on the welcome screen after login (e.g. `# Chirnside Park` → “Welcome, Chirnside Park”). The next lines are username, optional **colour-blind username** (`CB` + store number), password, and access. A trailing `|` on each line is optional. Usernames are matched case-insensitively (`Admin` and `admin` are the same).

- **Regular username** (e.g. `3811`) — standard green / yellow / red grid
- **CB username** (e.g. `CB3811`) — same password and welcome name; **blue** replaces green for “on track”
- **access: `*` or `all`** — every store (admin store picker); admins can sign in at **`/login`** or **`/admin`** and are taken to the admin overview
- **access: store numbers** — comma-separated list; one store skips the picker and opens that dashboard directly
- Passwords can be plaintext for quick setup; hash them for production:

```sh
node scripts/hash-dashboard-password.js "your-password"
```

Paste the `scrypt:…` output into `.Users` as the password line.

**First sign-in password change:** If the password line in `.Users` is still plain text (not `scrypt:…`), the user is sent to **Set your password** on first login. Their new password is written back to `.Users` as an encrypted `scrypt:` hash. Admin passwords must include a capital letter, a special character, and a number; store passwords must include at least one of those. Minimum length is 8 characters.

When `.Users` exists, username/password login is required. If no users file exists, the app falls back to the legacy single `DASHBOARD_ACCESS_KEY` (full admin access). With neither configured, the dashboard is open (dev only).

Sign out: `/logout`. Old `/unlock` bookmarks redirect to `/login`.

### Kiosk / no-login store links (optional)

For wall-mounted tablets that should open one store without signing in, enable nologin links in `.env`:

```ini
DASHBOARD_NOLOGIN_ENABLED=1
# Comma-separated store numbers, or * for every store in .storelist
DASHBOARD_NOLOGIN_STORES=3811
# Optional shared secret — then use /nologin/3811?key=your-secret
# DASHBOARD_NOLOGIN_SECRET=change-this-long-random-string
```

Open `https://tbadashboard.com/nologin/3811` (add `?key=…` if `DASHBOARD_NOLOGIN_SECRET` is set). The page loads **in place** (no redirect) with a long-lived **single-store** session. Cookies use `SameSite=None` by default so embedded players (Yodeck, etc.) can authenticate; if cookies are blocked, assets and API calls carry a signed `kiosk` token instead. The session cannot open other stores or the admin store picker. Use `/logout` to clear it.

Optional override: `DASHBOARD_NOLOGIN_SAMESITE=strict|lax|none` (default `none` for signage players).

After sign-in, the login page cross-fades to a charcoal welcome screen (using the `#` name from `.Users`), then transitions to the store picker or your store dashboard. The welcome animation is shown once per day per browser; later sign-ins the same day go straight through.

The **login and welcome screens use a dedicated dark theme** (black background, light text). The sales dashboard itself stays on the light grey layout for grid readability.

### Scrape failure alerts (optional)

Add to `.env` to get notified when Macromatix scraping fails (rate-limited to once per 30 minutes by default):

```ini
# Discord/Slack/generic webhook (JSON POST with { content, text })
DASHBOARD_ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Or email via SMTP (requires nodemailer — included in package.json)
DASHBOARD_ALERT_EMAIL=you@example.com
DASHBOARD_SMTP_HOST=smtp.gmail.com
DASHBOARD_SMTP_PORT=587
DASHBOARD_SMTP_USER=you@example.com
DASHBOARD_SMTP_PASS=your-app-password
DASHBOARD_SMTP_FROM=you@example.com

# Optional: cooldown between duplicate alerts (ms). Default 1800000 (30 min).
# DASHBOARD_ALERT_COOLDOWN_MS=1800000
```


### `.storelist` — the master list

`.storelist` (project root) is the single source of truth: it controls **which stores are scraped/served** and their **per-store trading hours**. Copy `.storelist.example` to `.storelist` and edit it. The file is git-ignored (a committed `.storelist.example` is used as a fallback if `.storelist` is absent).

Pipe-delimited, one store per line. `#` comments and blank lines are ignored:

```
# store# | name | openHour | closeHour   (24h; openHour = first trading hour, closeHour = closing hour so the last column shown is closeHour-1)
3811 | Chirnside Park | 10 | 22
3806 | Bayswater | 8 | 23
3901 | Example Store | 9 | 24
```

- `openHour` / `closeHour` are 24h. The grid shows columns `openHour … closeHour-1`. A midnight close can be written as `24` or `0`; hours past midnight as 25, 26 (e.g. a 1AM close = 25), bounded by what the Macromatix day-view actually returns.
- Add a line to add a store; remove a line to drop it. Changes apply on the next scrape cycle without a code change (and `/api/stores` reflects edits immediately, since it reads `.storelist` directly).

**Different hours on different days:** leave the hours off the store line and add one line per weekday beneath it (day name `Monday`..`Sunday` or `Mon`..`Sun`; indenting optional):

```
3811 | Chirnside Park | 10 | 22     # same hours every day

3901 | Midland                      # per-day hours
    Monday    | 10 | 23
    Tuesday   | 10 | 23
    Wednesday | 10 | 23
    Thursday  | 10 | 23
    Friday    | 10 | 24
    Saturday  | 10 | 24
    Sunday    | 10 | 23
```

Hours are resolved for **today in `Australia/Melbourne`** server-side, so the grid automatically uses the right hours each day (it self-corrects after the next scrape/refresh past midnight). Any weekday you omit falls back to the store's plain-line hours (if given) or the 10–22 default.

### Routing

The scraper logs in once and scrapes **every store in `.storelist`** in one cycle (selecting each store, re-entering Day view, then reading its scheduled orders). One app serves them all:

- `https://tbadashboard.com/` -> a **store picker**: a grid of clickable tiles, one per `.storelist` store, each linking to its dashboard.
- `https://tbadashboard.com/3806` -> store 3806, `/3811` -> store 3811, and so on. The page reads the store number from its URL path and requests `/api/sales?store=3806`.
- `GET /api/stores` lists `{ storeNumber, storeName, openHour, closeHour }` for every store (drives the picker and the per-store grid columns).

Notes:
- The login **must** have access to every store listed in `.storelist`.
- Each extra store adds time to every scrape cycle on the Pi — keep `.storelist` to the stores you actually use.
- `DASHBOARD_STORE_NUMBERS` is **deprecated** and ignored when `.storelist` is present (it only applies to the legacy auto-enumerate fallback used when no `.storelist` exists).
- Routing is domain-agnostic: the frontend uses `window.location.origin`, so any hostname pointed at the app gets the same path-based behaviour with no code change — only a Cloudflare DNS/ingress entry.

### Built-in stock counting (BuiltInOrdering)

Vendor item lists live in `vendors/` (copy from `vendors/examples/`):

| File | Macromatix vendor |
|------|-------------------|
| `vendors/.Americold` | Americold |
| `vendors/.Bega` | Bega |
| `vendors/.CutFresh` | Cut Fresh |
| `vendors/.Schweppes` | Schweppes |

Example templates are in `vendors/examples/`. Live vendor files are git-ignored; examples are committed.

Format (pipe-delimited):

```
# vendor: Americold
# location-order: Freezer | Fridge | Carryover | In Use
# locations: Freezer

Beef | Boxes | Bags | KGs | Freezer
10005242 | Sparkling Water 500ml | Packs | N/a | Bottles | Soft Drinks
8418 | Sour Cream 2kg | Tubs | N/a | KGs | Fridge
7769 | Dare Iced Coffee | N/a | N/a | Bottles | Fridge | In Use
```

- Optional leading **item code** before the name.
- Exactly **three unit columns** (`N/a` hides a column), then **one or more locations per item**.
- `# location-order:` controls tab order in the stock-count UI (only locations used by items appear).
- `# locations:` is the default when an item line omits trailing locations.

When a vendor appears under **Orders to place**, clicking it opens `/{store}/stock-count/{slug}` (e.g. `/3811/stock-count/americold`) instead of dismissing. Counts are saved per store/vendor/day in `data/stock-count-state.json`. **Send to MMX** fills Macromatix Key Item Count using `config/mmx-stock-count.json`:

- **Tabs:** FREEZER, CARRY OVER, FRIDGE, ON FLOOR - IN USE - THAW, DRY, SOFT DRINKS, COUNT AS 0 (dashboard locations map via `locationTabMap`). Schweppes dashboard tabs (BIBs, Freezes, Bottles, Cans, Other) all push to **SOFT DRINKS** in one MMX save.
- **Columns:** vendor unit columns map positionally to MMX Closing Box, Closing Inner, and Closing Unit (`N/a` skips a column).

Vendor dotfile locations must match dashboard names (`Freezer`, `Fridge`, `Carryover`, `In Use`, `Dry`, `Soft Drinks`, etc.).

### 4. Start under PM2

```sh
cd ~/live-dashboard-app
pm2 start ecosystem.config.cjs   # or: npm run pm2:start
pm2 save
pm2 startup                      # run the command it prints (once) to survive reboot
```

`ecosystem.config.cjs` loads `.env`, restarts on crash, and recycles the process if memory passes ~600 MB (guards against a long-running Chromium leak).

Useful commands:

```sh
pm2 logs dashboard
pm2 restart dashboard
pm2 status
```

The dashboard listens on `0.0.0.0:3000` — open `http://<pi-ip>:3000` from any LAN device.

### 5. Expose it with Cloudflare Tunnel

The public site is path-based, so a single tunnel hostname points at the Pi and Express handles `/3811`, `/3812`, etc. After a Pi rebuild, re-create the tunnel:

```sh
# Install cloudflared (arm64). If apt has no package, grab the .deb:
#   wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
#   sudo dpkg -i cloudflared-linux-arm64.deb
sudo apt install -y cloudflared || true

# Authorise the tbadashboard.com zone (opens a browser link to approve).
# The domain must already be added to your Cloudflare account (nameservers pointed at Cloudflare).
cloudflared tunnel login

# Create the tunnel and note the UUID + credentials json it writes to ~/.cloudflared/.
cloudflared tunnel create dashboard
```

Create `~/.cloudflared/config.yml` (replace `<UUID>` with the tunnel id):

```yaml
tunnel: <UUID>
credentials-file: /home/orbro/.cloudflared/<UUID>.json

ingress:
  - hostname: tbadashboard.com
    service: http://localhost:3000
  - service: http_status:404
```

Point DNS at the tunnel and install it as a boot service:

```sh
# Routes the apex (tbadashboard.com) to the tunnel via a proxied CNAME (Cloudflare flattens it at the root).
cloudflared tunnel route dns dashboard tbadashboard.com
# Optional: also serve www
# cloudflared tunnel route dns dashboard www.tbadashboard.com   # add a matching ingress hostname above
sudo cloudflared service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared
```

Test `https://tbadashboard.com/` and `https://tbadashboard.com/3806`. Path routing (`/3806`, `/3803`, `/3811`, ...) is handled entirely by Express + the frontend — no per-store DNS entries needed.

Adding another hostname later is config-only — add an `ingress` hostname pointing at the same `http://localhost:3000` and run `cloudflared tunnel route dns dashboard <new-hostname>`. No app changes.

### Alternative: systemd

If you prefer `systemd` over PM2, run the app on boot and restart after failures.

Keep secrets out of the service file. Put them in an environment file owned by the Pi user and readable only by that user:

```sh
sudo install -o pi -g pi -m 600 /dev/null /home/pi/live-dashboard-app/.env.production
```

Example `/home/pi/live-dashboard-app/.env.production`:

```ini
NODE_ENV=production
DASHBOARD_TIME_ZONE=Australia/Melbourne
SALES_CACHE_SECONDS=90
SCRAPE_TIMEOUT_MS=120000
CONFIRMED_EMPTY_ORDER_CHECKS=2

# Dashboard access protection. Set a long random value.
DASHBOARD_ACCESS_KEY=change-this-long-random-dashboard-key

# Optional: only allow these LAN devices, plus localhost.
# DASHBOARD_ALLOWED_IPS=192.168.1.20,192.168.1.21

# Keep CORS off unless you explicitly need cross-origin browser access.
# DASHBOARD_ENABLE_CORS=true

# Plain env credential fallback:
SCRAPER_USERNAME=your-macromatix-username
SCRAPER_PASSWORD=your-macromatix-password

# Optional encrypted credential mode. If these are set, they replace SCRAPER_USERNAME/SCRAPER_PASSWORD.
# SCRAPER_CREDENTIALS_KEY=another-long-random-secret
# SCRAPER_CREDENTIALS_ENCRYPTED=base64-json-payload
```

Encoding credentials is not security because encoded values can be decoded. If you want to avoid plain text Macromatix credentials in the env file, generate an encrypted payload with:

```sh
node -e "const crypto=require('crypto'); const key=crypto.createHash('sha256').update(process.env.SCRAPER_CREDENTIALS_KEY).digest(); const iv=crypto.randomBytes(12); const cipher=crypto.createCipheriv('aes-256-gcm', key, iv); const data=Buffer.concat([cipher.update(JSON.stringify({username:process.env.SCRAPER_USERNAME,password:process.env.SCRAPER_PASSWORD}),'utf8'), cipher.final()]); console.log(Buffer.from(JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')})).toString('base64'))"
```

Then store only `SCRAPER_CREDENTIALS_KEY` and `SCRAPER_CREDENTIALS_ENCRYPTED` in `.env`, and remove `SCRAPER_USERNAME` / `SCRAPER_PASSWORD`.

### Per-user Macromatix logins (Create account flow)

When crew accounts enter their Macromatix username and password on **Create account → Step 2**, the server verifies the login, then saves credentials under `data/mmx-users/{dashboard-username}.json`. The MMX username and password are **encrypted at rest** with AES-256-GCM (same style as `SCRAPER_CREDENTIALS_ENCRYPTED`). Only the dashboard username appears in cleartext in that file so the app knows which file to open.

Use the same secret as the scraper, or a dedicated one:

```env
# Optional — defaults to SCRAPER_CREDENTIALS_KEY when unset
MMX_USER_CREDENTIALS_KEY=long-random-secret
```

`data/mmx-users/` is gitignored. In production, set `MMX_USER_CREDENTIALS_KEY` or `SCRAPER_CREDENTIALS_KEY`; without either, the app refuses to save new per-user MMX credentials.

Example service file at `/etc/systemd/system/live-dashboard.service`:

```ini
[Unit]
Description=Live Dashboard App
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/pi/live-dashboard-app
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
EnvironmentFile=/home/pi/live-dashboard-app/.env.production
# Optional: system Chromium (recommended on Pi). Bookworm often uses `/usr/bin/chromium`; older images used `/usr/bin/chromium-browser`. Run `which chromium` or `which chromium-browser` on the Pi.
# Environment=SCRAPER_EXECUTABLE_PATH=/usr/bin/chromium

[Install]
WantedBy=multi-user.target
```

Enable it with:

```sh
sudo systemctl daemon-reload
sudo systemctl enable live-dashboard
sudo systemctl start live-dashboard
```

Useful checks:

```sh
systemctl status live-dashboard
journalctl -u live-dashboard -n 100 --no-pager
```

Keep `/api/test-scraper` disabled during normal operation. It is only available when `ENABLE_TEST_SCRAPER=true` is set.

## Audit recurrence (checklist schedule)

The footer **audit checklist** uses two independent rules: when dismissed taps reset (`dismissalPeriod`) versus how the two **Square One** placeholders rotate (`squareOnePeriod`). Both are driven by JSON on the server so the browser does not duplicate calendar logic.

### Files and environment

| Item | Default |
|------|---------|
| Recurrence config | `data/audit-recurrence.json` |
| Override path | `AUDIT_RECURRENCE_FILE=/path/to/custom.json` |
| Persisted dismissals | `data/audit-state.json` (via `AUDIT_STATE_FILE`) |

The dashboard calls **`GET /api/audit-schedule`** on load and whenever sales data refreshes. That response includes `periodKey`, `squareSlot`, `auditListItems`, and `timeZone`. Dismissals from **`GET` / `PUT /api/audits`** are keyed by the same `periodKey` as the dismissal rule (the JSON file still accepts legacy `weekKey` in `audit-state.json`; new writes include both `weekKey` and `periodKey` with the same string where applicable).

Full Outlook **RRULE** syntax, `EXDATE`, and an in-dashboard editor are **out of scope**; edit the JSON on the Pi (or deploy a new file) to change behaviour.

### Top-level JSON shape (v1)

```json
{
  "timeZone": "Australia/Melbourne",
  "dismissalPeriod": { "type": "weekly", "weekdays": [1], "intervalWeeks": 1, "anchor": "2026-05-04" },
  "squareOnePeriod": { "type": "weekly", "intervalWeeks": 1, "anchor": "2026-05-04", "slotModulo": 4 }
}
```

- **`timeZone`**: IANA name used for all calendar boundaries (typically `Australia/Melbourne`).
- **`dismissalPeriod`**: Defines **`periodKey`**. When it changes, stored dismissals no longer apply and the checklist resets for the new period.
- **`squareOnePeriod`**: Defines **`squareSlot`** (0-based index modulo `slotModulo`, default **4**), which picks the two rotating Square One labels. It does not affect dismissal persistence. For **`type: "weekly"`**, the slot follows **Monday-aligned weeks** from **`anchor`** and **`intervalWeeks`** (same as the legacy anchor math); an optional **`weekdays`** field on this rule is ignored for rotation.

### Rule types (subset)

All rules use the config **`timeZone`** for “today” and for parsing **`anchor`** dates.

1. **`weekly`**
   - **`weekdays`** (dismissal): Array of **ISO weekdays** `1` = Monday … `7` = Sunday. A new period can start on each matched weekday (see **Multiple weekdays** below). Omit or use `[1]` for the legacy Monday week key.
   - **`intervalWeeks`**: `1` = every week on those weekdays; `2` = every second week (counting from **`anchor`** in that timezone).
   - **`anchor`**: ISO date `YYYY-MM-DD` in the config timezone; used as the week interval reference.
   - **Square One `weekly`**: Uses **`anchor`** and **`intervalWeeks`** with **Monday-aligned** week counting only (legacy behaviour). **`weekdays`** is not used for the slot.

2. **`intervalDays`**
   - **`intervalDays`**: Positive integer; period index is `floor(daysSinceAnchor / intervalDays)`.
   - **`anchor`**: ISO date; period boundaries align to whole multiples of `intervalDays` since anchor midnight.

3. **`monthlyDay`**
   - **`day`**: Day of month `1`–`31` (short months clamp the occurrence, e.g. 31 → last day of month).

4. **`monthlyWeekday`**
   - **`ordinal`**: `1`–`4` for first through fourth, or `-1` for last.
   - **`weekday`**: ISO `1`–`7` (Monday–Sunday).

### `periodKey` stability

- For **`weekly`** dismissal with the usual Monday-only setup, **`periodKey`** is a plain Melbourne **`YYYY-MM-DD`** (Monday at period start), matching the legacy **`weekKey`** so existing `audit-state.json` stays valid.
- For other dismissal types, keys are prefixed (for example `intervalDays:…`, `monthlyDay:…`) so they cannot collide with plain dates.

### Multiple weekdays (`weekly`)

If **`weekdays`** lists more than one day, each occurrence starts a new period when that weekday is reached; **`periodKey`** encodes the **actual start date** of the current period in `YYYY-MM-DD` form (Melbourne), so keys stay unique per span.

### Examples

**Every Melbourne Monday (default / legacy-aligned)** — dismissal and Square One both advance weekly from the same anchor:

```json
{
  "timeZone": "Australia/Melbourne",
  "dismissalPeriod": { "type": "weekly", "weekdays": [1], "intervalWeeks": 1, "anchor": "2026-05-04" },
  "squareOnePeriod": { "type": "weekly", "intervalWeeks": 1, "anchor": "2026-05-04", "slotModulo": 4 }
}
```

**Second Monday of each month** (ordinal weekday):

```json
"dismissalPeriod": { "type": "monthlyWeekday", "ordinal": 2, "weekday": 1 }
```

**15th of each month**:

```json
"dismissalPeriod": { "type": "monthlyDay", "day": 15 }
```

**Every 14 days** (aligned to anchor):

```json
"dismissalPeriod": { "type": "intervalDays", "intervalDays": 14, "anchor": "2026-05-01" }
```

**Square One every second Monday** while dismissals stay weekly:

```json
"dismissalPeriod": { "type": "weekly", "weekdays": [1], "intervalWeeks": 1, "anchor": "2026-05-04" },
"squareOnePeriod": { "type": "weekly", "intervalWeeks": 2, "anchor": "2026-05-04", "slotModulo": 4 }
```

Invalid JSON or unknown rule fields causes **`GET /api/audit-schedule`** to return **500**; the dashboard shows a **separate** banner from sales status and uses a safe local fallback until the next successful load.

## Macromatix Excel / Build To JS

The sales dashboard does not read Excel workbooks. **Build To JS** and stock report merges run in the sibling project **[mmx-report-automation](../mmx-report-automation)** (`data/workbooks/`, `npm run excel-only`). This app’s `data/` folder holds audit JSON only — see [data/README.md](data/README.md).

## Technologies Used
- Node.js
- Express.js
- Puppeteer or Axios (for web scraping)
- HTML/CSS
- JavaScript

## Contributing
Feel free to submit issues or pull requests to improve the project. 

## License
This project is licensed under the MIT License.