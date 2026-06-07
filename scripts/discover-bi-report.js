#!/usr/bin/env node
/**
 * Probe Macromatix Business Intelligence navigation for Upsell by Cashier.
 * Run with SCRAPER_HEADLESS=false to watch the browser.
 *
 *   node scripts/discover-bi-report.js [storeNumber]
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

if (!process.env.SCRAPER_EXECUTABLE_PATH && process.platform === 'win32') {
    const candidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) process.env.SCRAPER_EXECUTABLE_PATH = found;
}

const { openMacromatixBrowser, closeBrowserQuietly, selectStoreOnPage } = require('../src/services/macromatixScraper');
const { loadUpsellingConfig } = require('../src/services/upselling/upsellingConfig');
const {
    waitForReportTreeFrame,
    expandTreeFolder,
    openReportInTree,
    navigateToBiReport,
} = require('../src/services/upselling/biReportTree');
const { waitForPowerBiFrame, exportPowerBiToExcel } = require('../src/services/upselling/powerBiExport');

async function snapshotTreeLabels(frame) {
    return frame.evaluate(() => {
        const nodes = [];
        for (const el of document.querySelectorAll('.rtIn, .rtOut, span, a')) {
            const t = (el.textContent || '').trim();
            if (!t || t.length > 60) continue;
            if (/vic|ash|upsell|cashier/i.test(t)) nodes.push(t);
        }
        return [...new Set(nodes)].slice(0, 40);
    });
}

async function main() {
    const storeNumber = process.argv[2] || '3811';
    const cfg = loadUpsellingConfig();
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({ headless: false, skipSlowMo: true }));
        console.log('[discover] Logged in:', page.url());

        const { opened } = await navigateToBiReport(page, cfg);
        console.log('[discover] Opened report:', opened);

        const tree = await waitForReportTreeFrame(page, 5000).catch(() => null);
        if (tree) {
            console.log('[discover] Tree sample:', JSON.stringify(await snapshotTreeLabels(tree), null, 2));
        }

        const pbi = await waitForPowerBiFrame(page, cfg.reportReadyTimeoutMs || 60000);
        console.log('[discover] Power BI frame:', pbi ? pbi.url().slice(0, 100) : 'not found');

        if (pbi) {
            const pbiButtons = await pbi.evaluate(() =>
                Array.from(document.querySelectorAll('button, [role="menuitem"], a'))
                    .map((el) => ({
                        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 80),
                    }))
                    .filter((x) => /export|excel|download|share/i.test(x.label))
                    .slice(0, 25)
            );
            console.log('[discover] Power BI export buttons:', JSON.stringify(pbiButtons, null, 2));
        }

        const cfg2 = loadUpsellingConfig();
        if (cfg2.biReportUrl) {
            console.log('\n[discover] Using biReportUrl (direct):', cfg2.biReportUrl);
        } else {
            console.log('\n[discover] Using tree: biFolderPath VIC → Ash →', cfg2.reportName);
        }
    } finally {
        await closeBrowserQuietly(browser, 'discover-bi');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
