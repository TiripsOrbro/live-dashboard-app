#!/usr/bin/env node
/**
 * Fill Macromatix scheduled orders only (skip stock count / Key Item Count).
 *
 * Usage:
 *   npm run fill-orders -- 3811
 *   npm run fill-orders -- 3811 --dry-run
 *   npm run fill-orders -- 3811 --dry-run --item 40303
 *   npm run fill-orders -- 3811 --dry-run --vendor americold-frz
 *   npm run fill-orders -- 3811 --download-reports
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

const { runScheduledOrdersOnly } = require('../src/services/stockCountMmxPipeline');
const { buildOrderLinesByVendorId } = require('../src/services/buildToOrderLines');
const { calculateBuildToOrders } = require('../src/services/buildToCalculator');
const { normalizeItemCode } = require('../src/services/reportReader');
const { melbourneDateKey } = require('../src/services/stockCountState');

function parseArgs(argv) {
    const args = argv.slice(2);
    const storeNumber = args.find((a) => /^\d{4}$/.test(a)) || '3811';
    const skipReportDownload = !args.includes('--download-reports');
    const dryRun = args.includes('--dry-run');
    const vendorIdx = args.indexOf('--vendor');
    const vendorId = vendorIdx >= 0 ? args[vendorIdx + 1] : '';
    const itemIdx = args.indexOf('--item');
    const itemCode = itemIdx >= 0 ? normalizeItemCode(args[itemIdx + 1]) : '';
    return { storeNumber, skipReportDownload, dryRun, vendorId, itemCode };
}

function printBuildToLine(line) {
    console.log(
        [
            line.itemCode,
            String(line.description || '').slice(0, 28),
            `days=${line.buildToDays ?? '—'}`,
            `buildTo=${line.buildTo}`,
            `onHand=${line.onHandCartons} (${line.onHandSource})`,
            `onOrder=${line.onOrderCartons}`,
            `order=${line.orderQty}`,
            line.buildToSource || '',
        ].join('\t')
    );
}

async function printDryRun(storeNumber, { vendorId, itemCode }) {
    const dateKey = melbourneDateKey();
    console.log(`[fill-orders] DRY RUN — store ${storeNumber} (${dateKey}) — no Macromatix browser`);

    const buildTo = await calculateBuildToOrders(storeNumber);
    const { byVendorId } = await buildOrderLinesByVendorId(storeNumber, { dateKey });

    const iseLines = buildTo.lines.filter((line) => {
        if (itemCode && normalizeItemCode(line.itemCode) !== itemCode) return false;
        return true;
    });

    console.log('\n--- ISE build-to (all vendors) ---');
    if (!iseLines.length) {
        console.log('  (no matching ISE lines)');
    } else {
        for (const line of iseLines) printBuildToLine(line);
    }

    console.log('\n--- Scheduled order quantities ---');
    let anyVendor = false;
    for (const [id, pack] of Object.entries(byVendorId)) {
        if (vendorId && id !== vendorId) continue;
        const entries = (pack.buildToEntries || []).filter((entry) => {
            if (!itemCode) return true;
            return (
                normalizeItemCode(entry.catalogItemCode) === itemCode ||
                normalizeItemCode(entry.iseItemCode) === itemCode
            );
        });
        const lines = (pack.lines || []).filter((line) => {
            if (!itemCode) return true;
            return normalizeItemCode(line.itemCode) === itemCode;
        });
        if (!entries.length && !lines.length) continue;
        anyVendor = true;
        console.log(`\n${pack.vendor?.label || id} (${id}):`);
        for (const entry of entries) {
            console.log(
                `  ${entry.catalogItemCode || entry.iseItemCode}\t${entry.orderQty}\t${entry.buildToSource || ''}\t${entry.catalogName || entry.description || ''}`
            );
        }
        for (const line of lines) {
            console.log(`  → MMX qty ${line.quantity}\t${line.itemCode}\t${line.itemName || ''}`);
        }
    }
    if (!anyVendor) console.log('  (no matching vendor order lines)');
}

async function main() {
    const { storeNumber, skipReportDownload, dryRun, vendorId, itemCode } = parseArgs(process.argv);

    if (dryRun) {
        await printDryRun(storeNumber, { vendorId, itemCode });
        return;
    }

    console.log(`[fill-orders] Store ${storeNumber} — skip report download: ${skipReportDownload}`);
    console.log('[fill-orders] Skipping Key Item Count — scheduled orders only');
    const result = await runScheduledOrdersOnly(storeNumber, { skipReportDownload });
    const processed = result.orders?.processed || [];
    const ok = processed.filter((p) => p.ok);
    const failed = processed.filter((p) => !p.ok);
    console.log(`[fill-orders] Done — ${ok.length}/${processed.length} vendor order(s) updated`);
    if (result.orderFailures) {
        console.warn(`[fill-orders] Partial failures: ${result.orderFailures}`);
    }
    if (failed.length) {
        for (const f of failed) console.warn(`  failed: ${f.label} — ${f.error}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('[fill-orders]', err.message);
    process.exit(1);
});
