#!/usr/bin/env node
/**
 * Fill Macromatix scheduled orders only (skip stock count / Key Item Count).
 *
 * Usage:
 *   npm run fill-orders -- 3811
 *   npm run fill-orders -- 3811 --dry-run
 *   npm run fill-orders -- 3811 --dry-run --item 40303
 *   npm run fill-orders -- 3811 --dry-run --vendor americold-frz
 *   npm run fill-orders -- 3811 --skip-report-download   (offline only — skip MMX download)
 *   npm run fill-orders -- 3811 --dry-run --no-order-rounding   (raw shortage, no ceil)
 *   npm run fill-orders -- 3811 --dry-run --debug   (ISE dates/usage, build-to, order detail)
 */
const path = require('path');
require('../src/loadEnv').loadEnv();

const { runScheduledOrdersOnly, ensureReportsForOrders } = require('../src/services/stockCountMmxPipeline');
const { buildOrderLinesByVendorId } = require('../src/services/buildToOrderLines');
const { calculateBuildToOrders, REPORTS_DIR } = require('../src/services/buildToCalculator');
const {
    normalizeItemCode,
    resolveStoreReports,
    parseInventorySpecialEventFile,
    describeResolvedStoreReports,
} = require('../src/services/reportReader');
const { printBuildToDebug } = require('../src/services/buildToDebugFormat');
const { melbourneDateKey } = require('../src/services/stockCountState');

function parseArgs(argv) {
    const args = argv.slice(2);
    const storeNumber = args.find((a) => /^\d{4}$/.test(a)) || '3811';
    const skipReportDownload = args.includes('--skip-report-download');
    const dryRun = args.includes('--dry-run');
    const vendorIdx = args.indexOf('--vendor');
    const vendorId = vendorIdx >= 0 ? args[vendorIdx + 1] : '';
    const itemIdx = args.indexOf('--item');
    const itemCode = itemIdx >= 0 ? normalizeItemCode(args[itemIdx + 1]) : '';
    const noOrderRounding = args.includes('--no-order-rounding');
    const debug = args.includes('--debug');
    return { storeNumber, skipReportDownload, dryRun, vendorId, itemCode, noOrderRounding, debug };
}

function orderOptionsFromArgs({ noOrderRounding }) {
    return noOrderRounding ? { noOrderRounding: true } : {};
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

async function printDryRun(storeNumber, { vendorId, itemCode, noOrderRounding, debug }) {
    const dateKey = melbourneDateKey();
    const orderOpts = orderOptionsFromArgs({ noOrderRounding });
    const reportFiles = resolveStoreReports(storeNumber, REPORTS_DIR);
    const reportNames = describeResolvedStoreReports(reportFiles);
    console.log(`[fill-orders] DRY RUN — store ${storeNumber} (${dateKey})`);
    console.log(
        `[fill-orders] Reports: ISE=${reportNames.inventorySpecialEvent}, SOH=${reportNames.stockOnHand}, SOO=${reportNames.stockOnOrder}`
    );
    if (noOrderRounding) {
        console.log('[fill-orders] Order rounding OFF — quantities are raw build-to − on-hand − on-order');
    }

    const buildTo = await calculateBuildToOrders(storeNumber, orderOpts);
    const { byVendorId } = await buildOrderLinesByVendorId(storeNumber, { dateKey, ...orderOpts });

    if (debug) {
        const files = resolveStoreReports(storeNumber, REPORTS_DIR);
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
            vendorId,
        });
    }

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
        const buildToByCode = new Map();
        for (const bl of buildTo.lines || []) {
            buildToByCode.set(normalizeItemCode(bl.itemCode), bl);
        }
        for (const entry of entries) {
            const code = normalizeItemCode(entry.catalogItemCode || entry.iseItemCode);
            const bl = buildToByCode.get(code);
            const calc = bl
                ? `  calc: avg=${bl.avgDaily} x${bl.buildToDays}d => buildTo=${bl.buildTo}, onHand=${bl.onHandCartons} (${bl.onHandSource}), onOrder=${bl.onOrderCartons} => order=${bl.orderQty}`
                : '';
            console.log(
                `  ${code}\torder=${entry.orderQty}\t${entry.buildToSource || ''}\t${entry.catalogName || entry.description || ''}`
            );
            if (calc) console.log(calc);
        }
        for (const line of lines) {
            console.log(`  → MMX qty ${line.quantity}\t${line.itemCode}\t${line.itemName || ''}`);
        }
    }
    if (!anyVendor) console.log('  (no matching vendor order lines)');
}

async function main() {
    const { storeNumber, skipReportDownload, dryRun, vendorId, itemCode, noOrderRounding, debug } =
        parseArgs(process.argv);
    const orderOpts = orderOptionsFromArgs({ noOrderRounding });

    if (dryRun) {
        if (!skipReportDownload) {
            console.log(`[fill-orders] Downloading reports for store ${storeNumber} before dry-run…`);
            await ensureReportsForOrders(storeNumber, { forceDownload: true });
        } else {
            console.log(`[fill-orders] Dry run — using existing Reports/${storeNumber}/ (--skip-report-download)`);
        }
        await printDryRun(storeNumber, { vendorId, itemCode, noOrderRounding, debug });
        return;
    }

    console.log(
        `[fill-orders] Store ${storeNumber} — ${skipReportDownload ? 'using existing reports' : 'will download reports first'}`
    );
    if (noOrderRounding) {
        console.log('[fill-orders] Order rounding OFF — quantities are raw build-to − on-hand − on-order');
    }
    console.log('[fill-orders] Skipping Key Item Count — scheduled orders only');
    const result = await runScheduledOrdersOnly(storeNumber, { skipReportDownload, ...orderOpts });
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
