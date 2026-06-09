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
const { buildToOverridesForStore, mergeBuildToRules } = require('./buildToStoreOverrides');
const {
    findIseRowForCatalogItem,
    resolveCatalogItemForIseRow,
    findInReportMapWithNameFallback,
    lineCoversCatalogItem,
} = require('./orderItemNameMatch');

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

function catalogRuleForItem(itemCode, catalogRules, storeOverrideMap) {
    if (!catalogRules && !storeOverrideMap) return null;
    const base = catalogRules?.get(normalizeItemCode(itemCode)) || null;
    const override = storeOverrideMap?.get(normalizeItemCode(itemCode)) || null;
    return mergeBuildToRules(base, override);
}

function buildToDaysForItem(itemCode, description, catalogRules, storeOverrideMap) {
    const rule = catalogRuleForItem(itemCode, catalogRules, storeOverrideMap);
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

function buildToTarget(avgDaily, itemCode, description, catalogRules, storeOverrideMap) {
    const rule = catalogRuleForItem(itemCode, catalogRules, storeOverrideMap);
    if (rule?.buildToFixed != null && Number.isFinite(rule.buildToFixed)) {
        return rule.buildToFixed;
    }
    const days = buildToDaysForItem(itemCode, description, catalogRules, storeOverrideMap);
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

/**
 * Order qty from build-to − on-hand − on-order.
 * Default: skip when shortage < 1 carton; otherwise round to nearest whole carton.
 * Testing: raw (4 dp) via --no-order-rounding / ORDER_NO_ROUNDING.
 */
function finalizeOrderQty(value, options = {}) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (orderRoundingDisabled(options)) return round4(n);
    if (n < 1) return 0;
    return Math.round(n);
}

/** manual= par lines: any positive shortage orders at least one carton. */
function finalizeManualParOrderQty(value, options = {}) {
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
            const itemKey = String(item.itemKey || '').trim();
            const catalogItem = catalog.items.find(
                (i) =>
                    normalizeItemCode(i.itemCode) === code ||
                    (itemKey && i.key === itemKey)
            );
            if (!catalogItem) continue;
            const entry = {
                itemCode: code,
                itemKey: item.itemKey || code,
                itemName: item.itemName,
                vendorSlug: slug,
                columns: { ...item.columns },
                catalogItem,
            };
            const indexKeys = new Set([code, item.itemKey, catalogItem.key].filter(Boolean));
            for (const alias of allLookupKeys(code)) {
                if (alias) indexKeys.add(normalizeItemCode(alias));
            }
            for (const key of indexKeys) {
                const normalized = normalizeItemCode(key) || String(key).trim();
                if (normalized) manual.set(normalized, entry);
            }
        }
    }

    return manual;
}

