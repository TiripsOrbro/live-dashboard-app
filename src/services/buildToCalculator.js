const path = require('path');
const {
    parseInventorySpecialEvent,
    parseStockOnHand,
    parseStockOnOrder,
    resolveStoreReports,
    onHandToCartons,
    packSizeFromUnit,
    normalizeItemCode,
} = require('./reportReader');
const { listConfiguredVendors, getVendorCatalog, aggregateCounts } = require('./vendorCatalog');
const { getSummary, melbourneDateKey } = require('./stockCountState');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'Reports');

const DEFAULT_BUILD_TO_DAYS = 10;
const EXTENDED_BUILD_TO_DAYS = 13;

/** Beef, tortillas, flatbread, nacho chips, tostadas, fries — 13-day build-to. */
const BUILD_TO_13_DAY_ITEM_CODES = new Set(
    [
        '39520', // Beef
        '37923',
        '37925',
        '37927', // Tortillas (10.25 / 12 / 6.5 in)
        '38620', // Flatbread
        '39009', // Nacho chips
        '37891', // Tostadas
        '40109', // Fries (Chips)
    ].map(normalizeItemCode)
);

function buildToDaysForItem(itemCode) {
    return BUILD_TO_13_DAY_ITEM_CODES.has(normalizeItemCode(itemCode))
        ? EXTENDED_BUILD_TO_DAYS
        : DEFAULT_BUILD_TO_DAYS;
}

function buildToTarget(avgDaily, itemCode) {
    return num(avgDaily) * buildToDaysForItem(itemCode);
}

function parseWeightFromLabel(label) {
    const m = String(label || '').match(/\(([\d.]+)\s*(kg|gm|g)\)/i);
    if (!m) return null;
    let n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    if (/^g/i.test(m[2]) && !/^kg/i.test(m[2])) n /= 1000;
    return n;
}

function countedItemCodesByVendor() {
    const out = new Map();
    for (const vendor of listConfiguredVendors()) {
        const catalog = getVendorCatalog(vendor.slug);
        if (!catalog) continue;
        const codes = new Set(catalog.items.map((i) => normalizeItemCode(i.itemCode)).filter(Boolean));
        out.set(vendor.slug, { vendor, catalog, codes });
    }
    return out;
}

function allCountedItemCodes() {
    const set = new Set();
    for (const { codes } of countedItemCodesByVendor().values()) {
        for (const c of codes) set.add(c);
    }
    return set;
}

