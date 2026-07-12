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

Host Cloudflare setup now:
- Uses the production **dashboard** tunnel only
- Runs the tunnel as **your Windows user** (LocalSystem service caused public 503s on this Host)
- Installs a **Startup** entry so the tunnel returns after reboot when you log in
- Auto-starts the tunnel again whenever the Host tray app launches

## Updates

### Host server (tbadashboard.com)

On **Host** launch the tray app automatically `git fetch`es the server clone and, if origin is ahead, pulls, `npm install`s, and restarts the server. No uninstall needed for dashboard/feature updates.

- Manual: tray → **Updates → Server from Git…**
- Disable auto-pull by setting `autoUpdateFromGitOnLaunch` to `false` in `%APPDATA%\live-dashboard-desktop\live-dashboard-desktop.json`

### Tray app (this Windows shell)

The installed app under Program Files is a packaged binary — **git cannot update it in place**. You do **not** need to uninstall/reinstall when a proper release exists: **Updates → Tray app…** (or the launch-time check) downloads the new installer and upgrades in place. Releases must include `latest.yml` (see Desktop release workflow).

**Day-to-day Host development** (tray menu / desktop code): run from the git checkout instead of the installer:

```powershell
cd desktop
.\start-from-git.cmd
```

That pulls the repo, then runs Electron from source so a restart picks up the latest tray code after you push/pull.

Publishing a desktop build: bump `desktop/package.json` version, then tag `desktop-vX.Y.Z` and push the tag. The [Desktop release](../.github/workflows/desktop-release.yml) workflow builds the NSIS installer and uploads **`Taco Bell Dashboard Installer.exe`**, **`latest.yml`**, and the **`.blockmap`**.

## Develop / build

```powershell
cd desktop
npm install
npm start
npm run dist
```

Output: `dist/Taco Bell Dashboard Installer.exe` plus `latest.yml` (version is inside the app, not the filename)
