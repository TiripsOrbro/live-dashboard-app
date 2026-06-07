#!/usr/bin/env node
/**
 * Calculate 10-day build-to order quantities from downloaded MMX reports.
 *
 * Usage:
 *   npm run build-to-order -- 3811
 *   npm run build-to-order -- 3811 --vendor americold
 *   npm run build-to-order -- 3811 --json
 *   npm run build-to-order -- 3811 --no-order-rounding
 *   npm run build-to-order -- 3811 --debug --item 37923
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

const { calculateBuildToOrders, filterAmericoldOrderLines, REPORTS_DIR } = require('../src/services/buildToCalculator');
const { buildOrderLinesByVendorId } = require('../src/services/buildToOrderLines');
const { resolveStoreReports, parseInventorySpecialEventFile, normalizeItemCode } = require('../src/services/reportReader');
const { printBuildToDebug } = require('../src/services/buildToDebugFormat');
const { melbourneDateKey } = require('../src/services/stockCountState');

function parseArgs(argv) {
    const args = argv.slice(2);
    const storeNumber = args.find((a) => /^\d{4}$/.test(a)) || '3811';
    const vendor = args.includes('--vendor') ? args[args.indexOf('--vendor') + 1] : null;
    const json = args.includes('--json');
    const all = args.includes('--all');
    const noOrderRounding = args.includes('--no-order-rounding');
    const debug = args.includes('--debug');
    const itemIdx = args.indexOf('--item');
    const itemCode = itemIdx >= 0 ? normalizeItemCode(args[itemIdx + 1]) : '';
    return { storeNumber, vendor, json, all, noOrderRounding, debug, itemCode };
}

function printHuman(result, title) {
    console.log(`\n=== ${title} — store ${result.storeNumber} (${result.dateKey}) ===`);
    console.log(`Reports: ${path.basename(result.files.inventorySpecialEvent || '')}`);
    console.log(`Manual count overrides: ${result.manualCountItems} item(s) with drafts today`);
    console.log(`Order lines with qty > 0: ${result.orderLines.length}\n`);

    const manualCount = result.lines.filter((l) => l.buildToManual).length;
    if (manualCount) {
        console.log(`Catalog manual (excluded from auto order): ${manualCount} item(s)`);
    }

    const cols = [
        'itemCode',
        'description',
        'days',
        'buildTo',
        'onHand',
        'onOrder',
        'orderQty',
        'buildToSource',
        'onHandSource',
    ];
    console.log(cols.join('\t'));
    const showLines = result.orderLines.length ? result.orderLines : result.lines.slice(0, 30);
    for (const line of showLines) {
        console.log(
            [
                line.itemCode,
                String(line.description || '').slice(0, 36),
                line.buildToDays ?? 'manual',
                line.buildTo ?? '',
                line.onHandCartons,
                line.onOrderCartons,
                line.orderQty,
                line.buildToSource || '',
                line.onHandSource,
            ].join('\t')
        );
    }
}

async function main() {
    const { storeNumber, vendor, json, all, noOrderRounding, debug, itemCode } = parseArgs(process.argv);
    const orderOpts = noOrderRounding ? { noOrderRounding: true } : {};
    if (noOrderRounding) {
        console.log('[build-to-order] Order rounding OFF — raw shortage quantities');
    }
    let result = await calculateBuildToOrders(storeNumber, orderOpts);

    if (vendor === 'americold') {
        result = { ...result, orderLines: filterAmericoldOrderLines(result).orderLines };
    }

    if (debug) {
        const { byVendorId } = await buildOrderLinesByVendorId(storeNumber, {
            dateKey: result.dateKey || melbourneDateKey(),
            ...orderOpts,
        });
        const files = resolveStoreReports(storeNumber, REPORTS_DIR);
        let iseItems = null;
        let iseDayLabels = [];
        if (files.inventorySpecialEvent) {
            const parsed = parseInventorySpecialEventFile(files.inventorySpecialEvent);
            iseItems = parsed.items;
            iseDayLabels = parsed.dayLabels;
        }
        const vendorId =
            vendor === 'americold'
                ? ''
                : vendor && vendor.startsWith('americold-')
                  ? vendor
                  : '';
        printBuildToDebug({
            storeNumber,
            buildTo: result,
            byVendorId,
            iseFile: files.inventorySpecialEvent,
            iseItems,
            iseDayLabels,
            itemCode,
            vendorId,
        });
        if (json) return;
        return;
    }

    if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    printHuman(result, vendor ? `Build-to (${vendor})` : 'Build-to (all items)');

    if (!all && result.orderLines.length > 15) {
        console.log(`\n… ${result.orderLines.length - 15} more lines. Use --json or --all to see everything.`);
    }
}

main().catch((err) => {
    console.error('[build-to-order]', err.message);
    process.exit(1);
});
