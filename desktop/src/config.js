const Store = require('electron-store');

const DEFAULT_SERVER_URL = 'https://tbadashboard.com';
const LOCAL_SERVER_URL = 'http://127.0.0.1:3000';
const DEFAULT_GIT_BRANCH = '16gb';
const DEFAULT_GIT_REMOTE = 'https://github.com/TiripsOrbro/live-dashboard-app.git';

const store = new Store({
    name: 'live-dashboard-desktop',
    defaults: {
        setupComplete: false,
        mode: null, // 'host' | 'client'
        hostId: null,
        serverUrl: DEFAULT_SERVER_URL,
        serverDir: null,
        gitBranch: DEFAULT_GIT_BRANCH,
        gitRemote: DEFAULT_GIT_REMOTE,
        openAtLogin: true,
        lastHostStatus: 'stopped',
    },
});

function getConfig() {
    return {
        setupComplete: Boolean(store.get('setupComplete')),
        mode: store.get('mode'),
        hostId: store.get('hostId') || null,
        serverUrl: String(store.get('serverUrl') || DEFAULT_SERVER_URL).replace(/\/+$/, ''),
        serverDir: store.get('serverDir'),
        gitBranch: store.get('gitBranch') || DEFAULT_GIT_BRANCH,
        gitRemote: store.get('gitRemote') || DEFAULT_GIT_REMOTE,
        openAtLogin: store.get('openAtLogin') !== false,
        lastHostStatus: store.get('lastHostStatus') || 'stopped',
    };
}

function setConfig(partial) {
    for (const [key, value] of Object.entries(partial || {})) {
        store.set(key, value);
    }
    return getConfig();
}

/** In-app Admin for Hosts uses localhost so CF 502 cannot block setup. */
function appOrigin(cfg = getConfig()) {
    if (cfg.mode === 'host') return LOCAL_SERVER_URL;
    return cfg.serverUrl || DEFAULT_SERVER_URL;
}

function settingsUrl(cfg = getConfig()) {
    return `${appOrigin(cfg)}/Admin/Settings`;
}

function dashboardUrl(cfg = getConfig()) {
    return `${appOrigin(cfg)}/`;
}

/** Public site (Cloudflare) — for reachability checks / “open in browser” against the live hostname. */
function publicSettingsUrl(cfg = getConfig()) {
    return `${cfg.serverUrl || DEFAULT_SERVER_URL}/Admin/Settings`;
}

function publicDashboardUrl(cfg = getConfig()) {
    return `${cfg.serverUrl || DEFAULT_SERVER_URL}/`;
}

module.exports = {
    DEFAULT_SERVER_URL,
    LOCAL_SERVER_URL,
    DEFAULT_GIT_BRANCH,
    DEFAULT_GIT_REMOTE,
    getConfig,
    setConfig,
    appOrigin,
    settingsUrl,
    dashboardUrl,
    publicSettingsUrl,
    publicDashboardUrl,
};
