const Store = require('electron-store');

const DEFAULT_SERVER_URL = 'https://tbadashboard.com';
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

function settingsUrl(cfg = getConfig()) {
    return `${cfg.serverUrl}/Admin/Settings`;
}

function dashboardUrl(cfg = getConfig()) {
    return `${cfg.serverUrl}/`;
}

module.exports = {
    DEFAULT_SERVER_URL,
    DEFAULT_GIT_BRANCH,
    DEFAULT_GIT_REMOTE,
    getConfig,
    setConfig,
    settingsUrl,
    dashboardUrl,
};
