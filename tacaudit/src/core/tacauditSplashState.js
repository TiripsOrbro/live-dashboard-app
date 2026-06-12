const fs = require('fs');
const path = require('path');
const { getDismissalPeriodKey } = require('../auditRecurrence');

const paths = require('../../../src/paths');
const SPLASH_STATE_FILE =
    process.env.TACAUDIT_SPLASH_STATE_FILE || path.join(paths.tacaudit.data, 'tacaudit-splash-state.json');

const VALID_STATUSES = new Set(['blank', 'opened', 'complete']);

function emptyState() {
    const periodKey = getDismissalPeriodKey();
    return { periodKey, areas: {} };
}

function readStateFile() {
    try {
        if (!fs.existsSync(SPLASH_STATE_FILE)) return emptyState();
        const parsed = JSON.parse(fs.readFileSync(SPLASH_STATE_FILE, 'utf8'));
        return {
            periodKey: String(parsed.periodKey || ''),
            areas: parsed.areas && typeof parsed.areas === 'object' ? parsed.areas : {},
        };
    } catch {
        return emptyState();
    }
}

function writeStateFile(state) {
    fs.mkdirSync(path.dirname(SPLASH_STATE_FILE), { recursive: true });
    fs.writeFileSync(SPLASH_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function getSplashState() {
    const currentKey = getDismissalPeriodKey();
    let state = readStateFile();
    if (state.periodKey !== currentKey) {
        state = emptyState();
        writeStateFile(state);
    }
    return state;
}

function areaKey(areaName) {
    return String(areaName || '').trim();
}

function storeKey(storeNumber) {
    return String(storeNumber || '').trim();
}

function getOverridesForArea(areaName) {
    const state = getSplashState();
    const area = state.areas[areaKey(areaName)] || {};
    const stores = area.stores && typeof area.stores === 'object' ? area.stores : {};
    const overrides = new Map();
    for (const [num, cells] of Object.entries(stores)) {
        if (!cells || typeof cells !== 'object') continue;
        for (const [rowId, status] of Object.entries(cells)) {
            if (!VALID_STATUSES.has(status)) continue;
            overrides.set(`${num}:${rowId}`, status);
        }
    }
    return overrides;
}

function getSplashStateForArea(areaName) {
    const state = getSplashState();
    const key = areaKey(areaName);
    const area = state.areas[key] || { stores: {} };
    return {
        periodKey: state.periodKey,
        areaName: key,
        stores: area.stores || {},
    };
}

function clearOverridesForArea(areaName) {
    const area = areaKey(areaName);
    if (!area) return { ok: false, error: 'Area is required.' };

    const state = getSplashState();
    if (!state.areas[area]) return { ok: true, cleared: false };

    delete state.areas[area];
    writeStateFile(state);
    return { ok: true, cleared: true };
}

function setCellOverride(areaName, storeNumber, rowId, status) {
    const area = areaKey(areaName);
    const store = storeKey(storeNumber);
    const row = String(rowId || '').trim();
    const next = String(status || '').trim().toLowerCase();
    if (!area || !store || !row) return { ok: false, error: 'Area, store, and row are required.' };
    if (!VALID_STATUSES.has(next)) return { ok: false, error: 'Invalid status.' };

    const state = getSplashState();
    if (!state.areas[area]) state.areas[area] = { stores: {} };
    if (!state.areas[area].stores[store]) state.areas[area].stores[store] = {};

    state.areas[area].stores[store][row] = next;

    writeStateFile(state);
    return { ok: true, status: next };
}

module.exports = {
    getSplashStateForArea,
    getOverridesForArea,
    clearOverridesForArea,
    setCellOverride,
    VALID_STATUSES,
};
