const fs = require('fs');
const {
    parseInventorySpecialEvent,
    parseStockOnHand,
    parseStockOnOrder,
    resolveStoreReports,
    normalizeItemCode,
} = require('./reportReader');
const { allLookupKeys } = require('./itemCodes');

function lookupKeysForCatalogItem(itemCode) {
    return allLookupKeys(itemCode);
}

function findInReportMap(keys, reportMap) {
    if (!reportMap) return { hit: false, key: null };
    for (const key of keys) {
        const hit = reportMap.get(key);
        if (hit) return { hit: true, key };
    }
    return { hit: false, key: null };
}

function diagnoseMissing(row, ise) {
    const reasons = [];
    if (row.needsIse && ise && (!row.ise || !row.ise.hit)) {
        reasons.push(
            'no ISE row with usage (add alias in .item-codes, or zero usage — compare app count to build-to)'
        );
    }
    return reasons;
}

/**
 * Check catalog item codes against ISE (for usage-based build-to).
 *
 * Stock-on-hand and stock-on-order are looked up for diagnostics only — missing rows are
 * normal. Ordering uses manual counts from the app vs build-to target; scheduled orders
 * in MMX align after you place them.
 */
function verifyCatalogReportCoverage(storeNumber, catalog, reportsRoot) {
    const files = resolveStoreReports(storeNumber, reportsRoot);
    const hasAnyReport = Boolean(
        files.inventorySpecialEvent || files.stockOnHand || files.stockOnOrder
    );

    const ise = files.inventorySpecialEvent
        ? parseInventorySpecialEvent(files.inventorySpecialEvent)
        : null;
    const onHand = files.stockOnHand ? parseStockOnHand(files.stockOnHand, storeNumber) : null;
    const onOrder = files.stockOnOrder ? parseStockOnOrder(files.stockOnOrder, storeNumber) : null;

    const checked = [];
    const skipped = [];

    for (const item of catalog.items || []) {
        const code = String(item.itemCode || '').trim();
        if (!code) continue;

        if (item.buildToManual) {
            skipped.push({ itemCode: code, name: item.name, reason: 'manual' });
            continue;
        }

        if (item.buildToFixed != null || item.buildToOrderManual) {
            skipped.push({
                itemCode: code,
                name: item.name,
                reason: 'count-driven (=N / order= — use app count vs catalog build-to; reports optional)',
            });
            continue;
        }

        const keys = lookupKeysForCatalogItem(code);
        const needsIse =
            item.buildToDays != null && item.buildToFixed == null && !item.buildToOrderManual;

        const row = {
            itemCode: code,
            name: item.name,
            lookupKeys: keys,
            needsIse,
            ise: null,
            onHand: null,
            onOrder: null,
        };

        if (needsIse && ise) row.ise = findInReportMap(keys, ise);
        if (onHand) row.onHand = findInReportMap(keys, onHand);
        if (onOrder) row.onOrder = findInReportMap(keys, onOrder);
        row.diagnosis = diagnoseMissing(row, ise);

        if (!hasAnyReport) {
            row.noReports = true;
        }

        checked.push(row);
    }

    const missing = checked.filter((r) => {
        if (r.noReports) return false;
        if (r.needsIse && ise && (!r.ise || !r.ise.hit)) return true;
        return false;
    });

    return {
        vendor: catalog.label || catalog.slug,
        slug: catalog.slug,
        reportsRoot,
        files: {
            inventorySpecialEvent: files.inventorySpecialEvent,
            stockOnHand: files.stockOnHand,
            stockOnOrder: files.stockOnOrder,
        },
        hasAnyReport,
        summary: {
            checked: checked.length,
            missing: missing.length,
            skippedManual: skipped.length,
        },
        missing,
        skipped,
        checked,
    };
}

module.exports = {
    verifyCatalogReportCoverage,
    lookupKeysForCatalogItem,
};