/** Stock-count row for a catalog line (code, item key, and .item-codes aliases). */
function findManualCountEntry(counts, item) {
    if (!counts || !item) return null;
    const keys = new Set();
    const code = normalizeItemCode(item.itemCode);
    if (code) keys.add(code);
    if (item.key) keys.add(String(item.key).trim());
    for (const alias of allLookupKeys(code)) {
        if (alias) keys.add(normalizeItemCode(alias));
    }
    for (const key of keys) {
        const hit = counts.get(key);
        if (hit) return hit;
    }
    return null;
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

function allBuildToCatalogItems() {
    const items = [];
    for (const vendor of listConfiguredVendors()) {
        const catalog = getVendorCatalog(vendor.slug);
        if (!catalog) continue;
        for (const item of catalog.items || []) {
            if (item.buildToManual && !item.buildToOrderManual) continue;
            items.push(item);
        }
    }
    return items;
}

function findIseUsageForItemCode(itemCode, usage, catalogItem = null) {
    if (!usage) return null;
    if (catalogItem) {
        const hit = findIseRowForCatalogItem(catalogItem, usage);
        return hit?.ise || null;
    }
    const target = normalizeItemCode(itemCode);
    for (const key of allLookupKeys(itemCode)) {
        if (usage.has(key)) return usage.get(key);
    }
    for (const [reportItemCode, ise] of usage.entries()) {
        const canon = canonicalItemCode(reportItemCode) || normalizeItemCode(reportItemCode);
        if (canon === target) return ise;
        for (const key of allLookupKeys(reportItemCode)) {
            if (normalizeItemCode(key) === target) return ise;
        }
    }
    return null;
}

/** Lazy-load SOO (+ ISE for units) for count-driven order lines (manual=, order=). */
function ensureBuildToReportContext(storeNumber, options = {}) {
    if (options._buildToReportCtx !== undefined) return options._buildToReportCtx;
    try {
        const files = resolveStoreReports(storeNumber, options.reportsDir || REPORTS_DIR);
        if (!files.stockOnOrder) {
            options._buildToReportCtx = null;
            return null;
        }
        options._buildToReportCtx = {
            onOrderReport: parseStockOnOrder(files.stockOnOrder, storeNumber),
            onHandReport: files.stockOnHand ? parseStockOnHand(files.stockOnHand, storeNumber) : null,
            usage: files.inventorySpecialEvent
                ? parseInventorySpecialEvent(files.inventorySpecialEvent)
                : null,
        };
    } catch {
        options._buildToReportCtx = null;
    }
    return options._buildToReportCtx;
}

/** On-hand cartons from stock-on-hand report (alias-aware, same rules as ISE build-to lines). */
function onHandCartonsForCatalogItem(itemCode, catalogItem, ctx) {
    if (!ctx?.onHandReport) return null;
    const ise = findIseUsageForItemCode(itemCode, ctx.usage);
    const iseUnit = ise?.unit || '';
    let isePack = ise?.packSize || packSizeFromUnit(iseUnit);
    if (!Number.isFinite(isePack) || isePack <= 0) {
        const inner = Number(catalogItem?.innerPerCarton);
        isePack = Number.isFinite(inner) && inner > 0 ? inner : 0;
    }
    const keys = [...new Set([...allLookupKeys(itemCode), normalizeItemCode(itemCode)].filter(Boolean))];
    for (const key of keys) {
        const hit = findInReportMap(ctx.onHandReport, key);
        if (hit?.row) {
            return onHandToCartons(hit.row, iseUnit, isePack, key);
        }
    }
    return null;
}

/** On-order cartons from stock-on-order report (same rules as ISE build-to lines). */
function onOrderCartonsForCatalogItem(itemCode, catalogItem, ctx) {
    if (!ctx?.onOrderReport) return 0;
    const ise = findIseUsageForItemCode(itemCode, ctx.usage);
    const iseUnit = ise?.unit || '';
    let isePack = ise?.packSize || packSizeFromUnit(iseUnit);
    if (!Number.isFinite(isePack) || isePack <= 0) {
        const inner = Number(catalogItem?.innerPerCarton);
        isePack = Number.isFinite(inner) && inner > 0 ? inner : 0;
    }
    const keys = [...new Set([...allLookupKeys(itemCode), normalizeItemCode(itemCode)].filter(Boolean))];
    for (const key of keys) {
        const { onOrderCartons } = resolveOnOrderCartons(ctx.onOrderReport, key, iseUnit, isePack);
        if (onOrderCartons > 0) return onOrderCartons;
    }
    return resolveOnOrderCartons(ctx.onOrderReport, normalizeItemCode(itemCode), iseUnit, isePack)
        .onOrderCartons;
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
    const storeOverrideMap = buildToOverridesForStore(storeNumber);
    const manualCounts = await loadManualCountsForStore(storeNumber, dateKey);
    let manualCountItems = 0;
    const catalogItems = allBuildToCatalogItems();

    const lines = [];
    const usedIseCodes = new Set();

    const appendLineFromIse = (reportItemCode, ise, catalogItem, iseMatchSource) => {
        const resolved = catalogItem
            ? { item: catalogItem, matchSource: iseMatchSource || 'code' }
            : resolveCatalogItemForIseRow(ise, reportItemCode, catalogItems);
        const matchedCatalog = resolved?.item || null;
        const itemCode = matchedCatalog
            ? normalizeItemCode(matchedCatalog.itemCode)
            : canonicalItemCode(reportItemCode) || reportItemCode;
        const matchSource = resolved?.matchSource || iseMatchSource || 'code';
        const catalogName = matchedCatalog?.name || ise.description || '';

        let onHandHit = findInReportMap(onHandReport, reportItemCode);
        if (!onHandHit && catalogName) {
            onHandHit = findInReportMapWithNameFallback(itemCode, catalogName, onHandReport);
        }
        const onHandRow = onHandHit?.row || null;
        const isePack = ise.packSize || packSizeFromUnit(ise.unit);

        let manualEntry = manualCounts.get(normalizeItemCode(reportItemCode)) || null;
        if (!manualEntry && matchedCatalog) {
            manualEntry = manualCounts.get(normalizeItemCode(matchedCatalog.itemCode)) || null;
        }
        if (!manualEntry) {
            for (const key of allLookupKeys(reportItemCode)) {
                manualEntry = manualCounts.get(normalizeItemCode(key)) || null;
                if (manualEntry) break;
            }
        }
        const catalogRule = catalogRuleForItem(itemCode, catalogRules, storeOverrideMap);
        const onHandFromReport = onHandToCartons(onHandRow, ise.unit, isePack, reportItemCode);
        const onHandFromManual =
            manualEntry && manualEntry.catalogItem
                ? manualCountToCartons({ columns: manualEntry.columns }, manualEntry.catalogItem, isePack)
                : null;
        const useReportOnHandOnly =
            Boolean(catalogRule?.skipStockCount) || Boolean(options.preferReportOnHand);
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
                iseItemCode: normalizeItemCode(reportItemCode),
                iseMatchSource: matchSource,
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
            usedIseCodes.add(normalizeItemCode(reportItemCode));
            return;
        }

        const buildToDays = buildToDaysForItem(itemCode, description, catalogRules, storeOverrideMap);
        const buildTo = buildToTarget(ise.avgDaily, itemCode, description, catalogRules, storeOverrideMap);
        const rawOrder = buildTo - onHandCartons - onOrderCartons;
        const orderQty = finalizeOrderQty(rawOrder, options);
        const hasStoreOverride = storeOverrideMap.has(normalizeItemCode(itemCode));
        const buildToSource =
            catalogRule?.buildToFixed != null
                ? 'catalog-fixed'
                : hasStoreOverride
                  ? 'store-override'
                  : catalogRule?.buildToDays != null
                    ? 'catalog-days'
                    : 'default';

        lines.push({
            itemCode,
            iseItemCode: normalizeItemCode(reportItemCode),
            iseMatchSource: matchSource,
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
        usedIseCodes.add(normalizeItemCode(reportItemCode));
    };

    for (const [reportItemCode, ise] of usage.entries()) {
        appendLineFromIse(reportItemCode, ise, null, 'code');
    }

    for (const item of catalogItems) {
        if (item.skipStockCount) continue;
        if (item.buildToFixed != null || item.buildToOrderManual) continue;
        if (lines.some((line) => lineCoversCatalogItem(line, item))) continue;
        const hit = findIseRowForCatalogItem(item, usage, usedIseCodes);
        if (!hit) continue;
        appendLineFromIse(hit.reportItemCode, hit.ise, item, hit.matchSource);
    }

    lines.sort((a, b) => {
        if (b.orderQty !== a.orderQty) return b.orderQty - a.orderQty;
        return a.itemCode.localeCompare(b.itemCode);
    });

    const onHandFromReportCount = lines.filter((l) => l.onHandSource === 'report').length;
    const onHandFromManualCount = lines.filter((l) => l.onHandSource === 'manual-count').length;

    return {
        storeNumber: String(storeNumber),
        dateKey,
        files,
        countedItemCodes: [...countedCodes],
        manualCountItems,
        onHandFromReportCount,
        onHandFromManualCount,
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
    finalizeManualParOrderQty,
    findManualCountEntry,
    orderRoundingDisabled,
    filterAmericoldOrderLines,
    loadManualCountsForStore,
    manualCountToCartons,
    buildCatalogBuildToIndex,
    catalogRuleForItem,
    buildToDaysForItem,
    buildToTarget,
    ensureBuildToReportContext,
    onHandCartonsForCatalogItem,
    onOrderCartonsForCatalogItem,
    BUILD_TO_13_DAY_ITEM_CODES,
    DEFAULT_BUILD_TO_DAYS,
    EXTENDED_BUILD_TO_DAYS,
    SALAD_BUILD_TO_DAYS,
    isSaladItem,
    REPORTS_DIR,
};
