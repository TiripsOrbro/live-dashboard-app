const { Tray, Menu, nativeImage, shell, app, dialog } = require('electron');
const path = require('path');
const { getConfig, settingsUrl, dashboardUrl } = require('./config');
const host = require('./host-controller');
const { checkForUpdates } = require('./updater');
const cloudflare = require('./cloudflare');

let tray = null;
let openSettings = null;
let refreshMenu = null;
let onStopHosting = null;
let onBecomeHost = null;
let onExportSecrets = null;
let getStatusSummary = null;

function iconPath() {
    return path.join(__dirname, '..', 'build', 'icon.png');
}

function buildTrayIcon() {
    const img = nativeImage.createFromPath(iconPath());
    if (img.isEmpty()) {
        return nativeImage.createEmpty();
    }
    return img.resize({ width: 16, height: 16 });
}

function setOpenSettingsHandler(fn) {
    openSettings = fn;
}

function setTrayTooltip(text) {
    if (tray && !tray.isDestroyed()) {
        tray.setToolTip(String(text || 'Live Dashboard').slice(0, 250));
    }
}

function notifyTray(title, content) {
    if (!tray || tray.isDestroyed()) return;
    try {
        tray.displayBalloon({
            title: String(title || 'Live Dashboard').slice(0, 63),
            content: String(content || '').slice(0, 255),
            iconType: 'info',
        });
    } catch {
        /* displayBalloon not always available */
    }
}

