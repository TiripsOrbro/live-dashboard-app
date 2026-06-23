const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
const { getStoreList } = require('../../../stores/src/storeList');
const { readAutoSubmitSettings } = require('./forecastAutoSubmitLedger');
const { scheduleHour, TIME_ZONE } = require('./forecastSchedule');

const SETTINGS_FILE = path.join(paths.dashboard.data, 'forecast-store-auto-submit.json');
let migrationDone = false;

function defaultSettings() {
    return {
        stores: {},
        defaults: { enabled: false },
        scheduleHour: scheduleHour(),
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

function migrateFromLegacyGlobalIfNeeded() {
    if (migrationDone) return;
    migrationDone = true;
    if (fs.existsSync(SETTINGS_FILE)) return;

    const legacy = readAutoSubmitSettings();
    const stores = {};
    if (legacy.enabled) {
        const now = new Date().toISOString();
        for (const cfg of getStoreList()) {
            const store = String(cfg.storeNumber || '').trim();
            if (!store) continue;
            stores[store] = { enabled: true, updatedAt: now, updatedBy: legacy.updatedBy || 'migration' };
        }
    }

    writeSettingsDoc({
        ...defaultSettings(),
        stores,
        defaults: { enabled: Boolean(legacy.enabled) },
        migratedFromGlobal: true,
        updatedAt: new Date().toISOString(),
    });
}

function storeEntry(storeNumber) {
    migrateFromLegacyGlobalIfNeeded();
    const store = String(storeNumber || '').trim();
    const doc = readSettingsDoc();
    return doc.stores[store] || null;
}

function isStoreAutoSubmitEnabled(storeNumber) {
    migrateFromLegacyGlobalIfNeeded();
    const store = String(storeNumber || '').trim();
    const doc = readSettingsDoc();
    const entry = doc.stores[store];
    if (entry && typeof entry.enabled === 'boolean') return entry.enabled;
    return Boolean(doc.defaults?.enabled);
}

function writeStoreAutoSubmit(storeNumber, enabled, updatedBy = null) {
    migrateFromLegacyGlobalIfNeeded();
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

function buildStoreAutoSubmitMap(storeNumbers) {
    migrateFromLegacyGlobalIfNeeded();
    const out = {};
    for (const storeNumber of storeNumbers || []) {
        const store = String(storeNumber || '').trim();
        if (!store) continue;
        out[store] = isStoreAutoSubmitEnabled(store);
    }
    return out;
}

function buildStoreAutoSubmitStatus(storeNumbers) {
    migrateFromLegacyGlobalIfNeeded();
    const doc = readSettingsDoc();
    return {
        stores: buildStoreAutoSubmitMap(storeNumbers),
        defaults: { enabled: Boolean(doc.defaults?.enabled) },
        scheduleHour: doc.scheduleHour ?? scheduleHour(),
        timeZone: doc.timeZone || TIME_ZONE,
    };
}

module.exports = {
    SETTINGS_FILE,
    isStoreAutoSubmitEnabled,
    writeStoreAutoSubmit,
    buildStoreAutoSubmitMap,
    buildStoreAutoSubmitStatus,
    storeEntry,
};
