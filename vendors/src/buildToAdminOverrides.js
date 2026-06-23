const fs = require('fs');
const path = require('path');
const { normalizeItemCode } = require('./reportReader');
const { lookupKeysForMmx, mmxCodeForOrderCode } = require('./itemCodes');
const { mergeBuildToRules } = require('./buildToStoreOverrides');

const paths = require('../../src/paths');
const OVERRIDES_PATH =
    process.env.BUILD_TO_ADMIN_OVERRIDES_PATH ||
    path.join(paths.vendors.config, 'build-to-admin-overrides.json');

const DEFAULT_STOCK_WARNING_DAYS = 5;

let cache = null;
let cacheMtime = 0;

function emptyDoc() {
    return { settings: { stockWarningDays: DEFAULT_STOCK_WARNING_DAYS }, global: {}, areas: {}, stores: {} };
}

function readOverridesDoc() {
    try {
        if (!fs.existsSync(OVERRIDES_PATH)) return emptyDoc();
        const stat = fs.statSync(OVERRIDES_PATH);
        if (cache && stat.mtimeMs === cacheMtime) return cache;
        const raw = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
        cache = {
            settings: {
                stockWarningDays:
                    raw.settings?.stockWarningDays != null &&
                    Number.isFinite(Number(raw.settings.stockWarningDays))
                        ? Number(raw.settings.stockWarningDays)
                        : DEFAULT_STOCK_WARNING_DAYS,
            },
            global: raw.global && typeof raw.global === 'object' ? raw.global : {},
            areas: raw.areas && typeof raw.areas === 'object' ? raw.areas : {},
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
        settings: {
            stockWarningDays:
                doc.settings?.stockWarningDays != null &&
                Number.isFinite(Number(doc.settings.stockWarningDays))
                    ? Number(doc.settings.stockWarningDays)
                    : DEFAULT_STOCK_WARNING_DAYS,
        },
        global: doc.global && typeof doc.global === 'object' ? doc.global : {},
        areas: doc.areas && typeof doc.areas === 'object' ? doc.areas : {},
        stores: doc.stores && typeof doc.stores === 'object' ? doc.stores : {},
    };
    fs.mkdirSync(path.dirname(OVERRIDES_PATH), { recursive: true });
    fs.writeFileSync(OVERRIDES_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    cache = next;
    cacheMtime = fs.statSync(OVERRIDES_PATH).mtimeMs;
    return next;
}

function normalizeCodeList(raw) {
    if (raw == null) return [];
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,;\s]+/);
    const out = [];
    const seen = new Set();
    for (const part of list) {
        const code = normalizeItemCode(part);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        out.push(code);
    }
    return out;
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
    if (raw.stockWarningDays != null && Number.isFinite(Number(raw.stockWarningDays))) {
        rule.stockWarningDays = Number(raw.stockWarningDays);
    }
    if (raw.mmxCode != null && String(raw.mmxCode).trim() !== '') {
        rule.mmxCode = normalizeItemCode(raw.mmxCode);
    }
    if (raw.vendorCode != null && String(raw.vendorCode).trim() !== '') {
        rule.vendorCode = normalizeItemCode(raw.vendorCode);
    }
    if (Array.isArray(raw.fallbackCodes)) {
        rule.fallbackCodes = normalizeCodeList(raw.fallbackCodes);
    }
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
        items: (catalog.items || []).map((item) => ({
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
        'stockWarningDays',
        'mmxCode',
        'vendorCode',
        'fallbackCodes',
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

    let areaKey = '';
    if (storeKey) {
        const { areaForStoreNumber } = require('./itemCodeOverrides');
        areaKey = areaForStoreNumber(storeKey);
    }
    const areaRules = areaKey ? doc.areas?.[areaKey] : null;
    if (areaRules && typeof areaRules === 'object') {
        for (const [itemCode, rawRule] of Object.entries(areaRules)) {
            const rule = normalizeRule(rawRule);
            if (!rule) continue;
            const existing = [...map.keys()].find((k) => normalizeItemCode(k) === normalizeItemCode(itemCode));
            const merged = mergeBuildToRules(existing ? map.get(existing) : null, rule);
            registerOverrideKeys(map, itemCode, merged);
        }
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

function adminOverridesForScope(scope = {}) {
    const doc = readOverridesDoc();
    const map = new Map();
    const level = scope.level || 'global';
    const areaKey = String(scope.area || '').trim();
    const storeKey = String(scope.store || '').trim();

    const applyLayer = (layer) => {
        if (!layer || typeof layer !== 'object') return;
        for (const [itemCode, rawRule] of Object.entries(layer)) {
            const rule = normalizeRule(rawRule);
            if (!rule) continue;
            const existing = [...map.keys()].find((k) => normalizeItemCode(k) === normalizeItemCode(itemCode));
            const merged = mergeBuildToRules(existing ? map.get(existing) : null, rule);
            registerOverrideKeys(map, itemCode, merged);
        }
    };

    if (level === 'global') {
        applyLayer(doc.global);
        return map;
    }
    applyLayer(doc.global);
    if (level === 'area' || level === 'store') {
        if (areaKey) applyLayer(doc.areas?.[areaKey]);
    }
    if (level === 'store' && storeKey) {
        applyLayer(doc.stores?.[storeKey]);
    }
    return map;
}

function patchOverrides({ global = null, areas = null, stores = null, settings = null }) {
    const doc = readOverridesDoc();
    if (settings && typeof settings === 'object') {
        doc.settings = doc.settings || {};
        if (settings.stockWarningDays != null) {
            const n = Number(settings.stockWarningDays);
            if (Number.isFinite(n) && n > 0) doc.settings.stockWarningDays = n;
            else delete doc.settings.stockWarningDays;
        }
    }
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
    if (areas && typeof areas === 'object') {
        doc.areas = doc.areas || {};
        for (const [areaName, patch] of Object.entries(areas)) {
            const ak = String(areaName || '').trim();
            if (!ak) continue;
            if (patch == null) {
                delete doc.areas[ak];
                continue;
            }
            doc.areas[ak] = doc.areas[ak] || {};
            for (const [itemCode, itemPatch] of Object.entries(patch)) {
                if (itemPatch == null) {
                    delete doc.areas[ak][itemCode];
                    continue;
                }
                const merged = mergeItemOverridePatch(doc.areas[ak][itemCode], itemPatch);
                if (merged) doc.areas[ak][itemCode] = merged;
                else delete doc.areas[ak][itemCode];
            }
            if (!Object.keys(doc.areas[ak]).length) delete doc.areas[ak];
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
    DEFAULT_STOCK_WARNING_DAYS,
    readOverridesDoc,
    writeOverridesDoc,
    patchOverrides,
    adminOverridesForStore,
    adminOverridesForScope,
    normalizeRule,
    normalizeCodeList,
    effectiveSkipKeyItemCount,
    effectiveSkipStockCount,
    effectiveIncludeDaily,
    applySkipKeyItemCountOverridesToCatalog,
    applyAdminCatalogOverrides,
};