/** Convert aggregated stock-count row to cartons using ISE pack size. */
function manualCountToCartons(aggregatedItem, catalogItem, isePackSize) {
    const cols = aggregatedItem.columns || {};
    let cartons = num(cols.cartons);

    for (const col of catalogItem.columns || []) {
        const val = num(cols[col.key]);
        if (val <= 0) continue;
        const label = String(col.label || '').toLowerCase();
        if (label.includes('carton')) continue;
        if (label.includes('kg')) {
            cartons += isePackSize > 0 ? val / isePackSize : 0;
            continue;
        }
        const bagKg = parseWeightFromLabel(col.label);
        if (bagKg != null && isePackSize > 0) {
            cartons += (val * bagKg) / isePackSize;
            continue;
        }
        if (label.includes('bag') || label.includes('each') || label.includes('tender')) {
            cartons += isePackSize > 0 ? val / isePackSize : 0;
        }
    }

    return cartons;
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function ceilOrderQty(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.ceil(n);
}

async function loadManualCountsForStore(storeNumber, dateKey = melbourneDateKey()) {
    const manual = new Map();
    const byVendor = countedItemCodesByVendor();

    for (const [slug, { catalog }] of byVendor.entries()) {
        const summary = await getSummary(storeNumber, slug, dateKey);
        if (!summary?.items?.length) continue;
        for (const item of summary.items) {
            const code = normalizeItemCode(item.itemCode);
            if (!code) continue;
            const hasCount = Object.values(item.columns || {}).some((v) => num(v) > 0);
            if (!hasCount) continue;
            const catalogItem = catalog.items.find((i) => normalizeItemCode(i.itemCode) === code);
            if (!catalogItem) continue;
            manual.set(code, {
                itemCode: code,
                itemName: item.itemName,
                vendorSlug: slug,
                columns: { ...item.columns },
                catalogItem,
            });
        }
    }

    return manual;
}

/**
 * Build-to order lines for a store.
 * orderQty = ceil(max(0, buildTo - onHandCartons - onOrderCartons))
 * buildTo = 7-day avg daily usage × 10 days (or × 13 for beef, tortillas, flatbread, nacho chips, tostadas, fries).
 * Manual counts replace report on-hand for configured vendor catalog item codes.
 */
async function calculateBuildToOrders(storeNumber, options = {}) {
    const reportsRoot = options.reportsDir || REPORTS_DIR;
    const dateKey = options.dateKey || melbourneDateKey();
    const files = resolveStoreReports(storeNumber, reportsRoot);

    if (!files.inventorySpecialEvent || !files.stockOnHand) {
        throw new Error(
            `Missing reports for store ${storeNumber}. Need inventory-special-event and stock-on-hand in ${files.storeDir}`
        );
    }

    const usage = parseInventorySpecialEvent(files.inventorySpecialEvent);
    const onHandReport = parseStockOnHand(files.stockOnHand, storeNumber);
    const onOrderReport = files.stockOnOrder
        ? parseStockOnOrder(files.stockOnOrder, storeNumber)
        : new Map();

    const countedCodes = allCountedItemCodes();
    const manualCounts = await loadManualCountsForStore(storeNumber, dateKey);

    const lines = [];

    for (const [itemCode, ise] of usage.entries()) {
        const onOrder = onOrderReport.get(itemCode);
        const onHandRow = onHandReport.get(itemCode);
        const isePack = ise.packSize || packSizeFromUnit(ise.unit);

        let onHandCartons;
        let onHandSource;

        if (manualCounts.has(itemCode)) {
            const manual = manualCounts.get(itemCode);
            onHandCartons = manualCountToCartons(manual, manual.catalogItem, isePack);
            onHandSource = 'manual-count';
        } else {
            onHandCartons = onHandToCartons(onHandRow, ise.unit, isePack);
            onHandSource = 'report';
        }

        const onOrderCartons = onOrder ? onOrder.quantity : 0;
        const buildToDays = buildToDaysForItem(itemCode);
        const buildTo = buildToTarget(ise.avgDaily, itemCode);
        const rawOrder = buildTo - onHandCartons - onOrderCartons;
        const orderQty = ceilOrderQty(rawOrder);

        lines.push({
            itemCode,
            description: ise.description || onHandRow?.description || onOrder?.description || '',
            unit: ise.unit,
            avgDaily: round4(ise.avgDaily),
            buildToDays,
            buildTo: round4(buildTo),
            onHandCartons: round4(onHandCartons),
            onHandSource,
            onOrderCartons: round4(onOrderCartons),
            orderQty,
            manualColumns: manualCounts.get(itemCode)?.columns || null,
        });
    }

    lines.sort((a, b) => {
        if (b.orderQty !== a.orderQty) return b.orderQty - a.orderQty;
        return a.itemCode.localeCompare(b.itemCode);
    });

    return {
        storeNumber: String(storeNumber),
        dateKey,
        files,
        countedItemCodes: [...countedCodes],
        manualCountItems: manualCounts.size,
        lines,
        orderLines: lines.filter((l) => l.orderQty > 0),
    };
}

function round4(n) {
    return Math.round(Number(n) * 10000) / 10000;
}

/** Americold vendor items only (matches scheduled-order vendor label). */
function filterAmericoldOrderLines(result) {
    const americoldCodes = countedItemCodesByVendor().get('americold')?.codes || new Set();
    return {
        ...result,
        orderLines: result.orderLines.filter((l) => americoldCodes.has(l.itemCode)),
    };
}

module.exports = {
    calculateBuildToOrders,
    filterAmericoldOrderLines,
    loadManualCountsForStore,
    buildToDaysForItem,
    buildToTarget,
    BUILD_TO_13_DAY_ITEM_CODES,
    DEFAULT_BUILD_TO_DAYS,
    EXTENDED_BUILD_TO_DAYS,
    REPORTS_DIR,
};
