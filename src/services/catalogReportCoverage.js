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

function diagnoseMissing(row, ise, onHand, onOrder) {
    const reasons = [];
    if (row.needsIse && ise && (!row.ise || !row.ise.hit)) {
        reasons.push('no ISE row with usage (add alias in .item-codes or zero usage this week)');
    }
    if (row.needsStock && onHand && (!row.onHand || !row.onHand.hit)) {
        reasons.push('not on stock-on-hand');
    }
    if (row.needsStock && onOrder && (!row.onOrder || !row.onOrder.hit)) {
        reasons.push('not on stock-on-order (OK if nothing scheduled)');
    }
    return reasons;
}

/**
 * Check catalog item codes against the three ISE reports (when present under Reports/<store>/).
 * Uses lookupKeysForMmx so order-form aliases still match report rows.
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

        const keys = lookupKeysForCatalogItem(code);
        const needsIse =
            item.buildToDays != null && item.buildToFixed == null && !item.buildToOrderManual;
        const needsStock =
            needsIse || item.buildToFixed != null || item.buildToOrderManual;

        const row = {
            itemCode: code,
            name: item.name,
            lookupKeys: keys,
            needsIse,
            needsStock,
            ise: null,
            onHand: null,
            onOrder: null,
        };

        if (needsIse && ise) row.ise = findInReportMap(keys, ise);
        if (needsStock && onHand) row.onHand = findInReportMap(keys, onHand);
        if (needsStock && onOrder) row.onOrder = findInReportMap(keys, onOrder);
        row.diagnosis = diagnoseMissing(row, ise, onHand, onOrder);

        if (!hasAnyReport) {
            row.noReports = true;
        }

        checked.push(row);
    }

    const missing = checked.filter((r) => {
        if (r.noReports) return false;
        if (r.needsIse && ise && (!r.ise || !r.ise.hit)) return true;
        if (r.needsStock && onHand && (!r.onHand || !r.onHand.hit)) return true;
        if (r.needsStock && onOrder && (!r.onOrder || !r.onOrder.hit)) return true;
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
