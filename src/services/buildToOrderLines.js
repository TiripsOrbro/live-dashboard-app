const fs = require('fs');
const path = require('path');
const { calculateBuildToOrders } = require('./buildToCalculator');
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

function roundOrderQtyForVendor(qty, vendorCfg, itemCode = '') {
    const byItem = vendorCfg?.orderRoundToByItemCode || {};
    const mmx = normalizeItemCode(itemCode);
    const step = Number(mmx && byItem[mmx] != null ? byItem[mmx] : vendorCfg?.orderRoundTo);
    if (!Number.isFinite(step) || step <= 1 || qty <= 0) return qty;
    return Math.ceil(qty / step) * step;
}

/**
 * Build-to entries per vendor — ISE lines matched to vendor catalog by item name.
 */
async function buildOrderLinesByVendorId(storeNumber, options = {}) {
    const vendorOrdersCfg = options.vendorOrdersCfg || loadVendorOrdersConfig();
    const buildTo = await calculateBuildToOrders(storeNumber, options);
    const byVendorId = {};

    for (const vendorCfg of vendorOrdersCfg.vendors || []) {
        const catalog = getVendorCatalog(vendorCfg.catalogSlug);
        const buildToEntries = buildBuildToEntriesForVendor(
            vendorCfg,
            buildTo.lines,
            catalog?.items || [],
            itemMatchesVendorConfig
        ).map((entry) => ({
            ...entry,
            orderQty: roundOrderQtyForVendor(entry.orderQty, vendorCfg, entry.iseItemCode),
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
    buildCatalogItemIndex,
    itemMatchesVendorConfig,
    roundOrderQtyForVendor,
};
