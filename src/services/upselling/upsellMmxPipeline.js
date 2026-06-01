const fs = require('fs');
const path = require('path');
const { openMacromatixBrowser, closeBrowserQuietly } = require('../macromatixScraper');
const { acquireMmxResource, releaseMmxResource, waitUntilMmxResourceIdle } = require('../mmxResourceGate');
const { configureDownloadPath, clickExportExcelDataOnly, waitForReportDownload } = require('../mmxReports/pipeline-download-reports');
const { setReportStartDate } = require('../mmxReports/mmx-rad-date-picker');
const { resolveReportDate } = require('../mmxReports/util-dates');
const { BASE_URL, GOTO_OPTS } = require('../mmxReports/mmx-browser');
const { ensureDir, timestampSlug } = require('../mmxReports/util-files');
const {
    loadUpsellingConfig,
    isUpsellingMmxSyncStore,
    upsellingDataDir,
    resolveUpsellReportDateSpec,
    TIME_ZONE,
} = require('./upsellingConfig');
const { processReportFile, processParsedReport } = require('./upsellingScores');
const { exportPowerBiToExcel } = require('./powerBiExport');
const { isOlapReportPage, exportOlapReportToExcel } = require('./olapReportExport');
const { scrapeOlapUpsellReport } = require('./olapReportScraper');
const { navigateToBiReport: navigateBiTree } = require('./biReportTree');
const log = require('../mmxReports/util-logging');

async function navigateToBiReport(page, cfg) {
    await navigateBiTree(page, cfg);
    log.info(`[Upselling] Report URL: ${page.url()}`);
}

function resolveSyncReportDate(cfg) {
    const mode = String(cfg.reportDateMode || '').trim().toLowerCase();
    if (mode === 'competition' || cfg.skipDatePicker) {
        return 'competition';
    }
    const dateSpec = resolveUpsellReportDateSpec(cfg.reportDateMode);
    return resolveReportDate(dateSpec, { timeZone: TIME_ZONE, dateOnly: true });
}

function writeLastSync(storeNumber, extra = {}) {
    const dir = upsellingDataDir(storeNumber);
    ensureDir(dir);
    const payload = {
        lastSyncAt: new Date().toISOString(),
        lastHourKey: extra.lastHourKey || null,
        reportDate: extra.reportDate || null,
        exportFile: extra.exportFile || null,
        source: extra.source || null,
        ok: extra.ok !== false,
        error: extra.error || null,
    };
    fs.writeFileSync(path.join(dir, 'last-sync.json'), JSON.stringify(payload, null, 2), 'utf8');
    return payload;
}

/**
 * Sync Upsell by Cashier from MMX Business Intelligence, score, and merge .Employees.
 */
