const fs = require('fs');
const path = require('path');
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const {
    getStoreUpsellingConfig,
    listStoreConfigs,
    normalizeUpsellingStoreKey,
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
    const key = normalizeUpsellingStoreKey(storeNumber);
    if (!key) {
        return global;
    }

    const storeCfg = getStoreUpsellingConfig(key);
    if (!storeCfg.points.size) {
        return global;
    }

    const byLabel = new Map(global.byLabel);
    mergeStoreOverrides(byLabel, storeCfg.points);
    return {
        byLabel,
        source: `${global.source || '.points'} + upselling-stores (${key})`,
    };
}

/**
 * Union of global points and every enabled store's overrides (for BI column detection).
 */
function loadPointsMapForParsing() {
    const global = readGlobalPointsMap();
    const byLabel = new Map(global.byLabel);
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
            ? `${global.source || '.points'} + stores (${storeKeys.join(', ')})`
            : global.source;

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
