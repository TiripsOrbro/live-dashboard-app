const fs = require('fs');
const path = require('path');
const { normalizeItemCode } = require('./reportReader');
const { lookupKeysForMmx, mmxCodeForOrderCode } = require('./itemCodes');
const { mergeBuildToRules } = require('./buildToStoreOverrides');

const paths = require('../../src/paths');
const OVERRIDES_PATH =
    process.env.BUILD_TO_ADMIN_OVERRIDES_PATH ||
    path.join(paths.vendors.config, 'build-to-admin-overrides.json');

let cache = null;
let cacheMtime = 0;

function emptyDoc() {
    return { global: {}, stores: {} };
}

function readOverridesDoc() {
    try {
        if (!fs.existsSync(OVERRIDES_PATH)) return emptyDoc();
        const stat = fs.statSync(OVERRIDES_PATH);
        if (cache && stat.mtimeMs === cacheMtime) return cache;
        const raw = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
        cache = {
            global: raw.global && typeof raw.global === 'object' ? raw.global : {},
            stores: raw.stores && typeof raw.stores === 'object' ? raw.stores : {},
        };
        cacheMtime = stat.mtimeMs;
        return cache;
    } catch {
        return emptyDoc();
    }
}

function writeOverridesDoc(doc) {
    const next = {
        global: doc.global && typeof doc.global === 'object' ? doc.global : {},
        stores: doc.stores && typeof doc.stores === 'object' ? doc.stores : {},
    };
    fs.mkdirSync(path.dirname(OVERRIDES_PATH), { recursive: true });
    fs.writeFileSync(OVERRIDES_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    cache = next;
    cacheMtime = fs.statSync(OVERRIDES_PATH).mtimeMs;
    return next;
}

function normalizeRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const rule = {};
    if (raw.buildToDays != null && Number.isFinite(Number(raw.buildToDays))) {
        rule.buildToDays = Number(raw.buildToDays);
    }
    if (raw.buildToAdd != null && Number.isFinite(Number(raw.buildToAdd))) {
        rule.buildToAdd = Number(raw.buildToAdd);
    }
    if (raw.buildToFixed != null && Number.isFinite(Number(raw.buildToFixed))) {
        rule.buildToFixed = Number(raw.buildToFixed);
    }
    if (raw.buildToManual === true) rule.buildToManual = true;
    if (raw.buildToOrderManual === true) rule.buildToOrderManual = true;
    if (raw.onHandOnly === true) rule.onHandOnly = true;
    if (raw.skipKeyItemCount === true) rule.skipKeyItemCount = true;
    if (raw.skipKeyItemCount === false) rule.skipKeyItemCount = false;
    if (raw.skipStockCount === true) rule.skipStockCount = true;
    if (raw.skipStockCount === false) rule.skipStockCount = false;
    if (raw.includeDaily === true) rule.includeDaily = true;
    if (raw.includeDaily === false) rule.includeDaily = false;
    return Object.keys(rule).length ? rule : null;
}

function effectiveSkipStockCount(catalogItem, storeNumber) {
    if (!catalogItem) return true;
    const code = normalizeItemCode(catalogItem.itemCode);
    if (!code) return Boolean(catalogItem.skipStockCount);
    const adminRule = adminOverridesForStore(storeNumber).get(code);
    if (adminRule && typeof adminRule.skipStockCount === 'boolean') {
        return adminRule.skipStockCount;
    }
    return Boolean(catalogItem.skipStockCount);
}

function effectiveSkipKeyItemCount(catalogItem, storeNumber) {
    if (!catalogItem) return true;
    const code = normalizeItemCode(catalogItem.itemCode);
    if (!code) return Boolean(catalogItem.skipKeyItemCount);
    const adminRule = adminOverridesForStore(storeNumber).get(code);
    if (adminRule && typeof adminRule.skipKeyItemCount === 'boolean') {
        return adminRule.skipKeyItemCount;
    }
    return Boolean(catalogItem.skipKeyItemCount);
}

function effectiveIncludeDaily(catalogItem, storeNumber) {
    if (!catalogItem) return false;
    const code = normalizeItemCode(catalogItem.itemCode);
    if (!code) return Boolean(catalogItem.includeDaily);
    const adminRule = adminOverridesForStore(storeNumber).get(code);
    if (adminRule && typeof adminRule.includeDaily === 'boolean') {
        return adminRule.includeDaily;
    }
    return Boolean(catalogItem.includeDaily);
}

