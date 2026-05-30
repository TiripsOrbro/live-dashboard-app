const fs = require('fs').promises;
const path = require('path');
const { aggregateCounts, getVendorCatalog, vendorLabelToSlug } = require('./vendorCatalog');

const STATE_FILE =
    process.env.STOCK_COUNT_STATE_FILE || path.join(__dirname, '../../data/stock-count-state.json');
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

let stateCache = null;

function storeKey(storeNumber) {
    return String(storeNumber || '').replace(/[^0-9]/g, '') || '__default__';
}

function vendorSlugKey(vendorSlug) {
    return String(vendorSlug || '').trim().toLowerCase();
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
            console.warn('[StockCount] Failed to read state file:', error.message);
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

async function getDraft(storeNumber, vendorSlug, dateKey = melbourneDateKey()) {
    const catalog = getVendorCatalog(vendorSlug);
    if (!catalog) return null;

    const all = await getStateAll();
    const store = all.stores[storeKey(storeNumber)] || {};
    const vendor = store[vendorSlugKey(vendorSlug)] || {};
    const day = vendor[dateKey] || { locations: {} };

    return {
        success: true,
        storeNumber: storeKey(storeNumber),
        vendorSlug: vendorSlugKey(vendorSlug),
        vendorLabel: catalog.label,
        dateKey,
        locations: day.locations || {},
        updatedAt: day.updatedAt || null,
        submittedAt: day.submittedAt || null,
    };
}

async function saveDraftLocation(storeNumber, vendorSlug, locationName, itemCounts, dateKey = melbourneDateKey()) {
    const catalog = getVendorCatalog(vendorSlug);
    if (!catalog) return null;

    const loc = String(locationName || '').trim();
    if (!catalog.locations.includes(loc)) {
        throw new Error(`Unknown location: ${locationName}`);
    }

    const normalized = normalizeLocationPayload(catalog, itemCounts, loc);
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const vk = vendorSlugKey(vendorSlug);
    if (!all.stores[sk]) all.stores[sk] = {};
    if (!all.stores[sk][vk]) all.stores[sk][vk] = {};
    if (!all.stores[sk][vk][dateKey]) all.stores[sk][vk][dateKey] = { locations: {} };

    const day = all.stores[sk][vk][dateKey];
    if (day.submittedAt) {
        throw new Error('Stock count already submitted for today.');
    }

    day.locations[loc] = normalized;
    day.updatedAt = new Date().toISOString();
    stateCache = all;
    await writeStateFile(all);

    return getDraft(storeNumber, vendorSlug, dateKey);
}

async function getSummary(storeNumber, vendorSlug, dateKey = melbourneDateKey()) {
    const catalog = getVendorCatalog(vendorSlug);
    if (!catalog) return null;

    const draft = await getDraft(storeNumber, vendorSlug, dateKey);
    const items = aggregateCounts(catalog, draft.locations);

    return {
        success: true,
        storeNumber: draft.storeNumber,
        vendorSlug: draft.vendorSlug,
        vendorLabel: catalog.label,
        dateKey,
        items,
        submittedAt: draft.submittedAt,
    };
}

async function submitStockCount(storeNumber, vendorSlug, dateKey = melbourneDateKey()) {
    const catalog = getVendorCatalog(vendorSlug);
    if (!catalog) return null;

    const summary = await getSummary(storeNumber, vendorSlug, dateKey);
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const vk = vendorSlugKey(vendorSlug);
    if (!all.stores[sk]?.[vk]?.[dateKey]) {
        throw new Error('No stock count draft to submit.');
    }

    const day = all.stores[sk][vk][dateKey];
    if (day.submittedAt) {
        return { ...summary, submittedAt: day.submittedAt, alreadySubmitted: true };
    }

    day.submittedAt = new Date().toISOString();
    day.updatedAt = day.submittedAt;
    stateCache = all;
    await writeStateFile(all);

    return {
        ...summary,
        submittedAt: day.submittedAt,
        payload: summary.items,
    };
}

async function getCompletedVendorLabelsForStore(storeNumber, dateKey = melbourneDateKey()) {
    const all = await getStateAll();
    const sk = storeKey(storeNumber);
    const store = all.stores[sk];
    if (!store) return [];

    const labels = [];
    for (const [vendorSlug, days] of Object.entries(store)) {
        const day = days?.[dateKey];
        if (!day?.submittedAt) continue;
        const catalog = getVendorCatalog(vendorSlug);
        labels.push(catalog?.label || vendorSlug);
    }
    return labels.sort((a, b) => a.localeCompare(b));
}

function isVendorConfigured(label) {
    const slug = vendorLabelToSlug(label);
    return Boolean(slug && getVendorCatalog(slug));
}

module.exports = {
    STATE_FILE,
    melbourneDateKey,
    getDraft,
    saveDraftLocation,
    getSummary,
    submitStockCount,
    getCompletedVendorLabelsForStore,
    isVendorConfigured,
    vendorLabelToSlug,
};
