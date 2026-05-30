const fs = require('fs');
const path = require('path');
const { calculateBuildToOrders } = require('./buildToCalculator');
const { getVendorCatalog } = require('./vendorCatalog');
const { normalizeItemCode } = require('./reportReader');
const log = require('./mmxReports/util-logging');

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
    if (vendorCfg.catalogSlug && vendorCfg.catalogSlug !== catalogItem.catalogSlug) return false;
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

/**
 * Build scheduled-order lines from build-to calculator output (no Excel).
 */
async function buildOrderLinesByVendorId(storeNumber, options = {}) {
    const vendorOrdersCfg = options.vendorOrdersCfg || loadVendorOrdersConfig();
    const buildTo = await calculateBuildToOrders(storeNumber, options);
    const catalogIndex = buildCatalogItemIndex();
    const byVendorId = {};

    for (const vendorCfg of vendorOrdersCfg.vendors || []) {
        const lines = [];
        for (const line of buildTo.orderLines) {
            const code = normalizeItemCode(line.itemCode);
            const catalogItem = catalogIndex.get(code);
            if (!catalogItem) continue;
            if (vendorCfg.catalogSlug && vendorCfg.catalogSlug !== catalogItem.catalogSlug) continue;
            if (!itemMatchesVendorConfig(catalogItem, vendorCfg)) continue;
            lines.push({
                itemCode: code,
                quantity: line.orderQty,
                itemName: line.description || catalogItem.name,
            });
        }
        if (lines.length) {
            byVendorId[vendorCfg.id] = { vendor: vendorCfg, lines };
        }
    }

    return { buildTo, byVendorId, vendorOrdersCfg };
}

module.exports = {
    loadVendorOrdersConfig,
    buildOrderLinesByVendorId,
    buildCatalogItemIndex,
};
