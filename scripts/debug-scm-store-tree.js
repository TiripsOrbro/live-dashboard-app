#!/usr/bin/env node
/**
 * Probe SCM Items On Hand store tree and test checkbox selection for one store.
 *
 * Usage:
 *   npm run debug-scm-tree -- 3808
 *   npm run debug-scm-tree -- 3808 --screenshot
 */
const fs = require('fs');
const path = require('path');
require('../src/loadEnv').loadEnv();

const { openMacromatixBrowser, closeBrowserQuietly } = require('../src/services/macromatixScraper');
const { loadPipelineConfig } = require('../src/services/mmxReportDownloader');
const { getStoreConfig } = require('../src/services/storeList');
const {
    openReportSelectionPage,
    setGroupDropdown,
    selectReportInList,
    setReportFormat,
    setStartDate,
    listScmStoreTreeLabels,
    selectScmStoreCheckboxInTree,
} = require('../src/services/mmxReports/pipeline-supply-chain-reports');
const { resolveReportDate } = require('../src/services/mmxReports/util-dates');

function parseArgs(argv) {
    const args = argv.slice(2);
    let storeNumber = '';
    let screenshot = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--screenshot') screenshot = true;
        else if (/^\d{4}$/.test(args[i])) storeNumber = args[i];
    }
    return { storeNumber, screenshot };
}

function printSnapshot(label, snap) {
    console.log(`\n=== ${label} ===`);
    console.log(`RadTreeView: ${snap.hasRadTree}, rtPlus: ${snap.rtPlus}, rtMinus: ${snap.rtMinus}, labels: ${snap.labels.length}`);
    for (const row of snap.labels.slice(0, 25)) {
        console.log(`  ${row.checked ? '[x]' : '[ ]'} ${row.text}`);
    }
    if (snap.labels.length > 25) console.log(`  ... +${snap.labels.length - 25} more`);
}

async function main() {
    const { storeNumber, screenshot } = parseArgs(process.argv);
    if (!storeNumber) {
        console.error('Usage: npm run debug-scm-tree -- <storeNumber> [--screenshot]');
        process.exit(1);
    }

    const cfg = getStoreConfig(storeNumber);
    const storeName = cfg ? `${storeNumber} ${cfg.storeName}` : storeNumber;

    const pipeline = loadPipelineConfig();
    const report = pipeline.reports.find((r) => r.id === 'report1');
    const nav = pipeline.reportNavigation;
    if (!report) throw new Error('report1 not in config/reports-pipeline.json');

    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({}));
        await openReportSelectionPage(page, nav, 45000);
        await page.waitForTimeout(3000);
        try {
            await setGroupDropdown(page, report.group || 'Supply Chain');
        } catch (err) {
            const groups = await page.evaluate(() => {
                const out = [];
                for (const sel of document.querySelectorAll('select')) {
                    const opts = Array.from(sel.options)
                        .map((o) => (o.textContent || '').trim())
                        .filter(Boolean);
                    if (opts.length) {
                        out.push({
                            ctx: ((sel.closest('tr, td, div') || sel).innerText || '').slice(0, 80),
                            opts: opts.slice(0, 25),
                        });
                    }
                }
                return { title: document.title, url: location.href, selects: out };
            });
            console.error('Group dropdown failed. Page state:', JSON.stringify(groups, null, 2));
            throw err;
        }
        await selectReportInList(page, report.reportName);
        await setReportFormat(page, report.format || 'Excel Data Only');
        await page.waitForTimeout(1000);

        const startDate = resolveReportDate(report.startDate || 'today', {
            timeZone: report.timeZone,
            dateOnly: Boolean(report.dateOnly),
        });
        await setStartDate(page, startDate);

        const before = await listScmStoreTreeLabels(page);
        printSnapshot('Before select (after start date)', before);

        await selectScmStoreCheckboxInTree(page, storeNumber, storeName);

        const after = await listScmStoreTreeLabels(page);
        printSnapshot('After select', after);

        const checked = after.labels.filter((r) => r.checked && new RegExp(`\\b${storeNumber}\\b`).test(r.text));
        console.log(
            checked.length
                ? `\nOK: checked row(s): ${checked.map((r) => r.text).join(', ')}`
                : `\nWARN: no checked row matching store ${storeNumber}`
        );

        if (screenshot) {
            const dir = path.join(__dirname, '../Reports/debug');
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, `scm-tree-${storeNumber}-${Date.now()}.png`);
            await page.screenshot({ path: file, fullPage: true });
            console.log(`Screenshot: ${file}`);
        }
    } finally {
        await closeBrowserQuietly(browser, 'debug-scm-tree');
    }
}

main().catch((e) => {
    console.error('[debug-scm-tree]', e.message);
    process.exit(1);
});
