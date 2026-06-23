#!/usr/bin/env node
/**
 * Trace build-to + vendor order mapping for one catalog item.
 *
 * Usage:
 *   npm run diagnose-build-to-item -- 3811 38088
 *   npm run diagnose-build-to-item -- 3811 38088 --no-order-rounding
 */
const path = require('path');
require('../src/loadEnv').loadEnv();

const { calculateBuildToOrders, REPORTS_DIR } = require('../src/services/buildToCalculator');
const { buildOrderLinesByVendorId } = require('../src/services/buildToOrderLines');
const {
    resolveStoreReports,
    parseInventorySpecialEventFile,
    normalizeItemCode,
} = require('../src/services/reportReader');
const { printBuildToDebug } = require('../src/services/buildToDebugFormat');
const { orderGridNameCandidates } = require('../src/services/orderItemNameMatch');
const { allLookupKeys } = require('../src/services/itemCodes');
const { melbourneDateKey } = require('../src/services/stockCountState');

function parseArgs(argv) {
    const args = argv.slice(2);
    const positional = args.filter((a) => !a.startsWith('--') && /^(\d{4}|\d{4,6}[A-Z]?)$/i.test(a));
    const storeNumber = positional[0] || '';
    const itemCode = normalizeItemCode(positional[1] || '');
    const noOrderRounding = args.includes('--no-order-rounding');
    return { storeNumber, itemCode, noOrderRounding };
}

async function main() {
    const { storeNumber, itemCode, noOrderRounding } = parseArgs(process.argv);
    if (!storeNumber || !itemCode) {
        console.error('Usage: npm run diagnose-build-to-item -- <store> <itemCode> [--no-order-rounding]');
        process.exit(1);
    }

    const orderOpts = noOrderRounding ? { noOrderRounding: true } : {};
    const files = resolveStoreReports(storeNumber, REPORTS_DIR);
    if (!files.inventorySpecialEvent) {
        console.error(
            `No ISE report in Reports/${storeNumber}/. Run: npm run download-reports -- --store ${storeNumber}`
        );
        process.exit(1);
    }

    const buildTo = await calculateBuildToOrders(storeNumber, orderOpts);
    const line = (buildTo.lines || []).find(
        (l) =>
            normalizeItemCode(l.itemCode) === itemCode ||
            normalizeItemCode(l.iseItemCode) === itemCode
    );

    console.log(`\n=== Diagnose ${itemCode} @ store ${storeNumber} (${buildTo.dateKey}) ===`);
    console.log(`Lookup keys: ${allLookupKeys(itemCode, storeNumber).join(', ')}`);
    console.log(`ISE: ${path.basename(files.inventorySpecialEvent || '')}`);
    console.log(`SOH: ${path.basename(files.stockOnHand || '(missing)')}`);
    console.log(`SOO: ${path.basename(files.stockOnOrder || '(missing)')}`);

    if (!line) {
        console.log('\nNo build-to line for this item (check ISE row / .item-codes alias).');
    } else {
        const raw =
            Number(line.buildTo || 0) - Number(line.onHandCartons || 0) - Number(line.onOrderCartons || 0);
        console.log('\nBuild-to line:');
        console.log(`  catalog ${line.itemCode}  ISE ${line.iseItemCode}  (${line.iseMatchSource || '-'})`);
        console.log(`  ${line.description || ''}`);
        console.log(`  avg ${line.avgDaily} × ${line.buildToDays}d = ${line.buildTo}  [${line.buildToSource}]`);
        console.log(
            `  on-hand ${line.onHandCartons} (${line.onHandSource})  on-order ${line.onOrderCartons}  → order ${line.orderQty} (raw ${raw})`
        );
    }

    const { byVendorId } = await buildOrderLinesByVendorId(storeNumber, {
        dateKey: buildTo.dateKey || melbourneDateKey(),
        preferReportOnHand: true,
        ...orderOpts,
    });

    console.log('\nVendor order entries:');
    let foundVendor = false;
    for (const [id, pack] of Object.entries(byVendorId)) {
        const entries = (pack.buildToEntries || []).filter(
            (e) =>
                normalizeItemCode(e.catalogItemCode) === itemCode ||
                normalizeItemCode(e.iseItemCode) === itemCode
        );
        const mmxLines = (pack.lines || []).filter(
            (l) => normalizeItemCode(l.itemCode) === itemCode
        );
        if (!entries.length && !mmxLines.length) continue;
        foundVendor = true;
        console.log(`  ${pack.vendor?.label || id}:`);
        for (const entry of entries) {
            console.log(
                `    entry qty=${entry.orderQty}  score=${entry.matchScore}  source=${entry.matchSource || '-'}  ${entry.catalogName || entry.description || ''}`
            );
            console.log(`    grid name candidates: ${orderGridNameCandidates(entry).join(' | ')}`);
        }
        for (const l of mmxLines) {
            console.log(`    → MMX line qty ${l.quantity}  ${l.itemName || l.itemCode}`);
        }
    }
    if (!foundVendor) console.log('  (not on any vendor order this run)');

    let iseItems = null;
    let iseDayLabels = [];
    if (files.inventorySpecialEvent) {
        const parsed = parseInventorySpecialEventFile(files.inventorySpecialEvent);
        iseItems = parsed.items;
        iseDayLabels = parsed.dayLabels;
    }
    printBuildToDebug({
        storeNumber,
        buildTo,
        byVendorId,
        iseFile: files.inventorySpecialEvent,
        iseItems,
        iseDayLabels,
        itemCode,
    });
}

main().catch((err) => {
    console.error('[diagnose-build-to-item]', err.message);
    process.exit(1);
});
