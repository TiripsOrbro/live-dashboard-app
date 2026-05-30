#!/usr/bin/env node
/**
 * Calculate 10-day build-to order quantities from downloaded MMX reports.
 *
 * Usage:
 *   npm run build-to-order -- 3811
 *   npm run build-to-order -- 3811 --vendor americold
 *   npm run build-to-order -- 3811 --json
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

const { calculateBuildToOrders, filterAmericoldOrderLines } = require('../src/services/buildToCalculator');

function parseArgs(argv) {
    const args = argv.slice(2);
    const storeNumber = args.find((a) => /^\d{4}$/.test(a)) || '3811';
    const vendor = args.includes('--vendor') ? args[args.indexOf('--vendor') + 1] : null;
    const json = args.includes('--json');
    const all = args.includes('--all');
    return { storeNumber, vendor, json, all };
}

function printHuman(result, title) {
    console.log(`\n=== ${title} — store ${result.storeNumber} (${result.dateKey}) ===`);
    console.log(`Reports: ${path.basename(result.files.inventorySpecialEvent || '')}`);
    console.log(`Manual count overrides: ${result.manualCountItems} item(s) with drafts today`);
    console.log(`Order lines with qty > 0: ${result.orderLines.length}\n`);

    const cols = ['itemCode', 'description', 'days', 'buildTo', 'onHand', 'onOrder', 'orderQty', 'source'];
    console.log(cols.join('\t'));
    for (const line of result.orderLines) {
        console.log(
            [
                line.itemCode,
                line.description.slice(0, 36),
                line.buildToDays,
                line.buildTo,
                line.onHandCartons,
                line.onOrderCartons,
                line.orderQty,
                line.onHandSource,
            ].join('\t')
        );
    }
}

async function main() {
    const { storeNumber, vendor, json, all } = parseArgs(process.argv);
    let result = await calculateBuildToOrders(storeNumber);

    if (vendor === 'americold') {
        result = { ...result, orderLines: filterAmericoldOrderLines(result).orderLines };
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
