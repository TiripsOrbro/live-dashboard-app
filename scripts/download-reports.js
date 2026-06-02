#!/usr/bin/env node
/**
 * Download Macromatix build-to reports for every store in `.storelist`.
 *
 * Usage:
 *   npm run download-reports
 *   npm run download-reports -- --store 3811
 *   npm run download-reports -- --order-day
 *   npm run download-reports -- --order-day --order-date tomorrow
 *   npm run download-reports -- --order-day --dry-run
 *
 * Requires:
 *   - SCRAPER_USERNAME / SCRAPER_PASSWORD (or encrypted creds) in .env
 *   - config/reports-pipeline.json
 *   - .storelist with store numbers
 *
 * Output: Reports/{storeNumber}/ e.g. Reports/3811/20260530-1430-stock-on-hand.xls
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

const { downloadReportsForStores } = require('../src/services/mmxReportDownloader');
const { runOrderDayReportDownload } = require('../src/services/scheduledReportDownload');

function parseArgs(argv) {
    const args = argv.slice(2);
    let storeNumber = '';
    let onlyReports = '';
    let orderDate = '';
    const orderDay = args.includes('--order-day');
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--store' && args[i + 1]) {
            storeNumber = String(args[i + 1]).trim();
            i++;
        } else if (args[i] === '--only' && args[i + 1]) {
            onlyReports = String(args[i + 1]).trim();
            i++;
        } else if (args[i] === '--order-date' && args[i + 1]) {
            orderDate = String(args[i + 1]).trim();
            i++;
        }
    }
    return { storeNumber, onlyReports, orderDay, orderDate, dryRun, force };
}

async function main() {
    const { storeNumber, onlyReports, orderDay, orderDate, dryRun, force } = parseArgs(process.argv);

    if (orderDay) {
        const result = await runOrderDayReportDownload({
            orderDate: orderDate || undefined,
            dryRun,
            force,
        });
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
    }

    const options = storeNumber ? { storeNumber } : {};
    if (onlyReports) options.onlyReports = onlyReports;
    const result = await downloadReportsForStores(options);
    console.log(JSON.stringify(result, null, 2));

    const failed = Object.values(result.stores).some((s) => !s.success);
    process.exit(failed ? 1 : 0);
}

main().catch((err) => {
    console.error('[download-reports]', err.message);
    process.exit(1);
});
