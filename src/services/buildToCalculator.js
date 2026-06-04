const path = require('path');
const {
    parseInventorySpecialEvent,
    parseStockOnHand,
    parseStockOnOrder,
    resolveStoreReports,
    onHandToCartons,
    onOrderToCartons,
    packSizeFromUnit,
    normalizeItemCode,
} = require('./reportReader');
const {
    listConfiguredVendors,
    getVendorCatalog,
    aggregateCounts,
    buildCatalogBuildToIndex,
} = require('./vendorCatalog');
const { getSummary, melbourneDateKey } = require('./stockCountState');
const {
    lookupKeysForMmx,
    mmxCodeForOrderCode,
    canonicalItemCode,
    findInReportMap,
    allLookupKeys,
} = require('./itemCodes');

const REPORTS_DIR = path.join(__dirname, '..', '..', 'Reports');

const DEFAULT_BUILD_TO_DAYS = 10;
const EXTENDED_BUILD_TO_DAYS = 13;
const SALAD_BUILD_TO_DAYS = 7;

/** Cut fresh / short shelf-life — 7-day build-to (lettuce, tomato, onion, herbs, pico). */
const SALAD_NAME_RE =
    /\blettuce\b|\btomato\b|\bonion\b|\bcorriander\b|\bcoriander\b|\bpico de gallo\b|\bsalad\b/i;

/** Beef, tortillas, flatbread, tostadas, nacho chips, fries — 13-day build-to when catalog has no day prefix. */
const BUILD_TO_13_DAY_ITEM_CODES = new Set(
    [
        '39520', // Beef
        '37923',
        '37925',
        '37927', // Tortillas (10.25 / 12 / 6.5 in)
        '37928', // Flatbread
        '37891', // Tostadas
        '39009', // Nacho chips
        '40109', // Fries (Chips)
    ].map(normalizeItemCode)
);

function isSaladItem(description) {
    return SALAD_NAME_RE.test(String(description || ''));
}

function catalogRuleForItem(itemCode, catalogRules) {
    if (!catalogRules) return null;
    return catalogRules.get(normalizeItemCode(itemCode)) || null;
}

function buildToDaysForItem(itemCode, description, catalogRules) {
    const rule = catalogRuleForItem(itemCode, catalogRules);
    if (rule?.buildToManual) return null;
    if (rule?.buildToFixed != null && Number.isFinite(rule.buildToFixed)) return null;
    if (rule?.buildToDays != null && Number.isFinite(rule.buildToDays)) {
        return rule.buildToDays;
    }
    if (isSaladItem(description)) return SALAD_BUILD_TO_DAYS;
    return BUILD_TO_13_DAY_ITEM_CODES.has(normalizeItemCode(itemCode))
        ? EXTENDED_BUILD_TO_DAYS
        : DEFAULT_BUILD_TO_DAYS;
}

