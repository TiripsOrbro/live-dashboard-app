const fs = require('fs');
const path = require('path');
const { normalizeStoreKey, isTestStore } = require('../testStore');

function normalizeLabel(label) {
    return String(label || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const STORES_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'upselling-stores.json');
const LEGACY_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'upselling.json');

function normalizeUpsellingStoreKey(storeNumber) {
    const raw = String(storeNumber || '').trim();
    if (isTestStore(raw)) return 'teststore';
    const key = normalizeStoreKey(raw);
    return key ? key.toLowerCase() : raw.toLowerCase();
}

let cache = null;

function loadStoreUpsellingFile() {
    if (cache) return cache;
    if (!fs.existsSync(STORES_CONFIG_PATH)) {
        cache = { stores: {} };
        return cache;
    }
    try {
        cache = JSON.parse(fs.readFileSync(STORES_CONFIG_PATH, 'utf8'));
    } catch (e) {
        console.warn('[Upselling] Invalid config/upselling-stores.json:', e.message);
        cache = { stores: {} };
    }
    if (!cache.stores || typeof cache.stores !== 'object') {
        cache.stores = {};
    }
    return cache;
}

function resetStoreUpsellingConfigCache() {
    cache = null;
}

function normalizeStoreConfigKey(storeNumber) {
    return normalizeUpsellingStoreKey(storeNumber);
}

function getRawStoreEntry(storeNumber) {
    const key = normalizeStoreConfigKey(storeNumber);
    if (!key) return null;
    const file = loadStoreUpsellingFile();
    const stores = file.stores || {};
    if (stores[key]) return stores[key];
    if (key !== 'teststore' && /^\d+$/.test(key)) {
        const padded = key.padStart(4, '0');
        if (stores[padded]) return stores[padded];
        const trimmed = String(Number(key));
        if (stores[trimmed]) return stores[trimmed];
    }
    return null;
}

function parseStorePointsOverrides(pointsObj) {
    const byLabel = new Map();
    if (!pointsObj || typeof pointsObj !== 'object') return byLabel;
    for (const [label, pts] of Object.entries(pointsObj)) {
        if (!label || label.startsWith('_')) continue;
        const value = Number(pts);
        if (!Number.isFinite(value)) continue;
        byLabel.set(normalizeLabel(label), { label: String(label).trim(), points: value });
    }
    return byLabel;
}

function loadLegacyUpsellingConfig() {
    if (!fs.existsSync(LEGACY_CONFIG_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, 'utf8'));
    } catch (_) {
        return {};
    }
}

function getStoreUpsellingConfig(storeNumber) {
    const key = normalizeStoreConfigKey(storeNumber);
    const entry = getRawStoreEntry(storeNumber);
    const legacyEnabled = resolveEnabledStoresLegacy(loadLegacyUpsellingConfig()).includes(key);

    if (!entry) {
        return {
            storeKey: key,
            enabled: legacyEnabled,
            points: new Map(),
            hasStoreFile: false,
        };
    }

    return {
        storeKey: key,
        enabled: entry.enabled !== false,
        points: parseStorePointsOverrides(entry.points),
        hasStoreFile: true,
    };
}

function resolveEnabledStoresLegacy(cfg) {
    return (cfg.enabledStores || [])
        .map((s) => normalizeStoreConfigKey(s))
        .filter(Boolean);
}

function resolveEnabledStoresFromFile() {
    const file = loadStoreUpsellingFile();
    const enabled = [];
    for (const [storeKey, entry] of Object.entries(file.stores || {})) {
        if (!storeKey || storeKey.startsWith('_')) continue;
        if (entry && entry.enabled !== false) {
            enabled.push(normalizeStoreConfigKey(storeKey));
        }
    }
    return [...new Set(enabled.filter(Boolean))];
}

function resolveEnabledStores(cfg = loadLegacyUpsellingConfig()) {
    const fromEnv = String(process.env.UPSELLING_ENABLED_STORES || '').trim();
    if (fromEnv) {
        return fromEnv
            .split(/[,;]/)
            .map((s) => s.trim())
            .filter((s) => s && !s.startsWith('#') && !s.startsWith('//'))
            .map((s) => normalizeStoreConfigKey(s))
            .filter(Boolean);
    }

    const fromFile = resolveEnabledStoresFromFile();
    if (fromFile.length) return fromFile;

    return resolveEnabledStoresLegacy(cfg);
}

function isUpsellingEnabledForStore(storeNumber) {
    const key = normalizeStoreConfigKey(storeNumber);
    if (!key) return false;
    const entry = getRawStoreEntry(storeNumber);
    if (entry) return entry.enabled !== false;
    return resolveEnabledStoresLegacy(loadLegacyUpsellingConfig()).includes(key);
}

function listStoreConfigs() {
    const file = loadStoreUpsellingFile();
    const out = [];
    for (const [storeKey, entry] of Object.entries(file.stores || {})) {
        if (!storeKey || storeKey.startsWith('_')) continue;
        out.push({
            storeKey: normalizeStoreConfigKey(storeKey),
            enabled: entry?.enabled !== false,
            points: parseStorePointsOverrides(entry?.points),
        });
    }
    return out;
}

module.exports = {
    PROJECT_ROOT,
    STORES_CONFIG_PATH,
    normalizeUpsellingStoreKey,
    loadStoreUpsellingFile,
    resetStoreUpsellingConfigCache,
    getStoreUpsellingConfig,
    resolveEnabledStores,
    isUpsellingEnabledForStore,
    parseStorePointsOverrides,
    listStoreConfigs,
};
