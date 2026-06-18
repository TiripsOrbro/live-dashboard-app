#!/usr/bin/env node
/**
 * Full build-to cycle: clear reports → download ISE+SOH+SOO → fill MMX → delete reports.
 *
 * Usage:
 *   npm run refresh-store-build-to -- 3808
 *   npm run refresh-store-build-to -- 3808 --dry-run
 */
const path = require('path');
require('../src/loadEnv').loadEnv();

const { runStoreBuildToCycle } = require('../src/services/stockCountMmxPipeline');
const { openMacromatixBrowser, closeBrowserQuietly } = require('../src/services/macromatixScraper');
const { loadPipelineConfig } = require('../src/services/mmxReportDownloader');
const { resolveReportDate } = require('../src/services/mmxReports/util-dates');

function parseArgs(argv) {
    const args = argv.slice(2);
    let storeNumber = '';
    const dryRun = args.includes('--dry-run');
    const noOrderRounding = args.includes('--no-order-rounding');
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--store' && args[i + 1]) {
            storeNumber = String(args[i + 1]).trim();
            i++;
        } else if (!storeNumber && /^\d{4}$/.test(args[i])) {
            storeNumber = args[i];
        }
    }
    return { storeNumber, dryRun, noOrderRounding };
}

async function main() {
    const { storeNumber, dryRun, noOrderRounding } = parseArgs(process.argv);
    if (!storeNumber) {
        console.error('Usage: npm run refresh-store-build-to -- <storeNumber> [--dry-run]');
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

    console.log(
        `[refresh] Store ${storeNumber} - clear → download (ISE+SOH+SOO) → ${dryRun ? 'preview' : 'fill MMX'} → clear`
    );
    console.log(`[refresh] SOH startDate: ${sohReport?.startDate || '-'} → ${sohDate}`);
    console.log(
        '[refresh] Note: SOH filename uses today\'s download time; MMX form date above is what drives on-hand qty. Stock-count overrides are ignored in this cycle.'
    );

    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({}));
        const result = await runStoreBuildToCycle(storeNumber, {
            page,
            browser,
            dryRun,
            noOrderRounding: noOrderRounding || undefined,
            skipReportDownload: false,
            cleanupReports: !dryRun,
        });

        if (dryRun) {
            console.log('[refresh] Dry-run complete - reports left on disk for inspection');
            console.log(
                `[refresh] ${result.buildTo?.lines?.length || 0} build-to lines, on-order lines: ${
                    (result.buildTo?.lines || []).filter((l) => Number(l.onOrderCartons) > 0).length
                }`
            );
            return;
        }

        const processed = result.orders?.processed || [];
        const ok = processed.filter((p) => p.ok);
        console.log(`[refresh] Done - ${ok.length}/${processed.length} vendor(s) OK`);
        if (result.orders?.orderFailures) {
            console.warn(`[refresh] Failures: ${result.orders.orderFailures}`);
            process.exit(1);
        }
    } finally {
        await closeBrowserQuietly(browser, 'refresh-store-build-to');
    }
}

main().catch((err) => {
    console.error('[refresh]', err.message);
    process.exit(1);
});
