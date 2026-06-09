const fs = require('fs');
const path = require('path');
const { normalizeItemCode } = require('./reportReader');

const OVERRIDE_FILE =
    process.env.BUILD_TO_STORE_OVERRIDES_FILE ||
    path.join(__dirname, '..', '..', 'config', 'build-to-store-overrides.json');

let cache = null;

function loadOverridesFile() {
    if (cache) return cache;
    try {
        const raw = fs.readFileSync(OVERRIDE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        cache = parsed && typeof parsed === 'object' ? parsed : { stores: {} };
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[BuildTo] Failed to read store overrides:', error.message);
        }
        cache = { stores: {} };
    }
    return cache;
}

/** @returns {Map<string, object>} normalized item code → override rule */
function buildToOverridesForStore(storeNumber) {
    const key = String(storeNumber || '').trim();
    const items = loadOverridesFile().stores?.[key]?.items;
    const map = new Map();
    if (!items || typeof items !== 'object') return map;
    for (const [code, rule] of Object.entries(items)) {
        if (!rule || typeof rule !== 'object') continue;
        const norm = normalizeItemCode(code);
        if (!norm) continue;
        const { _note, ...patch } = rule;
        map.set(norm, patch);
    }
    return map;
}

function mergeBuildToRules(baseRule, override) {
    if (!override) return baseRule || null;
    if (!baseRule) return { ...override };
    return { ...baseRule, ...override };
}

module.exports = {
    OVERRIDE_FILE,
    buildToOverridesForStore,
    mergeBuildToRules,
};
