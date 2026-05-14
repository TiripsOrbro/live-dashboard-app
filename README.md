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

3. Create a `.env` file in the root directory and add your login credentials and other necessary environment variables. On startup the app loads `.env` first, then `.env.production` if it exists. Values in `.env.production` override `.env` (so empty placeholder `SCRAPER_*` lines in `.env` do not block real credentials in `.env.production`).

## Usage
1. Start the application:
   ```
   npm start
   ```

2. Open your web browser and navigate to `http://localhost:3000` to view the live dashboard.

## Raspberry Pi unattended setup

For a Pi that should recover without manual maintenance, run the app under `systemd` so it starts on boot and restarts after failures.

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