async function rebuildContextMenu() {
    const cfg = getConfig();
    const isHost = cfg.mode === 'host';
    let summary = null;
    if (typeof getStatusSummary === 'function') {
        try {
            summary = await getStatusSummary();
        } catch {
            summary = null;
        }
    }

    const statusItems = [];
    if (isHost) {
        statusItems.push(
            { type: 'separator' },
            { label: summary?.serverLabel || 'Server: unknown', enabled: false },
            { label: summary?.tunnelLabel || 'Tunnel: unknown', enabled: false },
            { label: summary?.leaseLabel || 'Lease: unknown', enabled: false }
        );
    } else if (cfg.setupComplete) {
        statusItems.push(
            { type: 'separator' },
            { label: summary?.siteLabel || 'Site: checking…', enabled: false },
            { label: summary?.leaseLabel || 'Host: checking…', enabled: false }
        );
    }

    if (summary?.tooltip) {
        setTrayTooltip(summary.tooltip);
    }

    const hostItems = isHost
        ? [
              {
                  label: 'Start server',
                  click: async () => {
                      try {
                          await host.startServer();
                          await dialog.showMessageBox({
                              type: 'info',
                              message: 'Server started',
                              detail: 'Ensure Cloudflare tunnel points at http://localhost:3000 for tbadashboard.com.',
                          });
                      } catch (err) {
                          await dialog.showErrorBox('Start failed', String(err.message || err));
                      }
                      refreshMenu && refreshMenu();
                  },
              },
              {
                  label: 'Stop server',
                  click: async () => {
                      try {
                          await host.stopServer();
                      } catch (err) {
                          await dialog.showErrorBox('Stop failed', String(err.message || err));
                      }
                      refreshMenu && refreshMenu();
                  },
              },
              {
                  label: 'Update from Git…',
                  click: async () => {
                      try {
                          const result = await host.updateFromGit();
                          await dialog.showMessageBox({
                              type: 'info',
                              message: 'Server updated',
                              detail: `Branch ${result.branch} pulled and server restarted.`,
                          });
                      } catch (err) {
                          await dialog.showErrorBox('Git update failed', String(err.message || err));
                      }
                      refreshMenu && refreshMenu();
                  },
              },
              {
                  label: 'Setup Cloudflare tunnel…',
                  click: async () => {
                      try {
                          const cf = await cloudflare.setupCloudflareTunnel({
                              hostname: (() => {
                                  try {
                                      return new URL(getConfig().serverUrl).hostname;
                                  } catch {
                                      return cloudflare.DEFAULT_HOSTNAME;
                                  }
                              })(),
                          });
                          await dialog.showMessageBox({
                              type: cf.service?.running ? 'info' : 'warning',
                              message: 'Cloudflare tunnel',
                              detail: [
                                  `${cf.hostname} → ${cf.localOrigin}`,
                                  `Tunnel: ${cf.tunnel?.name}`,
                                  cf.service?.running ? 'Service: running' : 'Service: not running (may need Admin)',
                              ].join('\n'),
                          });
                      } catch (err) {
                          await dialog.showErrorBox('Cloudflare setup failed', String(err.message || err));
                      }
                      refreshMenu && refreshMenu();
                  },
              },
              {
                  label: 'Export Host secrets pack…',
                  click: async () => {
                      if (onExportSecrets) await onExportSecrets();
                      refreshMenu && refreshMenu();
                  },
              },
              {
                  label: 'Stop hosting (become Client)…',
                  click: async () => {
                      if (onStopHosting) await onStopHosting();
                      refreshMenu && refreshMenu();
                  },
              },
              {
                  label: 'Easy Host repair / reinstall tools…',
                  click: async () => {
                      const { response } = await dialog.showMessageBox({
                          type: 'question',
                          buttons: ['Continue', 'Cancel'],
                          defaultId: 0,
                          cancelId: 1,
                          message: 'Re-run automatic Host setup?',
                          detail: 'This checks/installs Node, Git, Cloudflare Tunnel, updates the server folder, and restarts services. Approve any Windows prompts.',
                      });
                      if (response !== 0) return;
                      try {
                          const bootstrap = require('./host-bootstrap');
                          await bootstrap.runHostBootstrap({
                              onProgress: (msg) => console.log('[host-repair]', msg),
                              setupCloudflare: true,
                          });
                          await dialog.showMessageBox({
                              type: 'info',
                              message: 'Host repair finished',
                          });
                      } catch (err) {
                          await dialog.showErrorBox('Host repair failed', String(err.message || err));
                      }
                      refreshMenu && refreshMenu();
                  },
              },
          ]
        : cfg.setupComplete
          ? [
                {
                    label: 'Become Host…',
                    click: async () => {
                        if (onBecomeHost) await onBecomeHost();
                        refreshMenu && refreshMenu();
                    },
                },
            ]
          : [];

    const menu = Menu.buildFromTemplate([
        {
            label: 'Open Settings',
            click: () => openSettings && openSettings(),
        },
        {
            label: 'Open Dashboard',
            click: () => shell.openExternal(dashboardUrl()),
        },
        {
            label: 'Open Settings in browser',
            click: () => shell.openExternal(settingsUrl()),
        },
        ...statusItems,
        ...hostItems,
        { type: 'separator' },
        {
            label: 'Check for app updates…',
            click: () => checkForUpdates({ silent: false }).catch(() => {}),
        },
        {
            label: 'Quit Live Dashboard',
            click: () => app.quit(),
        },
    ]);
    if (tray && !tray.isDestroyed()) {
        tray.setContextMenu(menu);
    }
}

function createTray(handlers = {}) {
    openSettings = handlers.openSettings || openSettings;
    onStopHosting = handlers.onStopHosting || onStopHosting;
    onBecomeHost = handlers.onBecomeHost || onBecomeHost;
    onExportSecrets = handlers.onExportSecrets || onExportSecrets;
    getStatusSummary = handlers.getStatusSummary || getStatusSummary;
    tray = new Tray(buildTrayIcon());
    tray.setToolTip('Live Dashboard');
    tray.on('click', () => openSettings && openSettings());
    tray.on('double-click', () => openSettings && openSettings());
    refreshMenu = () => rebuildContextMenu().catch(() => {});
    refreshMenu();
    // Status refresh is driven from main (startStatusPolling); keep a light menu rebuild fallback.
    setInterval(() => refreshMenu(), 60000);
    return tray;
}

module.exports = {
    createTray,
    setOpenSettingsHandler,
    rebuildContextMenu,
    notifyTray,
    setTrayTooltip,
};
