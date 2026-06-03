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
    isSyncAllStores,
    upsellingRootDir,
    upsellingLastSyncPath,
    upsellingLastExportPath,
    resolveUpsellReportDateSpec,
    resolveUpsellSyncDay,
    resolveUpsellSyncDayForRun,
    maybeMarkBackfillComplete,
    TIME_ZONE,
} = require('./upsellingConfig');
const { processReportFile, processParsedReport, processMultiStoreReportFile, scoreAllStoresFromParsed } = require('./upsellingScores');
const { exportPowerBiToExcel } = require('./powerBiExport');
const { isOlapReportPage, pageHasOlapReport, exportOlapReportToFile } = require('./olapReportExport');
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

function writeLastSync(extra = {}) {
    ensureDir(upsellingRootDir());
    const payload = {
        lastSyncAt: new Date().toISOString(),
        lastHourKey: extra.lastHourKey || null,
        reportDate: extra.reportDate || null,
        exportFile: extra.exportFile || null,
        source: extra.source || null,
        storesUpdated: extra.storesUpdated || null,
        ok: extra.ok !== false,
        error: extra.error || null,
    };
    fs.writeFileSync(upsellingLastSyncPath(), JSON.stringify(payload, null, 2), 'utf8');
    return payload;
}

function finalizeMultiStoreSync(multiResult, extra = {}) {
    return writeLastSync({
        ...extra,
        ok: true,
        storesUpdated: multiResult?.storeNumbers || [],
    });
}

function processDownloadedExport(dest, store, syncAll, syncDay, source) {
    if (syncAll) {
        return processMultiStoreReportFile(dest, { source, syncDay, allStores: true });
    }
    return processReportFile(dest, store, { source });
}

/**
 * Sync Upsell by Cashier from MMX Business Intelligence, score, and merge {store}_leaderboard.json.
 * When syncAllStores is enabled, one export updates every enabled store in the file.
 */
