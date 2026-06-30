const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');

const SETTINGS_FILE = path.join(paths.dashboard.data, 'five-am-reports-config.json');
const TIME_ZONE = String(process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();

function defaultSettings() {
    return {
        stores: {},
        lastRunByStore: {},
        defaults: { enabled: false },
        timeZone: TIME_ZONE,
        updatedAt: null,
    };
}

function readSettingsDoc() {
    if (!fs.existsSync(SETTINGS_FILE)) return defaultSettings();
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const base = defaultSettings();
        return {
            ...base,
            ...raw,
            stores: raw.stores && typeof raw.stores === 'object' ? raw.stores : {},
            lastRunByStore:
                raw.lastRunByStore && typeof raw.lastRunByStore === 'object' ? raw.lastRunByStore : {},
            defaults: { ...base.defaults, ...(raw.defaults || {}) },
        };
    } catch {
        return defaultSettings();
    }
}

function writeSettingsDoc(doc) {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

function isStoreEnabled(storeNumber) {
    const store = String(storeNumber || '').trim();
    if (!store) return false;
    const doc = readSettingsDoc();
    const entry = doc.stores[store];
    if (entry && typeof entry.enabled === 'boolean') return entry.enabled;
    return Boolean(doc.defaults?.enabled);
}

function setStoreEnabled(storeNumber, enabled, updatedBy = null) {
    const store = String(storeNumber || '').trim();
    if (!store) throw new Error('storeNumber is required.');

    const doc = readSettingsDoc();
    doc.stores[store] = {
        enabled: Boolean(enabled),
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy ? String(updatedBy).trim() : null,
    };
    doc.updatedAt = doc.stores[store].updatedAt;
    writeSettingsDoc(doc);
    return doc.stores[store];
}

function listEnabledStores() {
    const doc = readSettingsDoc();
    return Object.keys(doc.stores).filter((store) => Boolean(doc.stores[store]?.enabled));
}

function getLastRun(storeNumber) {
    const store = String(storeNumber || '').trim();
    if (!store) return null;
    const doc = readSettingsDoc();
    return doc.lastRunByStore[store] || null;
}

function setLastRun(storeNumber, dateKey) {
    const store = String(storeNumber || '').trim();
    if (!store) return;
    const doc = readSettingsDoc();
    doc.lastRunByStore[store] = String(dateKey || '').trim();
    writeSettingsDoc(doc);
}

function buildStatus(storeNumbers) {
    const doc = readSettingsDoc();
    const stores = {};
    const lastRun = {};
    for (const storeNumber of storeNumbers || []) {
        const store = String(storeNumber || '').trim();
        if (!store) continue;
        stores[store] = isStoreEnabled(store);
        lastRun[store] = doc.lastRunByStore[store] || null;
    }
    return {
        stores,
        lastRun,
        defaults: { enabled: Boolean(doc.defaults?.enabled) },
        timeZone: doc.timeZone || TIME_ZONE,
    };
}

module.exports = {
    SETTINGS_FILE,
    isStoreEnabled,
    setStoreEnabled,
    listEnabledStores,
    getLastRun,
    setLastRun,
    buildStatus,
};
