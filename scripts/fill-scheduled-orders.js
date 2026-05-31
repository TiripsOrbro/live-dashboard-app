#!/usr/bin/env node
/**
 * Fill Macromatix scheduled orders only (skip stock count).
 *
 * Usage:
 *   npm run fill-orders -- 3811
 *   npm run fill-orders -- 3811 --download-reports
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

const { runScheduledOrdersOnly } = require('../src/services/stockCountMmxPipeline');

function parseArgs(argv) {
    const args = argv.slice(2);
    const storeNumber = args.find((a) => /^\d{4}$/.test(a)) || '3811';
    const skipReportDownload = !args.includes('--download-reports');
    return { storeNumber, skipReportDownload };
}

async function main() {
    const { storeNumber, skipReportDownload } = parseArgs(process.argv);
    console.log(`[fill-orders] Store ${storeNumber} — skip report download: ${skipReportDownload}`);
    const result = await runScheduledOrdersOnly(storeNumber, { skipReportDownload });
    const processed = result.orders?.processed || [];
    const ok = processed.filter((p) => p.ok);
    const failed = processed.filter((p) => !p.ok);
    console.log(`[fill-orders] Done — ${ok.length}/${processed.length} vendor order(s) updated`);
    if (failed.length) {
        for (const f of failed) console.warn(`  failed: ${f.label} — ${f.error}`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('[fill-orders]', err.message);
    process.exit(1);
});