async function runUpsellMmxSync(storeNumber, options = {}) {
    const cfg = loadUpsellingConfig();
    const syncAll = options.syncAllStores ?? isSyncAllStores(cfg);
    const store = String(storeNumber || '').trim();
    if (!syncAll && !isUpsellingMmxSyncStore(store)) {
        throw new Error(`Store ${store} is not configured for Macromatix upsell sync (use --file for teststore).`);
    }
    const dataDir = upsellingRootDir();
    ensureDir(dataDir);
    const syncDay = resolveUpsellSyncDayForRun(cfg, options);

    if (!options.skipGate) {
        await waitUntilMmxResourceIdle();
    }
    acquireMmxResource('upselling sync');

    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser(options.browserOptions || {}));
        const downloadDir = dataDir;
        ensureDir(downloadDir);
        await configureDownloadPath(page, downloadDir);

        await navigateToBiReport(page, cfg);

        const reportDate = resolveSyncReportDate(cfg);
        const exportMode = String(options.exportMode || cfg.exportMode || 'scrape').toLowerCase();
        let onOlap = await pageHasOlapReport(page);
        if (!onOlap && exportMode === 'download') {
            log.warn(
                '[Upselling] Portal shell URL without OLAP detection — rechecking frames (avoid legacy Excel export)'
            );
            onOlap = await pageHasOlapReport(page);
        }

        if (!onOlap && !cfg.skipDatePicker && reportDate !== 'competition') {
            await setReportStartDate(page, reportDate);
            await page.waitForTimeout(1500);
        }

        let ranked;
        let exportFile = null;
        let multiResult = null;

        if (onOlap && exportMode === 'scrape') {
            log.warn(
                '[Upselling] HTML scrape can mis-map stores on wide OLAP grids — prefer exportMode "download" in config/upselling.json'
            );
            log.info('[Upselling] Reading numbers from BI table (no file download)');
            const parsed = await scrapeOlapUpsellReport(page, cfg, syncAll ? '' : store);
            if (syncAll) {
                multiResult = scoreAllStoresFromParsed(parsed, {
                    source: 'mdx-scrape',
                    syncDay,
                });
            } else {
                const result = processParsedReport(parsed, store, { source: 'mdx-scrape', syncDay });
                ranked = result.ranked;
                if (result.byDay?.length) {
                    console.log(`[Upselling] Per-day rows: ${result.byDay.length}`);
                    for (const row of result.byDay) {
                        console.log(`  ${row.day || '?'} | ${row.name} | ${row.points} pts`);
                    }
                }
            }
        } else if (onOlap && exportMode === 'download') {
            const olapFormat = String(cfg.olapExportFormat || 'excel').trim().toLowerCase();
            const downloadExt = olapFormat === 'csv' ? '.csv' : '.xls';
            log.info(`[Upselling] Downloading BI table as ${olapFormat.toUpperCase()}`);
            let usedScrapeFallback = false;
            try {
                await exportOlapReportToFile(page, cfg);
                const downloaded = await waitForReportDownload(
                    downloadDir,
                    cfg.downloadWaitMs || 120000,
                    downloadExt
                );
                exportFile = path.basename(downloaded);
                const dest = path.join(
                    dataDir,
                    `${timestampSlug()}-upsell-by-cashier${path.extname(downloaded) || downloadExt}`
                );
                if (downloaded !== dest) fs.renameSync(downloaded, dest);
                const lastExportPath = upsellingLastExportPath(path.extname(dest));
                fs.copyFileSync(dest, lastExportPath);
                log.info(`[Upselling] Saved export: ${lastExportPath}`);
                if (syncAll) {
                    multiResult = processDownloadedExport(dest, store, true, syncDay, 'olap-download');
                } else {
                    ({ ranked } = processReportFile(dest, store, { source: 'olap-download' }));
                }
            } catch (downloadErr) {
                log.warn(`[Upselling] ${olapFormat.toUpperCase()} download failed: ${downloadErr.message}`);
                let recovered = false;
                if (olapFormat === 'csv') {
                    try {
                        log.info('[Upselling] Retrying OLAP export as Excel…');
                        const excelCfg = {
                            ...cfg,
                            olapExportFormat: 'excel',
                            olapExportMenuLabel: 'Excel',
                        };
                        await exportOlapReportToFile(page, excelCfg);
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
                        const lastExportPath = upsellingLastExportPath(path.extname(dest));
                        fs.copyFileSync(dest, lastExportPath);
                        log.info(`[Upselling] Saved export: ${lastExportPath}`);
                        if (syncAll) {
                            multiResult = processDownloadedExport(dest, store, true, syncDay, 'olap-download');
                        } else {
                            ({ ranked } = processReportFile(dest, store, { source: 'olap-download' }));
                        }
                        recovered = true;
                    } catch (excelErr) {
                        log.warn(`[Upselling] Excel download also failed: ${excelErr.message}`);
                    }
                }
                if (!recovered) {
                    log.info('[Upselling] Falling back to HTML table scrape');
                    usedScrapeFallback = true;
                    const parsed = await scrapeOlapUpsellReport(page, cfg, syncAll ? '' : store);
                    if (syncAll) {
                        multiResult = scoreAllStoresFromParsed(parsed, {
                            source: 'mdx-scrape-fallback',
                            syncDay,
                        });
                    } else {
                        const result = processParsedReport(parsed, store, {
                            source: 'mdx-scrape-fallback',
                            syncDay,
                        });
                        ranked = result.ranked;
                    }
                }
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
            if (syncAll) {
                multiResult = processDownloadedExport(dest, store, true, syncDay, 'powerbi');
            } else {
                ({ ranked } = processReportFile(dest, store));
            }
        } else {
            await clickExportExcelDataOnly(page, { exportLinkText: cfg.exportLinkText || 'excel' });
            const downloaded = await waitForReportDownload(downloadDir, cfg.downloadWaitMs || 120000, '.xlsx');
            exportFile = path.basename(downloaded);
            if (syncAll) {
                multiResult = processDownloadedExport(downloaded, store, true, syncDay, 'excel');
            } else {
                ({ ranked } = processReportFile(downloaded, store));
            }
        }

        const syncMeta = {
            reportDate,
            exportFile,
            source: exportMode === 'scrape' ? 'mdx-scrape' : 'file',
            lastHourKey: options.lastHourKey,
            ok: true,
        };

        if (syncAll && multiResult) {
            finalizeMultiStoreSync(multiResult, syncMeta);
            maybeMarkBackfillComplete(syncDay, {
                storesUpdated: multiResult.storeNumbers,
                exportFile,
                source: syncMeta.source,
            });
            console.log(
                `[Upselling] Regional sync complete — ${multiResult.storeNumbers.length} store(s): ${multiResult.storeNumbers.join(', ')}`
            );
            return { ok: true, syncAll: true, stores: multiResult.stores, storeNumbers: multiResult.storeNumbers, syncDay };
        }

        const sync = writeLastSync({ ...syncMeta, storesUpdated: [store] });

        const top5 = (ranked || []).slice(0, 5).map((r, i) => `${i + 1}. ${r.name} (${r.total})`);
        console.log(`[Upselling] Store ${store}: synced ${(ranked || []).length} cashier(s)`);
        if (top5.length) console.log(`[Upselling] Top 5:\n  ${top5.join('\n  ')}`);
        return { ok: true, ranked, sync };
    } catch (error) {
        writeLastSync({ ok: false, error: error.message, lastHourKey: options.lastHourKey });
        throw error;
    } finally {
        releaseMmxResource('upselling sync');
        if (options.browserOptions?.keepBrowserOpen && browser) {
            console.log('[Upselling] Headed mode — browser stays open 90s so you can inspect (Ctrl+C to exit sooner)');
            await new Promise((r) => setTimeout(r, 90000));
        }
        await closeBrowserQuietly(browser, 'upsell sync');
    }
}

function runUpsellFromFile(storeNumber, filePath, options = {}) {
    const cfg = loadUpsellingConfig();
    const syncAll = options.allStores ?? isSyncAllStores(cfg);
    const syncDay = resolveUpsellSyncDayForRun(cfg, options);

    if (syncAll) {
        const multi = processMultiStoreReportFile(filePath, {
            ...options,
            syncDay,
            allStores: true,
        });
        finalizeMultiStoreSync(multi, {
            exportFile: path.basename(filePath),
            ok: true,
            reportDate: options.reportDate || 'regional',
        });
        maybeMarkBackfillComplete(syncDay, {
            storesUpdated: multi.storeNumbers,
            exportFile: path.basename(filePath),
            source: options.source || 'file',
        });
        return multi;
    }

    const store = String(storeNumber || '').trim();
    const result = processReportFile(filePath, store, options);
    writeLastSync({ exportFile: path.basename(filePath), ok: true, reportDate: options.reportDate || 'competition', storesUpdated: [store] });
    return result;
}

module.exports = {
    runUpsellMmxSync,
    runUpsellFromFile,
    navigateToBiReport,
    writeLastSync,
};