function applySkipKeyItemCountOverridesToCatalog(catalog, storeNumber) {
    return applyAdminCatalogOverrides(catalog, storeNumber);
}

function applyAdminCatalogOverrides(catalog, storeNumber) {
    if (!catalog?.items?.length) return catalog;
    const store = String(storeNumber || '').trim();
    if (!store) return catalog;
    return {
        ...catalog,
        items: catalog.items.map((item) => ({
            ...item,
            skipStockCount: effectiveSkipStockCount(item, store),
            skipKeyItemCount: effectiveSkipKeyItemCount(item, store),
        })),
    };
}

function mergeItemOverridePatch(existing, itemPatch) {
    const merged = { ...(existing || {}), ...itemPatch };
    const clearKeys = [
        'skipKeyItemCount',
        'skipStockCount',
        'includeDaily',
        'buildToDays',
        'buildToAdd',
        'buildToFixed',
        'buildToManual',
        'buildToOrderManual',
        'onHandOnly',
    ];
    for (const key of clearKeys) {
        if (itemPatch?.[key] === null) delete merged[key];
    }
    return Object.keys(merged).length ? merged : null;
}

function registerOverrideKeys(map, itemCode, rule) {
    const raw = normalizeItemCode(itemCode);
    if (!raw || !rule) return;
    const mmx = mmxCodeForOrderCode(raw) || raw;
    const keys = new Set([raw, ...lookupKeysForMmx(mmx)]);
    for (const key of keys) {
        if (key) map.set(key, rule);
    }
}

function adminOverridesForStore(storeNumber) {
    const doc = readOverridesDoc();
    const storeKey = String(storeNumber || '').trim();
    const map = new Map();

    for (const [itemCode, rawRule] of Object.entries(doc.global || {})) {
        const rule = normalizeRule(rawRule);
        if (rule) registerOverrideKeys(map, itemCode, rule);
    }

    const storeRules = storeKey ? doc.stores?.[storeKey] : null;
    if (storeRules && typeof storeRules === 'object') {
        for (const [itemCode, rawRule] of Object.entries(storeRules)) {
            const rule = normalizeRule(rawRule);
            if (!rule) continue;
            const existing = [...map.keys()].find((k) => normalizeItemCode(k) === normalizeItemCode(itemCode));
            const merged = mergeBuildToRules(existing ? map.get(existing) : null, rule);
            registerOverrideKeys(map, itemCode, merged);
        }
    }

    return map;
}

function patchOverrides({ global = null, stores = null }) {
    const doc = readOverridesDoc();
    if (global && typeof global === 'object') {
        doc.global = doc.global || {};
        for (const [itemCode, itemPatch] of Object.entries(global)) {
            if (itemPatch == null) {
                delete doc.global[itemCode];
                continue;
            }
            const merged = mergeItemOverridePatch(doc.global[itemCode], itemPatch);
            if (merged) doc.global[itemCode] = merged;
            else delete doc.global[itemCode];
        }
    }
    if (stores && typeof stores === 'object') {
        doc.stores = doc.stores || {};
        for (const [storeNumber, patch] of Object.entries(stores)) {
            const sk = String(storeNumber || '').trim();
            if (!sk) continue;
            if (patch == null) {
                delete doc.stores[sk];
                continue;
            }
            doc.stores[sk] = doc.stores[sk] || {};
            for (const [itemCode, itemPatch] of Object.entries(patch)) {
                if (itemPatch == null) {
                    delete doc.stores[sk][itemCode];
                    continue;
                }
                const merged = mergeItemOverridePatch(doc.stores[sk][itemCode], itemPatch);
                if (merged) doc.stores[sk][itemCode] = merged;
                else delete doc.stores[sk][itemCode];
            }
            if (!Object.keys(doc.stores[sk]).length) delete doc.stores[sk];
        }
    }
    return writeOverridesDoc(doc);
}

module.exports = {
    OVERRIDES_PATH,
    readOverridesDoc,
    writeOverridesDoc,
    patchOverrides,
    adminOverridesForStore,
    normalizeRule,
    effectiveSkipKeyItemCount,
    effectiveSkipStockCount,
    effectiveIncludeDaily,
    applySkipKeyItemCountOverridesToCatalog,
    applyAdminCatalogOverrides,
};
