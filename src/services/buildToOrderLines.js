const fs = require('fs');
const path = require('path');
const { calculateBuildToOrders, loadManualCountsForStore, manualCountToCartons } = require('./buildToCalculator');
const { melbourneDateKey } = require('./stockCountState');
const { getVendorCatalog } = require('./vendorCatalog');
const { normalizeItemCode } = require('./reportReader');
const { buildBuildToEntriesForVendor } = require('./orderItemNameMatch');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'vendor-orders.json');
const EXAMPLE_PATH = path.join(PROJECT_ROOT, 'config', 'vendor-orders.json.example');

function loadVendorOrdersConfig() {
    const file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_PATH;
    if (!fs.existsSync(file)) {
        throw new Error('Missing config/vendor-orders.json — copy from config/vendor-orders.json.example');
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function itemMatchesVendorConfig(catalogItem, vendorCfg) {
    if (
        vendorCfg.catalogSlug &&
        catalogItem.catalogSlug &&
        vendorCfg.catalogSlug !== catalogItem.catalogSlug
    ) {
        return false;
    }
    if (vendorCfg.orderClasses?.length) {
        return vendorCfg.orderClasses.includes(catalogItem.mmxOrderClass);
    }
    if (vendorCfg.orderClass) {
        return catalogItem.mmxOrderClass === vendorCfg.orderClass;
    }
    return true;
}

function buildCatalogItemIndex() {
    const index = new Map();
    for (const vendorCfg of loadVendorOrdersConfig().vendors || []) {
        const slug = vendorCfg.catalogSlug;
        if (!slug) continue;
        const catalog = getVendorCatalog(slug);
        if (!catalog) continue;
        for (const item of catalog.items) {
            const code = normalizeItemCode(item.itemCode);
            if (!code) continue;
            index.set(code, {
                itemCode: code,
                name: item.name,
                mmxOrderClass: item.mmxOrderClass || 'FRZ',
                catalogSlug: slug,
            });
        }
    }
    return index;
}

function ceilOrderQty(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.ceil(n);
}

/**
 * Order qty from dashboard stock-count draft + fixed build-to (order=N catalog lines).
 */
async function buildOrderManualEntriesFromCounts(storeNumber, vendorCfg, catalog, dateKey) {
    if (!vendorCfg?.orderFromCount || !catalog) return [];
    const counts = await loadManualCountsForStore(storeNumber, dateKey || melbourneDateKey());
    const entries = [];

    for (const item of catalog.items || []) {
        if (!item.buildToOrderManual) continue;
        const code = normalizeItemCode(item.itemCode);
        if (!code) continue;

        const countEntry = counts.get(code);
        const onHandCartons = countEntry
            ? manualCountToCartons({ columns: countEntry.columns }, item, 1)
            : 0;
        const buildTo =
            item.buildToFixed != null && Number.isFinite(item.buildToFixed) ? item.buildToFixed : 0;
        const orderQty = ceilOrderQty(buildTo - onHandCartons);
        if (orderQty <= 0 && !countEntry) continue;

        entries.push({
            catalogName: item.name,
            catalogItemCode: item.itemCode,
            description: item.name,
            orderQty,
            iseItemCode: code,
            matchScore: 100,
            buildToSource: 'count-manual',
        });
    }

    return entries;
}

function mergeBuildToEntries(...entrySets) {
    const byCode = new Map();
    for (const set of entrySets) {
        for (const entry of set || []) {
            const key = normalizeItemCode(entry.catalogItemCode || entry.iseItemCode);
            if (!key) continue;
            const existing = byCode.get(key);
            // Never let low-confidence report fallbacks override manual/fixed entries.
            if (
                existing &&
                (existing.buildToSource === 'catalog-manual' ||
                    existing.buildToManual ||
                    existing.buildToSource === 'count-manual')
            ) {
                continue;
            }
            byCode.set(key, entry);
        }
    }
    return [...byCode.values()];
}

function roundOrderQtyForVendor(qty, vendorCfg, ...itemCodes) {
    const byItem = vendorCfg?.orderRoundToByItemCode || {};
    let step = vendorCfg?.orderRoundTo;
    for (const code of itemCodes) {
        const key = normalizeItemCode(code);
        if (key && byItem[key] != null) {
            step = byItem[key];
            break;
        }
    }
    step = Number(step);
    if (!Number.isFinite(step) || step <= 1 || qty <= 0) return qty;
    return Math.ceil(qty / step) * step;
}

function vendorCatalogCodeSet(catalog, vendorCfg) {
    const set = new Set();
    for (const item of catalog?.items || []) {
        if (!itemMatchesVendorConfig(item, vendorCfg)) continue;
        const code = normalizeItemCode(item.itemCode);
        if (code) set.add(code);
    }
    return set;
}

/**
 * Build-to entries per vendor — ISE lines matched to vendor catalog by item name.
 */
async function buildOrderLinesByVendorId(storeNumber, options = {}) {
    const vendorOrdersCfg = options.vendorOrdersCfg || loadVendorOrdersConfig();
    const buildTo = await calculateBuildToOrders(storeNumber, options);
    const dateKey = options.dateKey || melbourneDateKey();
    const byVendorId = {};

    for (const vendorCfg of vendorOrdersCfg.vendors || []) {
        const catalog = getVendorCatalog(vendorCfg.catalogSlug);
        const vendorCodes = vendorCatalogCodeSet(catalog, vendorCfg);
        const iseEntries = buildBuildToEntriesForVendor(
            vendorCfg,
            buildTo.lines,
            catalog?.items || [],
            itemMatchesVendorConfig
        );
        const countEntries = await buildOrderManualEntriesFromCounts(
            storeNumber,
            vendorCfg,
            catalog,
            dateKey
        );
        const allReportEntries = (buildTo.lines || [])
            .filter((line) => vendorCodes.has(normalizeItemCode(line.itemCode)))
            .filter((line) => Number(line.orderQty) > 0)
            .filter((line) => !/\bfinished product\b/i.test(String(line.description || '')))
            .map((line) => ({
                catalogName: line.description,
                catalogItemCode: line.itemCode,
                description: line.description,
                orderQty: line.orderQty,
                iseItemCode: line.itemCode,
                matchScore: 15,
                buildToSource: line.buildToSource || 'report',
            }));

        const buildToEntries = mergeBuildToEntries(iseEntries, countEntries, allReportEntries).map((entry) => ({
            ...entry,
            orderQty: roundOrderQtyForVendor(
                entry.orderQty,
                vendorCfg,
                entry.iseItemCode,
                entry.catalogItemCode
            ),
        }));
        const lines = buildToEntries
            .filter((entry) => entry.orderQty > 0)
            .map((entry) => ({
                itemCode: entry.iseItemCode,
                quantity: entry.orderQty,
                itemName: entry.catalogName || entry.description,
            }));
        byVendorId[vendorCfg.id] = { vendor: vendorCfg, buildToEntries, lines };
    }

    return { buildTo, byVendorId, vendorOrdersCfg };
}

module.exports = {
    loadVendorOrdersConfig,
    buildOrderLinesByVendorId,
    buildOrderManualEntriesFromCounts,
    buildCatalogItemIndex,
    itemMatchesVendorConfig,
    roundOrderQtyForVendor,
};
