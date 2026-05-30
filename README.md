# Live Dashboard App

## Overview
The Live Dashboard App is a web application designed to pull data from a website that requires user authentication. This application runs on a Raspberry Pi and provides a live dashboard interface to display the scraped data.

## Project Structure
```
live-dashboard-app
├── src
│   ├── app.js               # Entry point of the application
│   ├── components
│   │   └── Dashboard.js     # Manages the dashboard UI
│   ├── services
│   │   └── scraper.js       # Handles web scraping logic
│   ├── utils
│   │   └── auth.js          # Manages user authentication
│   └── styles
│       └── dashboard.css     # CSS styles for the dashboard
├── public
│   └── index.html           # Main HTML file for the web application
├── package.json             # npm configuration file
├── .env                     # Environment variables for the scraper
└── README.md                # Project documentation
```

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

3. Create a `.env` file in the root directory and add your login credentials and other necessary environment variables. On startup the app loads `.env` first, then `.env.production` if it exists. Values in `.env.production` override `.env` (so empty placeholder `SCRAPER_*` lines in `.env` do not block real credentials in `.env.production`).

## Usage
1. Start the application:
   ```
   npm start
   ```

2. Open your web browser and navigate to `http://localhost:3000` to view the live dashboard.

## Raspberry Pi setup (PM2)

This is the current production setup (Pi 4, user `orbro`, sibling to `mmx-report-automation`). PM2 keeps the dashboard running, restarts it on crash, and brings it back after reboot.

### 1. System Chromium (required)

Puppeteer uses the system browser — there is no bundled Chromium on the Pi.

```sh
sudo apt update
sudo apt install -y chromium     # older Raspberry Pi OS: chromium-browser
which chromium || which chromium-browser
```

Put the resulting path in `.env.production` as `SCRAPER_EXECUTABLE_PATH` (e.g. `/usr/bin/chromium`). If you skip this, the app auto-detects common paths and otherwise exits with a clear error telling you to install Chromium.

### 2. Install dependencies

```sh
cd ~/live-dashboard-app
git pull
npm install        # Chromium download is skipped via .npmrc
```

### 3. `.env.production`

Create `~/live-dashboard-app/.env.production` (readable only by the Pi user):

```ini
NODE_ENV=production
DASHBOARD_TIME_ZONE=Australia/Melbourne
# Multi-store scrapes take minutes (~45-60s per store), so cache the whole cycle.
SALES_CACHE_SECONDS=300
# Background refresh keeps the cache warm for every store (0 disables it).
SALES_REFRESH_SECONDS=240
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

## Multiple stores

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

### 4. Start under PM2

```sh
cd ~/live-dashboard-app
pm2 start ecosystem.config.cjs   # or: npm run pm2:start
pm2 save
pm2 startup                      # run the command it prints (once) to survive reboot
```

`ecosystem.config.cjs` loads `.env` then `.env.production`, restarts on crash, and recycles the process if memory passes ~600 MB (guards against a long-running Chromium leak).

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

Then store only `SCRAPER_CREDENTIALS_KEY` and `SCRAPER_CREDENTIALS_ENCRYPTED` in `.env.production`, and remove `SCRAPER_USERNAME` / `SCRAPER_PASSWORD`.

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