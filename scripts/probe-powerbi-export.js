#!/usr/bin/env node
/**
 * Diagnose Power BI export after login + direct report URL.
 *   npm run upsell-probe-export
 *   npm run upsell-probe-export -- --headed
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

if (!process.env.SCRAPER_EXECUTABLE_PATH && process.platform === 'win32') {
    const candidates = [
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) process.env.SCRAPER_EXECUTABLE_PATH = found;
}

const { openMacromatixBrowser, closeBrowserQuietly } = require('../src/services/macromatixScraper');
const { loadUpsellingConfig } = require('../src/services/upselling/upsellingConfig');
const { navigateToBiReport } = require('../src/services/upselling/biReportTree');
const { isOlapReportPage, exportOlapReportToExcel } = require('../src/services/upselling/olapReportExport');
const {
    waitForReportInteractive,
    collectContexts,
    snapshotExportControls,
    exportPowerBiToExcel,
} = require('../src/services/upselling/powerBiExport');

async function main() {
    const headed = process.argv.includes('--headed');
    const cfg = loadUpsellingConfig();
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({
            headless: !headed,
            skipSlowMo: !process.argv.includes('--slow'),
        }));
        await navigateToBiReport(page, cfg);
        console.log('[probe] URL:', page.url());
        console.log('[probe] Frames:', page.frames().map((f) => f.url()));

        const onOlap = isOlapReportPage(page.url());
        console.log('[probe] OLAP (MdxView):', onOlap);

        if (onOlap) {
            if (process.argv.includes('--export')) {
                await exportOlapReportToExcel(page, cfg);
                console.log('[probe] OLAP Excel export clicked - check downloads folder');
            } else {
                console.log('[probe] Add --export to click OLAP toolbar Excel');
            }
        } else {
            const ready = await waitForReportInteractive(page, cfg.reportReadyTimeoutMs || 90000);
            console.log('[probe] Power BI interactive:', ready);
            for (const { name, ctx } of collectContexts(page)) {
                const controls = await snapshotExportControls(ctx);
                console.log(`[probe] Controls in ${name}:`, JSON.stringify(controls, null, 2));
            }
            if (process.argv.includes('--export')) {
                await exportPowerBiToExcel(page, cfg);
                console.log('[probe] Power BI export clicked');
            }
        }
    } finally {
        await closeBrowserQuietly(browser, 'probe-powerbi');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