async function runUpsellMmxSync(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    if (!isUpsellingMmxSyncStore(store)) {
        throw new Error(`Store ${store} is not configured for Macromatix upsell sync (use --file for teststore).`);
    }
    const cfg = loadUpsellingConfig();
    const dataDir = upsellingDataDir(store);
    ensureDir(dataDir);

    if (!options.skipGate) {
        await waitUntilMmxResourceIdle();
    }
    acquireMmxResource('upselling sync');

    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser(options.browserOptions || {}));
        const downloadDir = path.join(dataDir, 'downloads');
        ensureDir(downloadDir);
        await configureDownloadPath(page, downloadDir);

        await navigateToBiReport(page, cfg);

        const reportDate = resolveSyncReportDate(cfg);
        const exportMode = String(options.exportMode || cfg.exportMode || 'scrape').toLowerCase();
        const onOlap = isOlapReportPage(page.url()) || /^(scrape|olap)$/.test(exportMode);

        if (!onOlap && !cfg.skipDatePicker && reportDate !== 'competition') {
            await setReportStartDate(page, reportDate);
            await page.waitForTimeout(1500);
        }

        let ranked;
        let exportFile = null;

        if (onOlap && exportMode === 'scrape') {
            log.warn(
                '[Upselling] HTML scrape can mis-map stores on wide OLAP grids — prefer exportMode "download" in config/upselling.json'
            );
            log.info('[Upselling] Reading numbers from BI table (no file download)');
            const parsed = await scrapeOlapUpsellReport(page, cfg, store);
            const result = processParsedReport(parsed, store, { source: 'mdx-scrape' });
            ranked = result.ranked;
            if (result.byDay?.length) {
                console.log(`[Upselling] Per-day rows: ${result.byDay.length}`);
                for (const row of result.byDay) {
                    console.log(`  ${row.day || '?'} | ${row.name} | ${row.points} pts`);
                }
            }
        } else if (onOlap && exportMode === 'download') {
            log.info('[Upselling] Downloading BI table as Excel');
            let usedScrapeFallback = false;
            try {
                await exportOlapReportToExcel(page, cfg);
                const downloaded = await waitForReportDownload(
                    downloadDir,
                    cfg.downloadWaitMs || 120000,
                    '.xls'
                );
                exportFile = path.basename(downloaded);
                const dest = path.join(
                    dataDir,
                    `${timestampSlug()}-upsell-by-cashier${path.extname(downloaded) || '.xls'}`
                );
                if (downloaded !== dest) fs.renameSync(downloaded, dest);
                const lastExportPath = path.join(dataDir, 'last-export' + path.extname(dest));
                fs.copyFileSync(dest, lastExportPath);
                log.info(`[Upselling] Saved export: ${lastExportPath}`);
                ({ ranked } = processReportFile(dest, store, { source: 'olap-download' }));
            } catch (downloadErr) {
                log.warn(`[Upselling] Excel download failed: ${downloadErr.message}`);
                log.info('[Upselling] Falling back to HTML table scrape');
                usedScrapeFallback = true;
                const parsed = await scrapeOlapUpsellReport(page, cfg, store);
                const result = processParsedReport(parsed, store, { source: 'mdx-scrape-fallback' });
                ranked = result.ranked;
            }
            if (usedScrapeFallback && options.browserOptions?.headless === false) {
                log.info('[Upselling] Browser left open 30s — verify the report on screen');
                await page.waitForTimeout(30000);
            }
        } else if (exportMode === 'powerbi') {
            await exportPowerBiToExcel(page, cfg);
            const downloaded = await waitForReportDownload(
                downloadDir,
                cfg.downloadWaitMs || 120000,
                '.xlsx'
            );
            exportFile = path.basename(downloaded);
            const dest = path.join(dataDir, `${timestampSlug()}-upsell-by-cashier.xlsx`);
            if (downloaded !== dest) fs.renameSync(downloaded, dest);
            ({ ranked } = processReportFile(dest, store));
        } else {
            await clickExportExcelDataOnly(page, { exportLinkText: cfg.exportLinkText || 'excel' });
            const downloaded = await waitForReportDownload(downloadDir, cfg.downloadWaitMs || 120000, '.xlsx');
            exportFile = path.basename(downloaded);
            ({ ranked } = processReportFile(downloaded, store));
        }

        const sync = writeLastSync(store, {
            reportDate,
            exportFile,
            source: exportMode === 'scrape' ? 'mdx-scrape' : 'file',
            lastHourKey: options.lastHourKey,
            ok: true,
        });

        const top5 = ranked.slice(0, 5).map((r, i) => `${i + 1}. ${r.name} (${r.total})`);
        console.log(`[Upselling] Store ${store}: synced ${ranked.length} cashier(s)`);
        if (top5.length) console.log(`[Upselling] Top 5:\n  ${top5.join('\n  ')}`);
        return { ok: true, ranked, sync };
    } catch (error) {
        await writeLastSync(store, { ok: false, error: error.message, lastHourKey: options.lastHourKey });
        throw error;
    } finally {
        releaseMmxResource('upselling sync');
        await closeBrowserQuietly(browser, 'upsell sync');
    }
}

function runUpsellFromFile(storeNumber, filePath) {
    const result = processReportFile(filePath, storeNumber);
    writeLastSync(storeNumber, { exportFile: path.basename(filePath), ok: true, reportDate: 'competition' });
    return result;
}

module.exports = {
    runUpsellMmxSync,
    runUpsellFromFile,
    navigateToBiReport,
    writeLastSync,
};
