#!/usr/bin/env node
/**
 * Full build-to cycle for one store: delete old reports → download fresh → fill MMX orders.
 *
 * Usage:
 *   npm run refresh-store-build-to -- 3808
 *   npm run refresh-store-build-to -- 3808 --dry-run
 *   npm run refresh-store-build-to -- 3808 --download-only
 *
 * SOH date comes from config/reports-pipeline.json report1 startDate (tomorrow).
 */
const path = require('path');
require('../src/loadEnv').loadEnv();

const { downloadReportsForStores, loadPipelineConfig } = require('../src/services/mmxReportDownloader');
const { runScheduledOrdersOnly } = require('../src/services/stockCountMmxPipeline');
const { clearStoreReportFiles, resolveStoreReports, validateStoreReports } = require('../src/services/reportReader');
const { REPORTS_DIR } = require('../src/services/buildToCalculator');
const { resolveReportDate } = require('../src/services/mmxReports/util-dates');

function parseArgs(argv) {
    const args = argv.slice(2);
    let storeNumber = '';
    const dryRun = args.includes('--dry-run');
    const downloadOnly = args.includes('--download-only');
    const noOrderRounding = args.includes('--no-order-rounding');
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--store' && args[i + 1]) {
            storeNumber = String(args[i + 1]).trim();
            i++;
        } else if (!storeNumber && /^\d{4}$/.test(args[i])) {
            storeNumber = args[i];
        }
    }
    return { storeNumber, dryRun, downloadOnly, noOrderRounding };
}

async function main() {
    const { storeNumber, dryRun, downloadOnly, noOrderRounding } = parseArgs(process.argv);
    if (!storeNumber) {
        console.error('Usage: npm run refresh-store-build-to -- <storeNumber> [--dry-run] [--download-only]');
        process.exit(1);
    }

    const pipeline = loadPipelineConfig();
    const sohReport = pipeline.reports.find((r) => r.id === 'report1');
    const sohDate = sohReport
        ? resolveReportDate(sohReport.startDate || 'tomorrow', {
              timeZone: sohReport.timeZone,
              dateOnly: false,
          })
        : '(unknown)';

    console.log(`[refresh] Store ${storeNumber} — clear → download → ${downloadOnly ? 'STOP' : dryRun ? 'dry-run orders' : 'fill MMX orders'}`);
    console.log(`[refresh] SOH Macromatix startDate: ${sohReport?.startDate || '—'} → ${sohDate}`);

    const { storeDir, removed } = clearStoreReportFiles(storeNumber, REPORTS_DIR);
    if (removed.length) {
        console.log(`[refresh] Deleted ${removed.length} file(s) from ${storeDir}:`);
        for (const f of removed) console.log(`  - ${f}`);
    } else {
        console.log(`[refresh] No existing files in ${storeDir}`);
    }

    const dl = await downloadReportsForStores({ storeNumber });
    const storeResult = dl.stores?.[storeNumber];
    if (!storeResult?.success) {
        const detail = (storeResult?.missingReports || [storeResult?.error || 'download failed']).join(', ');
        console.error(`[refresh] Download failed: ${detail}`);
        process.exit(1);
    }
    console.log('[refresh] Downloaded:', storeResult.files);

    const files = resolveStoreReports(storeNumber, REPORTS_DIR);
    const validation = validateStoreReports(storeNumber, files);
    console.log('[refresh] Reports on disk:', {
        ise: files.inventorySpecialEvent ? path.basename(files.inventorySpecialEvent) : null,
        soh: files.stockOnHand ? path.basename(files.stockOnHand) : null,
        soo: files.stockOnOrder ? path.basename(files.stockOnOrder) : null,
        validation,
    });
    if (!validation.valid) {
        console.warn('[refresh] Validation warnings — fill may still run but quantities can be wrong');
    }

    if (downloadOnly) return;

    if (dryRun) {
        const { calculateBuildToOrders } = require('../src/services/buildToCalculator');
        const { buildOrderLinesByVendorId } = require('../src/services/buildToOrderLines');
        const { melbourneDateKey } = require('../src/services/stockCountState');
        const orderOpts = { noOrderRounding: noOrderRounding || undefined };
        await calculateBuildToOrders(storeNumber, orderOpts);
        const { byVendorId } = await buildOrderLinesByVendorId(storeNumber, {
            dateKey: melbourneDateKey(),
            ...orderOpts,
        });
        console.log('[refresh] Dry-run order pack:', JSON.stringify(byVendorId, null, 2));
        return;
    }

    const result = await runScheduledOrdersOnly(storeNumber, {
        skipReportDownload: true,
        noOrderRounding: noOrderRounding || undefined,
    });
    const processed = result.orders?.processed || [];
    const ok = processed.filter((p) => p.ok);
    console.log(`[refresh] Fill done — ${ok.length}/${processed.length} vendor(s) OK`);
    if (result.orderFailures) {
        console.warn(`[refresh] Failures: ${result.orderFailures}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('[refresh]', err.message);
    process.exit(1);
});