function buildToTarget(avgDaily, itemCode, description, catalogRules) {
    const rule = catalogRuleForItem(itemCode, catalogRules);
    if (rule?.buildToFixed != null && Number.isFinite(rule.buildToFixed)) {
        return rule.buildToFixed;
    }
    const days = buildToDaysForItem(itemCode, description, catalogRules);
    if (days == null) return 0;
    const add = rule?.buildToAdd != null && Number.isFinite(rule.buildToAdd) ? rule.buildToAdd : 0;
    return num(avgDaily) * days + add;
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
        const codes = new Set();
        for (const item of catalog.items) {
            if (item.skipStockCount) continue;
            const code = normalizeItemCode(item.itemCode);
            if (!code) continue;
            for (const key of [code, ...lookupKeysForMmx(mmxCodeForOrderCode(code) || code)]) {
                if (key) codes.add(key);
            }
        }
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

/** Convert aggregated stock-count row to carton-equivalent (full + fractional cartons). */
function manualCountToCartons(aggregatedItem, catalogItem, isePackSize) {
    const cols = aggregatedItem.columns || {};
    let cartons = 0;
    const innerPerCarton = Number(catalogItem?.innerPerCarton);
    const hasInnerRatio = Number.isFinite(innerPerCarton) && innerPerCarton > 0;

    for (const col of catalogItem.columns || []) {
        const val = num(cols[col.key]);
        if (!Number.isFinite(val) || val < 0) continue;
        const label = String(col.label || '').toLowerCase();

        if (label.includes('carton') || label.includes('box')) {
            cartons += val;
            continue;
        }
        if (hasInnerRatio && (label.includes('pack') || label.includes('roll'))) {
            cartons += val / innerPerCarton;
            continue;
        }
        if (label.includes('tub') || label.includes('bottle') || label.includes('can')) {
            cartons += val;
            continue;
        }
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
            if (hasInnerRatio) cartons += val / innerPerCarton;
            else if (isePackSize > 0) cartons += val / isePackSize;
        }
    }

    return cartons;
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function orderRoundingDisabled(options = {}) {
    if (options.noOrderRounding) return true;
    const env = String(process.env.ORDER_NO_ROUNDING || '').trim().toLowerCase();
    return env === '1' || env === 'true' || env === 'yes';
}

/** Order qty from build-to − on-hand − on-order. Default: ceil up; testing: raw (4 dp). */
function finalizeOrderQty(value, options = {}) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (orderRoundingDisabled(options)) return round4(n);
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
            const entry = {
                itemCode: code,
                itemName: item.itemName,
                vendorSlug: slug,
                columns: { ...item.columns },
                catalogItem,
            };
            manual.set(code, entry);
            const mmxCode = mmxCodeForOrderCode(code);
            if (mmxCode && mmxCode !== code) {
                manual.set(mmxCode, { ...entry, itemCode: mmxCode });
            }
        }
    }

    return manual;
}

/**
 * Build-to order lines for a store.
 * orderQty = finalizeOrderQty(max(0, buildTo - onHandCartons - onOrderCartons))
 * On-hand comes from the Stock On Hand report (refreshed after stock count apply).
 */
function resolveOnOrderCartons(onOrderReport, itemCode, iseUnit, isePack) {
    const hit = findInReportMap(onOrderReport, itemCode);
    if (!hit) return { onOrderCartons: 0, onOrderRow: null };
    return {
        onOrderCartons: onOrderToCartons(hit.row, iseUnit, isePack, hit.key),
        onOrderRow: hit.row,
    };
}

