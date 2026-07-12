# Live Dashboard desktop

One Windows installer for **Client** and **Host**.

## Easy setup (non-technical)

1. Run `Taco Bell Dashboard Installer.exe`
2. Choose:
   - **I just need access** (Client) — opens Settings on tbadashboard.com
   - **This PC is the main server** (Host) — auto-installs Node/Git/cloudflared if needed, downloads the server, starts scrapers + Cloudflare
3. Approve any Windows or Cloudflare prompts if they appear
4. Sign in with a dashboard account

No manual paths or advanced options on first run.

After setup you can still switch roles from the tray:

- **Client → Become Host…** — conflict check, optional secrets pack, same bootstrap as first-run Host
- **Host → Stop hosting (become Client)…** — stops the local server, tears down Cloudflare on this PC, and releases the Host lease
- **Host → Export Host secrets pack…** — writes `Desktop\Taco Bell Dashboard Pack\secrets\` for moving Host

On Host launch, the tray auto-starts the dashboard server if it is not already healthy (e.g. after reboot). Hover the tray icon for Server / Tunnel / Lease status (Clients see Site / Host reachability). If another PC takes over hosting, you get a notification and this PC switches to Client.

## Host pack (installer + secrets)

On the current Host, use tray → **Export Host secrets pack…**, or from a server checkout:

```powershell
node scripts/export-host-secrets-pack.js
```

That creates `Desktop\Taco Bell Dashboard Pack\secrets\`. Copy `Taco Bell Dashboard Installer.exe` into the same parent folder and share the whole pack privately:

```
Taco Bell Dashboard Pack\
  Taco Bell Dashboard Installer.exe
  secrets\
```

On the new PC: install, choose **This PC is the main server** (or tray → Become Host…), then **Browse** to the `secrets` folder when asked. Taking over demotes the old Host (stops its server + Cloudflare).

## Updates

Packaged installs check GitHub Releases **before** setup or host work. If a newer `desktop-v*` release exists, the app downloads it, installs, and restarts — then continues. Offline checks fail open (setup still works). Tray → Check for updates remains available while running.

## Develop / build

```powershell
cd desktop
npm install
npm start
npm run dist
```

Output: `dist/Taco Bell Dashboard Installer.exe` (version is inside the app, not the filename)
