const fs = require('fs');
const path = require('path');
const paths = require('../../../src/paths');
const PROJECT_ROOT = paths.root;
const {
    getStoreUpsellingConfig,
    listStoreConfigs,
    normalizeUpsellingStoreKey,
    resolveEnabledStores,
} = require('./storeUpsellingConfig');

const POINTS_PATH = path.join(PROJECT_ROOT, '.points');
const POINTS_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.points.example');

function normalizeLabel(label) {
    return String(label || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function parsePointsText(text) {
    const byLabel = new Map();
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('|').map((p) => p.trim());
        if (parts.length < 2) continue;
        const label = parts[0];
        const pts = Number(parts[1]);
        if (!label || !Number.isFinite(pts)) continue;
        byLabel.set(normalizeLabel(label), { label, points: pts });
    }
    return byLabel;
}

function loadLegacyUpsellingConfig() {
    const legacyPath = path.join(paths.dashboard.config, 'upselling.json');
    if (!fs.existsSync(legacyPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    } catch (_) {
        return {};
    }
}

function loadDefaultPointsMap() {
    const cfg = loadLegacyUpsellingConfig();
    return parsePointsTextFromObject(cfg.defaultPoints || {});
}

function parsePointsTextFromObject(pointsObj) {
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

function readGlobalPointsMap() {
    const file = fs.existsSync(POINTS_PATH) ? POINTS_PATH : POINTS_EXAMPLE_PATH;
    if (!fs.existsSync(file)) {
        return { byLabel: new Map(), source: null };
    }
    return {
        byLabel: parsePointsText(fs.readFileSync(file, 'utf8')),
        source: path.basename(file),
    };
}

function mergeStoreOverrides(byLabel, overrides) {
    if (!overrides?.size) return;
    for (const [key, entry] of overrides.entries()) {
        byLabel.set(key, { ...entry });
    }
}

/**
 * Points for one store: global .points merged with config/upselling-stores.json overrides.
 */
function loadPointsMap(storeNumber = '') {
    const global = readGlobalPointsMap();
    const defaults = loadDefaultPointsMap();
    const key = normalizeUpsellingStoreKey(storeNumber);
    if (!key) {
        const byLabel = new Map(global.byLabel);
        mergeStoreOverrides(byLabel, defaults);
        return {
            byLabel,
            source: defaults.size
                ? `${global.source || '.points'} + upselling.json defaultPoints`
                : global.source,
        };
    }

    const storeCfg = getStoreUpsellingConfig(key);
    const byLabel = new Map(global.byLabel);
    mergeStoreOverrides(byLabel, defaults);
    if (storeCfg.points.size) {
        mergeStoreOverrides(byLabel, storeCfg.points);
    }

    const sourceParts = [global.source || '.points'];
    if (defaults.size) sourceParts.push('upselling.json defaultPoints');
    if (storeCfg.points.size) sourceParts.push(`upselling-stores (${key})`);

    return {
        byLabel,
        source: sourceParts.filter(Boolean).join(' + '),
    };
}

/**
 * Union of global points and every enabled store's overrides (for BI column detection).
 */
function loadPointsMapForParsing() {
    const global = readGlobalPointsMap();
    const byLabel = new Map(global.byLabel);
    mergeStoreOverrides(byLabel, loadDefaultPointsMap());
    const storeKeys = [];

    for (const entry of listStoreConfigs()) {
        if (!entry.enabled) continue;
        if (entry.points.size) {
            storeKeys.push(entry.storeKey);
            mergeStoreOverrides(byLabel, entry.points);
        }
    }

    const source =
        storeKeys.length > 0
            ? `${global.source || '.points'} + defaultPoints + stores (${storeKeys.join(', ')})`
            : `${global.source || '.points'} + defaultPoints`;

    return { byLabel, source };
}

function pointsForColumn(byLabel, columnName) {
    const key = normalizeLabel(columnName);
    const hit = byLabel.get(key);
    return hit ? hit.points : null;
}

module.exports = {
    POINTS_PATH,
    POINTS_EXAMPLE_PATH,
    normalizeLabel,
    parsePointsText,
    loadPointsMap,
    loadPointsMapForParsing,
    pointsForColumn,
};