async function calculateBuildToOrders(storeNumber, options = {}) {
    const reportsRoot = options.reportsDir || REPORTS_DIR;
    const dateKey = options.dateKey || melbourneDateKey();
    const files = resolveStoreReports(storeNumber, reportsRoot);

    if (!files.inventorySpecialEvent || !files.stockOnHand || !files.stockOnOrder) {
        const missing = [];
        if (!files.inventorySpecialEvent) missing.push('inventory-special-event');
        if (!files.stockOnHand) missing.push('stock-on-hand');
        if (!files.stockOnOrder) missing.push('stock-on-order');
        throw new Error(
            `Missing reports for store ${storeNumber}. Need ${missing.join(', ')} in ${files.storeDir}`
        );
    }

    const usage = parseInventorySpecialEvent(files.inventorySpecialEvent);
    const onHandReport = parseStockOnHand(files.stockOnHand, storeNumber);
    const onOrderReport = parseStockOnOrder(files.stockOnOrder, storeNumber);

    const countedCodes = allCountedItemCodes();
    const catalogRules = buildCatalogBuildToIndex();
    const manualCounts = await loadManualCountsForStore(storeNumber, dateKey);
    let manualCountItems = 0;

    const lines = [];

    for (const [reportItemCode, ise] of usage.entries()) {
        const itemCode = canonicalItemCode(reportItemCode) || reportItemCode;
        const onHandHit = findInReportMap(onHandReport, reportItemCode);
        const onHandRow = onHandHit?.row || null;
        const isePack = ise.packSize || packSizeFromUnit(ise.unit);

        let manualEntry = manualCounts.get(normalizeItemCode(reportItemCode)) || null;
        if (!manualEntry) {
            for (const key of allLookupKeys(reportItemCode)) {
                manualEntry = manualCounts.get(normalizeItemCode(key)) || null;
                if (manualEntry) break;
            }
        }
        const catalogRule = catalogRuleForItem(itemCode, catalogRules);
        const onHandFromReport = onHandToCartons(onHandRow, ise.unit, isePack, reportItemCode);
        const onHandFromManual =
            manualEntry && manualEntry.catalogItem
                ? manualCountToCartons({ columns: manualEntry.columns }, manualEntry.catalogItem, isePack)
                : null;
        const useReportOnHandOnly = Boolean(catalogRule?.skipStockCount);
        const onHandCartons = useReportOnHandOnly
            ? onHandFromReport
            : onHandFromManual != null
              ? onHandFromManual
              : onHandFromReport;
        const onHandSource = useReportOnHandOnly
            ? onHandRow
                ? 'report'
                : 'missing'
            : onHandFromManual != null
              ? 'manual-count'
              : onHandRow
                ? 'report'
                : 'missing';
        if (onHandFromManual != null && !useReportOnHandOnly) manualCountItems++;

        const { onOrderCartons, onOrderRow } = resolveOnOrderCartons(onOrderReport, reportItemCode, ise.unit, isePack);
        const description = ise.description || onHandRow?.description || onOrderRow?.description || '';

        if (catalogRule?.buildToManual) {
            lines.push({
                itemCode,
                description,
                unit: ise.unit,
                avgDaily: round4(ise.avgDaily),
                buildToDays: null,
                buildToManual: true,
                buildTo: null,
                onHandCartons: round4(onHandCartons),
                onHandSource,
                onOrderCartons: round4(onOrderCartons),
                orderQty: 0,
                buildToSource: 'catalog-manual',
                manualColumns: null,
            });
            continue;
        }

        const buildToDays = buildToDaysForItem(itemCode, description, catalogRules);
        const buildTo = buildToTarget(ise.avgDaily, itemCode, description, catalogRules);
        const rawOrder = buildTo - onHandCartons - onOrderCartons;
        const orderQty = finalizeOrderQty(rawOrder, options);
        const buildToSource =
            catalogRule?.buildToFixed != null
                ? 'catalog-fixed'
                : catalogRule?.buildToDays != null
                  ? 'catalog-days'
                  : 'default';

        lines.push({
            itemCode,
            description,
            unit: ise.unit,
            avgDaily: round4(ise.avgDaily),
            buildToDays,
            buildToManual: false,
            buildTo: round4(buildTo),
            onHandCartons: round4(onHandCartons),
            onHandSource,
            onOrderCartons: round4(onOrderCartons),
            orderQty,
            buildToSource,
            manualColumns: null,
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
        manualCountItems,
        lines,
        orderLines: lines.filter((l) => l.orderQty > 0),
        reportFiles: {
            inventorySpecialEvent: files.inventorySpecialEvent,
            stockOnHand: files.stockOnHand,
            stockOnOrder: files.stockOnOrder || null,
        },
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
    finalizeOrderQty,
    orderRoundingDisabled,
    filterAmericoldOrderLines,
    loadManualCountsForStore,
    manualCountToCartons,
    buildCatalogBuildToIndex,
    catalogRuleForItem,
    buildToDaysForItem,
    buildToTarget,
    BUILD_TO_13_DAY_ITEM_CODES,
    DEFAULT_BUILD_TO_DAYS,
    EXTENDED_BUILD_TO_DAYS,
    SALAD_BUILD_TO_DAYS,
    isSaladItem,
    REPORTS_DIR,
};
