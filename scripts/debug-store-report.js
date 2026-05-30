#!/usr/bin/env node
/** Probe Store Reports page controls after selecting Inventory Special Event. */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

const { openMacromatixBrowser, closeBrowserQuietly } = require('../src/services/macromatixScraper');
const { loadPipelineConfig } = require('../src/services/mmxReportDownloader');
const {
    openReportSelectionPage,
    setGroupDropdown,
    selectReportInList,
    setReportFormat,
    setStartDate,
} = require('../src/services/mmxReports/pipeline-supply-chain-reports');
const { resolveReportDate } = require('../src/services/mmxReports/util-dates');

async function main() {
    const pipeline = loadPipelineConfig();
    const report = pipeline.reports.find((r) => r.id === 'report3');
    const nav = pipeline.reportNavigation;
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({}));
        await openReportSelectionPage(page, nav, 45000);
        await setGroupDropdown(page, 'Store Reports');
        await selectReportInList(page, report.reportName, { loose: true });
        await page.waitForTimeout(2000);
        await setReportFormat(page, 'CSV');
        const startDate = resolveReportDate(report.startDate || 'daysAgo:8', { dateOnly: true });
        await setStartDate(page, startDate);

        const snapshot = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).map((inp) => ({
                id: inp.id,
                name: inp.name,
                value: inp.value,
                ctx: ((inp.closest('tr, td, table, div') || inp.parentElement)?.innerText || '').slice(0, 120),
            }));
            const selects = Array.from(document.querySelectorAll('select')).map((sel) => ({
                id: sel.id,
                ctx: ((sel.closest('tr, td, table, div') || sel).innerText || '').slice(0, 120),
                options: Array.from(sel.options)
                    .slice(0, 8)
                    .map((o) => o.textContent.trim()),
            }));
            return { inputs, selects };
        });
        console.log(JSON.stringify(snapshot, null, 2));
    } finally {
        await closeBrowserQuietly(browser, 'debug');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
