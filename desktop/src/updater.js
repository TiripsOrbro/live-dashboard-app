const { autoUpdater } = require('electron-updater');
const { app, dialog, BrowserWindow } = require('electron');
const path = require('path');

let configured = false;
/** When true, downloaded updates install immediately (no Later prompt). */
let launchGateActive = false;
let splashWindow = null;
let quitAndInstallStarted = false;

function requestQuitAndInstall() {
    if (quitAndInstallStarted) return;
    quitAndInstallStarted = true;
    autoUpdater.quitAndInstall(false, true);
}

function parseVersionParts(version) {
    return String(version || '')
        .trim()
        .replace(/^v/i, '')
        .split(/[.+-]/)
        .map((part) => {
            const n = parseInt(part, 10);
            return Number.isFinite(n) ? n : 0;
        });
}

function isNewerVersion(remoteVersion, localVersion) {
    const remote = parseVersionParts(remoteVersion);
    const local = parseVersionParts(localVersion);
    const len = Math.max(remote.length, local.length);
    for (let i = 0; i < len; i += 1) {
        const a = remote[i] || 0;
        const b = local[i] || 0;
        if (a > b) return true;
        if (a < b) return false;
    }
    return false;
}

function createSplashWindow() {
    if (splashWindow && !splashWindow.isDestroyed()) return splashWindow;
    splashWindow = new BrowserWindow({
        width: 400,
        height: 200,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        frame: true,
        title: 'Taco Bell Dashboard',
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    splashWindow.removeMenu();
    splashWindow.loadFile(path.join(__dirname, 'update-splash.html'));
    splashWindow.once('ready-to-show', () => {
        if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
    });
    splashWindow.on('closed', () => {
        splashWindow = null;
    });
    return splashWindow;
}

function setSplashStatus(text, percent) {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    const pctArg =
        typeof percent === 'number' && Number.isFinite(percent) ? String(percent) : 'undefined';
    splashWindow.webContents
        .executeJavaScript(
            `window.setUpdateStatus(${JSON.stringify(String(text || ''))}, ${pctArg})`
        )
        .catch(() => {});
}

function closeSplashWindow() {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
    }
    splashWindow = null;
}

function configureUpdater() {
    if (configured) return;
    configured = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('error', (err) => {
        console.warn('[desktop-updater]', err && err.message ? err.message : err);
    });

    autoUpdater.on('update-available', (info) => {
        console.log('[desktop-updater] update available', info && info.version);
        if (launchGateActive) {
            setSplashStatus(`Downloading version ${info.version}…`, 0);
        }
    });

    autoUpdater.on('download-progress', (progress) => {
        if (!launchGateActive) return;
        const pct = Number(progress && progress.percent);
        setSplashStatus('Downloading update…', Number.isFinite(pct) ? pct : undefined);
    });

    autoUpdater.on('update-downloaded', async (info) => {
        if (launchGateActive) {
            setSplashStatus(`Installing version ${info.version}…`, 100);
            setTimeout(() => requestQuitAndInstall(), 400);
            return;
        }

        const win = BrowserWindow.getFocusedWindow();
        const { response } = await dialog.showMessageBox(win || undefined, {
            type: 'info',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            cancelId: 1,
            title: 'Update ready',
            message: `Taco Bell Dashboard ${info.version} has been downloaded.`,
            detail: 'Restart to apply the tray app update. Host server updates use Update from Git separately.',
        });
        if (response === 0) {
            requestQuitAndInstall();
        }
    });
}

/**
 * Before setup / tray work: if a newer GitHub Release exists, download and install it,
 * then restart. Offline / no release / unpackaged → continue normally.
 * @returns {Promise<{ proceeded: boolean, skipped?: string, error?: Error }>}
 */
async function ensureUpToDateBeforeLaunch() {
    configureUpdater();

    if (!app.isPackaged) {
        return { proceeded: true, skipped: 'dev' };
    }

    launchGateActive = true;
    createSplashWindow();
    // Let the splash paint before the network call.
    await new Promise((r) => setTimeout(r, 200));
    setSplashStatus('Checking for updates…');

    try {
        const result = await autoUpdater.checkForUpdates();
        const remote = result && result.updateInfo && result.updateInfo.version;
        const local = app.getVersion();

        if (!remote || !isNewerVersion(remote, local)) {
            closeSplashWindow();
            launchGateActive = false;
            return { proceeded: true };
        }

        setSplashStatus(`Update ${remote} found — downloading…`, 0);

        if (result.downloadPromise) {
            await result.downloadPromise;
        } else {
            await new Promise((resolve, reject) => {
                let settled = false;
                const finish = (fn, arg) => {
                    if (settled) return;
                    settled = true;
                    autoUpdater.removeListener('update-downloaded', onDownloaded);
                    autoUpdater.removeListener('error', onError);
                    fn(arg);
                };
                const onDownloaded = () => finish(resolve);
                const onError = (err) => finish(reject, err);
                autoUpdater.once('update-downloaded', onDownloaded);
                autoUpdater.once('error', onError);
            });
        }

        // Event handler also installs; call explicitly so we never hang if the event already fired.
        setSplashStatus(`Installing version ${remote}…`, 100);
        requestQuitAndInstall();
        return await new Promise(() => {});
    } catch (err) {
        console.warn(
            '[desktop-updater] launch check skipped:',
            err && err.message ? err.message : err
        );
        closeSplashWindow();
        launchGateActive = false;
        return { proceeded: true, error: err };
    }
}

async function checkForUpdates({ silent = false } = {}) {
    configureUpdater();
    try {
        const result = await autoUpdater.checkForUpdates();
        const remote = result && result.updateInfo && result.updateInfo.version;
        if (!silent && (!remote || !isNewerVersion(remote, app.getVersion()))) {
            await dialog.showMessageBox({
                type: 'info',
                title: 'Up to date',
                message: `Taco Bell Dashboard ${app.getVersion()} is up to date.`,
            });
        }
        return result;
    } catch (err) {
        if (!silent) {
            await dialog.showMessageBox({
                type: 'warning',
                title: 'Update check failed',
                message: String(err && err.message ? err.message : err),
                detail: 'Updates come from GitHub Releases (desktop-v* tags). Check your network and try again.',
            });
        }
        throw err;
    }
}

module.exports = {
    configureUpdater,
    checkForUpdates,
    ensureUpToDateBeforeLaunch,
};
