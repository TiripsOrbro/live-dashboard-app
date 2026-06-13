const fs = require('fs').promises;
const path = require('path');
const { buildDailyStockCountCatalog } = require('./dailyStockCountCatalog');
const { aggregateCounts } = require('./vendorCatalog');
const { isTestStore, TEST_STORE_SLUG } = require('../../stores/src/testStore');

const STATE_FILE =
    process.env.DAILY_STOCK_COUNT_STATE_FILE ||
    path.join(require('../../src/paths').vendors.data, 'daily-stock-count-state.json');
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

let stateCache = null;

function storeKey(storeNumber) {
    const raw = String(storeNumber || '').trim().toLowerCase();
    if (isTestStore(raw)) return TEST_STORE_SLUG;
    const digits = raw.replace(/[^0-9]/g, '');
    return digits || '__default__';
}

function melbourneDateKey(date = new Date()) {
    return date.toLocaleDateString('en-CA', { timeZone: TIME_ZONE });
}

function emptyState() {
    return { stores: {} };
}

async function readStateFile() {
    try {
        const raw = await fs.readFile(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.stores && typeof parsed.stores === 'object') {
            return { stores: parsed.stores };
        }
        return emptyState();
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn('[DailyStockCount] Failed to read state file:', error.message);
        }
        return emptyState();
    }
}

async function writeStateFile(state) {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function getStateAll() {
    if (!stateCache) {
        stateCache = await readStateFile();
    }
    return stateCache;
}

function getCatalog(storeNumber) {
    return buildDailyStockCountCatalog(storeNumber);
}

function normalizeCounts(counts) {
    const out = {};
    if (!counts || typeof counts !== 'object') return out;
    for (const [colKey, raw] of Object.entries(counts)) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) continue;
        out[String(colKey)] = n;
    }
    return out;
}

function normalizeLocationPayload(catalog, locationPayload, locationName) {
    const out = {};
    if (!locationPayload || typeof locationPayload !== 'object') return out;
    const allowedItems = new Set(
        catalog.items.filter((item) => item.locations.includes(locationName)).map((item) => item.key)
    );
    const itemByKey = new Map(catalog.items.map((i) => [i.key, i]));

    for (const [itemKey, counts] of Object.entries(locationPayload)) {
        if (!allowedItems.has(itemKey)) continue;
        const item = itemByKey.get(itemKey);
        if (!item) continue;
        const normalized = normalizeCounts(counts);
        const allowed = new Set(item.columns.map((c) => c.key));
        const filtered = {};
        for (const [k, v] of Object.entries(normalized)) {
            if (allowed.has(k)) filtered[k] = v;
        }
        if (Object.keys(filtered).length) out[itemKey] = filtered;
    }
    return out;
}

async function getDraft(storeNumber, dateKey = melbourneDateKey()) {
    const catalog = getCatalog(storeNumber);
    if (!catalog) return null;

    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const day = all.stores[sk]?.[dateKey] || { locations: {} };

    return {
        success: true,
        storeNumber: sk,
        dateKey,
        catalog,
        locations: day.locations || {},
        updatedAt: day.updatedAt || null,
        submittedAt: day.submittedAt || null,
        mmxSentAt: day.mmxSentAt || null,
        resolution: day.resolution || null,
        openBatchValue: day.openBatchValue || null,
    };
}

function summaryHasCounts(items) {
    if (!Array.isArray(items)) return false;
    return items.some(
        (row) =>
            row?.columns &&
            typeof row.columns === 'object' &&
            Object.values(row.columns).some((v) => Number(v) > 0)
    );
}

async function saveDraftLocation(storeNumber, locationName, itemCounts, dateKey = melbourneDateKey()) {
    const catalog = getCatalog(storeNumber);
    if (!catalog) return null;

    const loc = String(locationName || '').trim();
    if (!catalog.locations.includes(loc)) {
        throw new Error(`Unknown location: ${locationName}`);
    }

    const normalized = normalizeLocationPayload(catalog, itemCounts, loc);
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    if (!all.stores[sk]) all.stores[sk] = {};
    if (!all.stores[sk][dateKey]) all.stores[sk][dateKey] = { locations: {} };

    const day = all.stores[sk][dateKey];
    if (day.mmxSentAt) day.mmxSentAt = null;
    if (day.submittedAt) day.submittedAt = null;

    if (!day.locations) day.locations = {};
    day.locations[loc] = normalized;
    day.updatedAt = new Date().toISOString();

    stateCache = all;
    await writeStateFile(all);

    return getDraft(storeNumber, dateKey);
}

async function setStartResolution(storeNumber, { resolution, openBatchValue }, dateKey = melbourneDateKey()) {
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    if (!all.stores[sk]) all.stores[sk] = {};
    if (!all.stores[sk][dateKey]) all.stores[sk][dateKey] = { locations: {} };
    all.stores[sk][dateKey].resolution = String(resolution || 'create');
    all.stores[sk][dateKey].openBatchValue = openBatchValue != null ? String(openBatchValue) : null;
    all.stores[sk][dateKey].updatedAt = new Date().toISOString();
    stateCache = all;
    await writeStateFile(all);
    return getDraft(storeNumber, dateKey);
}

async function getSummary(storeNumber, dateKey = melbourneDateKey()) {
    const catalog = getCatalog(storeNumber);
    if (!catalog) return null;
    const draft = await getDraft(storeNumber, dateKey);
    if (!draft) return null;
    const items = aggregateCounts(catalog, draft.locations);
    return {
        ...draft,
        items,
        hasCounts: summaryHasCounts(items),
    };
}

async function submitDraft(storeNumber, dateKey = melbourneDateKey()) {
    const summary = await getSummary(storeNumber, dateKey);
    if (!summary?.hasCounts) {
        throw new Error('Enter at least one count before submitting.');
    }

    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const day = all.stores[sk]?.[dateKey];
    if (!day) throw new Error('No daily count draft to submit.');

    day.submittedAt = day.submittedAt || new Date().toISOString();
    day.updatedAt = day.submittedAt;
    stateCache = all;
    await writeStateFile(all);
    return summary;
}

async function markMmxSent(storeNumber, dateKey = melbourneDateKey()) {
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const day = all.stores[sk]?.[dateKey];
    if (!day) throw new Error('No daily count state to mark MMX sent.');
    day.mmxSentAt = new Date().toISOString();
    day.updatedAt = day.mmxSentAt;
    stateCache = all;
    await writeStateFile(all);
    return getDraft(storeNumber, dateKey);
}

async function reopenDraft(storeNumber, dateKey = melbourneDateKey()) {
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const day = all.stores[sk]?.[dateKey];
    if (!day) throw new Error('No daily count draft to reopen.');
    day.submittedAt = null;
    day.mmxSentAt = null;
    day.updatedAt = new Date().toISOString();
    stateCache = all;
    await writeStateFile(all);
    return getDraft(storeNumber, dateKey);
}

module.exports = {
    getCatalog,
    getDraft,
    saveDraftLocation,
    setStartResolution,
    getSummary,
    submitDraft,
    markMmxSent,
    reopenDraft,
    melbourneDateKey,
    storeKey,
};
