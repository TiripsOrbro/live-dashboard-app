const fs = require('fs');
const path = require('path');
const {
    parseInventorySpecialEvent,
    parseStockOnHand,
    parseStockOnOrder,
    resolveStoreReports,
    packSizeFromUnit,
} = require('./reportReader');
const { normalizeItemCode } = require('./reportReader');
const { allLookupKeys } = require('./itemCodes');
const { getVendorCatalog, listConfiguredVendors } = require('./vendorCatalog');
const { melbourneDateKey } = require('./stockCountState');
function calcHelpers() {
    return require('./buildToCalculator');
}
const {
    lookupSohRawQty,
    sumOnOrderByMmx,
    melbourneWeekdayUpper,
    computeWorkbookLine,
    round4,
    num,
} = require('./buildToWorkbookModel');

const WORKBOOK_PATH = path.join(__dirname, '..', '..', 'config', 'build-to-workbook.json');
const REPORTS_DIR = path.join(__dirname, '..', '..', 'Reports');

let workbookCache = null;

function loadWorkbookConfig() {
    if (workbookCache) return workbookCache;
    if (!fs.existsSync(WORKBOOK_PATH)) {
        throw new Error(`Missing ${WORKBOOK_PATH} — run scripts/export-buildto-workbook.py`);
    }
    workbookCache = JSON.parse(fs.readFileSync(WORKBOOK_PATH, 'utf8'));
    return workbookCache;
}

function findIseDaily(orderCode, mmxCode, usage) {
    if (!usage?.size) return 0;
    const codes = [...new Set([orderCode, mmxCode, ...allLookupKeys(mmxCode), ...allLookupKeys(orderCode)].filter(Boolean))];
    for (const code of codes) {
        const hit = usage.get(normalizeItemCode(code));
        if (hit?.avgDaily != null) return num(hit.avgDaily);
    }
    return 0;
}

function catalogItemForMmx(mmxCode) {
    const target = normalizeItemCode(mmxCode);
    if (!target) return null;
    for (const vendor of listConfiguredVendors()) {
        const catalog = getVendorCatalog(vendor.slug);
        if (!catalog) continue;
        for (const item of catalog.items || []) {
            if (normalizeItemCode(item.itemCode) === target) return item;
        }
    }
    return null;
}

function manualOnHandForRow(row, manualCounts, catalogItem, isePack) {
    const mmx = normalizeItemCode(row.mmxCode);
    if (!mmx || !manualCounts?.has(mmx)) return null;
    const entry = manualCounts.get(mmx);
    if (!entry?.columns || !catalogItem) return null;
    const rule = row.buildToRule || {};

    if (rule.type === 'pack10') {
        const inner = num(rule.innerPerCarton) > 0 ? num(rule.innerPerCarton) : 10;
        let packs = 0;
        for (const col of catalogItem.columns || []) {
            const val = num(entry.columns[col.key]);
            if (val <= 0) continue;
            const label = String(col.label || '').toLowerCase();
            if (label.includes('pack') || label.includes('roll')) packs += val;
            else if (label.includes('box') || label.includes('carton')) packs += val * inner;
        }
        return packs > 0 ? packs : null;
    }

    return calcHelpers().manualCountToCartons({ columns: entry.columns }, catalogItem, isePack);
}

function workbookEngineEnabled(options = {}) {
    if (options.useWorkbookEngine === false) return false;
    if (options.useWorkbookEngine === true) return true;
    const env = String(process.env.BUILD_TO_WORKBOOK || '1').trim().toLowerCase();
    return env !== '0' && env !== 'false' && env !== 'no';
}

/**
 * Calculate build-to order lines using Excel workbook rules (config/build-to-workbook.json).
 */
async function calculateWorkbookBuildToOrders(storeNumber, options = {}) {
    const config = loadWorkbookConfig();
    const reportsRoot = options.reportsDir || REPORTS_DIR;
    const dateKey = options.dateKey || melbourneDateKey();
    const files = resolveStoreReports(storeNumber, reportsRoot);

    if (!files.stockOnHand) {
        throw new Error(`Missing stock-on-hand for store ${storeNumber}`);
    }

    const usage = files.inventorySpecialEvent
        ? parseInventorySpecialEvent(files.inventorySpecialEvent)
        : new Map();
    const onHandReport = parseStockOnHand(files.stockOnHand, storeNumber);
    const onOrderReport = files.stockOnOrder
        ? parseStockOnOrder(files.stockOnOrder, storeNumber)
        : new Map();
    const manualCounts = await calcHelpers().loadManualCountsForStore(storeNumber, dateKey);
    const weekday = melbourneWeekdayUpper();
    const preferReportOnHand = Boolean(options.preferReportOnHand);

    const lines = [];

    for (const row of config.rows || []) {
        if (!row.mmxCode) continue;
        const mmx = normalizeItemCode(row.mmxCode);
        const catalogItem = catalogItemForMmx(mmx);
        if (catalogItem?.skipVendorOrder) continue;

        const dailyFromIse = findIseDaily(row.orderCode, mmx, usage);
        const daily =
            row.dailyManual != null ? num(row.dailyManual) : dailyFromIse;

        const iseUnit = usage.get(mmx)?.unit || '';
        const isePack = usage.get(mmx)?.packSize || packSizeFromUnit(iseUnit) || num(catalogItem?.innerPerCarton) || 1;

        const rawOnHand = lookupSohRawQty(onHandReport, row.sohLabel, mmx);
        const onOrderCartons = sumOnOrderByMmx(onOrderReport, mmx, iseUnit, isePack);

        let onHandOverride = null;
        const manualOh = manualOnHandForRow(row, manualCounts, catalogItem, isePack);
        if (manualOh != null && !preferReportOnHand) {
            onHandOverride = manualOh;
        } else if (manualOh != null && preferReportOnHand && (row.buildToRule?.type === 'pack10' || catalogItem?.buildToOrderManual)) {
            onHandOverride = manualOh;
        }

        const computed = computeWorkbookLine(row, {
            daily,
            rawOnHandQty: rawOnHand,
            onHandOverride,
            onOrderCartons,
            weekday,
            cutfreshCalendar: config.cutfreshCalendar,
        });

        const orderQty = calcHelpers().finalizeOrderQty(computed.orderQty, options);

        lines.push({
            itemCode: mmx,
            iseItemCode: mmx,
            description: row.name,
            sheet: row.sheet,
            unit: iseUnit,
            avgDaily: round4(computed.daily),
            buildToDays: row.buildToRule?.type === 'fixed' ? null : 10,
            buildToManual: row.buildToRule?.type === 'pack10',
            buildTo: round4(computed.buildTo),
            onHandCartons: round4(computed.onHand),
            onHandSource: onHandOverride != null ? 'manual-count' : rawOnHand > 0 ? 'report' : 'missing',
            onOrderCartons: round4(computed.onOrder),
            daysHolding: round4(computed.daysHolding),
            orderQty,
            buildToSource: 'workbook',
            workbookRule: computed.ruleType,
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
        engine: 'workbook',
        weekday,
        lines,
        orderLines: lines.filter((l) => l.orderQty > 0),
        reportFiles: {
            inventorySpecialEvent: files.inventorySpecialEvent || null,
            stockOnHand: files.stockOnHand,
            stockOnOrder: files.stockOnOrder || null,
        },
    };
}

module.exports = {
    loadWorkbookConfig,
    calculateWorkbookBuildToOrders,
    workbookEngineEnabled,
    WORKBOOK_PATH,
};
