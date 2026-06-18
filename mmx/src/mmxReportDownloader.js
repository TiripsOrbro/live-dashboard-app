const path = require('path');
const fs = require('fs');
const { getStoreList, getStoreConfig } = require('../../stores/src/storeList');
const { openMacromatixBrowser, closeBrowserQuietly } = require('./macromatixScraper');
const { downloadReports, configureDownloadPath } = require('./mmxReports/pipeline-download-reports');
const { isSupplyChainReport } = require('./mmxReports/pipeline-supply-chain-reports');
const { splitSpreadsheetByStoreColumn, resolveStoreReports } = require('../../vendors/src/reportReader');
const { ensureDir, timestampSlug } = require('./mmxReports/util-files');
const log = require('./mmxReports/util-logging');

const paths = require('../../src/paths');
const REPORTS_DIR = paths.vendors.reports;
const PIPELINE_PATH = path.join(paths.mmx.config, 'reports-pipeline.json');

const DEFAULT_OUTPUT_BASENAMES = {
    report1: 'stock-on-hand',
    report2: 'stock-on-order',
    report3: 'inventory-special-event',
};

function loadPipelineConfig() {
    if (!fs.existsSync(PIPELINE_PATH)) {
        throw new Error(
            'Missing config/reports-pipeline.json - copy from config/reports-pipeline.json.example or pull from git.'
        );
    }
    return JSON.parse(fs.readFileSync(PIPELINE_PATH, 'utf8'));
}

function storeSelectorLabel(store) {
    const num = String(store.storeNumber || '').trim();
    const name = String(store.storeName || '').trim();
    if (num && name) return `${num} ${name}`;
    return name || num;
}

function reportsForStore(pipeline, store) {
    const label = storeSelectorLabel(store);
    return (pipeline.reports || []).map((report) => {
        const scm = isSupplyChainReport(report);
        return {
            ...report,
            storeNumber: store.storeNumber,
            storeName: label,
            // SCM: check the store row in RadTreeView (input.rtChk / span.rtIn) before Generate.
            scmTreeStoreNumber: scm ? store.storeNumber : undefined,
            skipStoreSelection: !scm,
            storeOptional: false,
            outputBasename: report.outputBasename || DEFAULT_OUTPUT_BASENAMES[report.id] || report.id,
        };
    });
}

function buildSettings(pipeline, storeDir) {
    return {
        navTimeoutMs: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
        downloadWaitMs: Number(process.env.MMX_DOWNLOAD_WAIT_MS || 120000),
        reportDownloadDir: storeDir,
        pipeline,
    };
}

function supplyChainReportsInRun(pipeline, onlyReportIds) {
    let reports = (pipeline.reports || []).filter(isSupplyChainReport);
    if (onlyReportIds.length) {
        reports = reports.filter((r) => onlyReportIds.includes(r.id));
    }
    return reports;
}

function useBulkSupplyChainDownload(stores, onlyReportIds, pipeline) {
    if (process.env.MMX_BULK_SCM === '0') return false;
    const scmReports = supplyChainReportsInRun(pipeline, onlyReportIds);
    if (!scmReports.length) return false;
    // Single/few stores: check RadTreeView checkbox per store (not bulk split).
    const minStores = Number(process.env.MMX_BULK_SCM_MIN_STORES || 2);
    if (stores.length < minStores) {
        log.info(`SCM per-store tree selection for ${stores.length} store(s)`);
        return false;
    }
    return true;
}

function bulkSupplyChainReports(pipeline, onlyReportIds) {
    return supplyChainReportsInRun(pipeline, onlyReportIds).map((report) => ({
        ...report,
        skipStoreSelection: true,
        storeName: undefined,
        storeNumber: undefined,
        outputBasename: report.outputBasename || DEFAULT_OUTPUT_BASENAMES[report.id] || report.id,
    }));
}

function scmPerStoreFallbackEnabled() {
    return process.env.MMX_SCM_FALLBACK_PER_STORE !== '0';
}

async function retryScmReportPerStore(page, pipeline, store, report, runSlug, storeDir) {
    const label = storeSelectorLabel(store);
    const scmReport = {
        ...report,
        skipStoreSelection: false,
        scmTreeStoreNumber: store.storeNumber,
        storeName: label,
        storeNumber: store.storeNumber,
        outputBasename: report.outputBasename || DEFAULT_OUTPUT_BASENAMES[report.id] || report.id,
    };
    const storePipeline = {
        reportNavigation: pipeline.reportNavigation,
        reports: [scmReport],
    };
    const settings = buildSettings(storePipeline, storeDir);
    await configureDownloadPath(page, storeDir);
    const paths = await downloadReports(page, settings);
    let dest = paths[report.id];
    if (!dest) return null;

    const ext = path.extname(dest);
    const basename = scmReport.outputBasename;
    const target = path.join(storeDir, `${runSlug}-${basename}${ext}`);
    if (path.basename(dest) !== path.basename(target)) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        fs.renameSync(dest, target);
        dest = target;
    }
    return dest;
}

function finalizeStoreResults(results, stores) {
    for (const store of stores) {
        const entry = results.stores[store.storeNumber];
        const files = resolveStoreReports(store.storeNumber, REPORTS_DIR);
        const validation = require('../../vendors/src/reportReader').validateStoreReports(store.storeNumber, files);
        if (!validation.valid) {
            entry.success = false;
            entry.missingReports = validation.issues;
            log.error(`Store ${store.storeNumber}: ${validation.issues.join('; ')}`);
        }
    }
}

/**
 * Log into Macromatix and download the three build-to reports for each store in `.storelist`.
 * Full multi-store runs download on-hand + on-order once, then split by store column.
 * SCM flat reports skip MMX store tree; scope is applied via bulk split or post-download filter.
 * Files land in `Reports/{storeNumber}/` with timestamped names.
 */
async function downloadReportsForStores(options = {}) {
    const pipeline = loadPipelineConfig();
    const onlyReportIds = Array.isArray(options.onlyReportIds)
        ? options.onlyReportIds
        : String(options.onlyReports || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
    let stores = getStoreList();
    if (!stores.length) {
        throw new Error('No stores in .storelist - add stores before downloading reports.');
    }

    const only = String(options.storeNumber || '').trim();
    const onlyNumbers = Array.isArray(options.storeNumbers)
        ? options.storeNumbers.map((s) => String(s).trim()).filter(Boolean)
        : String(options.storeNumbers || '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

    if (onlyNumbers.length) {
        stores = stores.filter((s) => onlyNumbers.includes(s.storeNumber));
        for (const num of onlyNumbers) {
            if (!stores.some((s) => s.storeNumber === num)) {
                const cfg = getStoreConfig(num);
                if (cfg) stores.push(cfg);
            }
        }
        stores = [...new Map(stores.map((s) => [s.storeNumber, s])).values()];
        if (!stores.length) {
            throw new Error(`No matching stores in .storelist for: ${onlyNumbers.join(', ')}`);
        }
    } else if (only) {
        stores = stores.filter((s) => s.storeNumber === only);
        if (!stores.length) {
            const cfg = getStoreConfig(only);
            if (cfg) stores = [cfg];
            else throw new Error(`Store ${only} not found in .storelist`);
        }
    }

    const runSlug = timestampSlug();
    const results = { runSlug, reportsDir: REPORTS_DIR, bulkSupplyChain: false, stores: {} };
    const storeNumbers = stores.map((s) => s.storeNumber);
    const useBulk = useBulkSupplyChainDownload(stores, onlyReportIds, pipeline);

    for (const store of stores) {
        results.stores[store.storeNumber] = { success: true, files: {} };
    }

    let browser = options.browser || null;
    let ownsBrowser = false;
    let page = options.page || null;

    try {
        if (!page) {
            const session = await openMacromatixBrowser(options);
            browser = session.browser;
            page = session.page;
            ownsBrowser = true;
        }

        if (useBulk) {
            results.bulkSupplyChain = true;
            const bulkDir = path.join(REPORTS_DIR, '_bulk');
            ensureDir(bulkDir);

            const bulkReports = bulkSupplyChainReports(pipeline, onlyReportIds);
            const bulkPipeline = {
                reportNavigation: pipeline.reportNavigation,
                reports: bulkReports,
            };
            const bulkSettings = buildSettings(bulkPipeline, bulkDir);

            log.info(
                `Bulk supply-chain download (${bulkReports.map((r) => r.id).join(', ')}) for ${stores.length} stores`
            );

            await configureDownloadPath(page, bulkDir);
            const bulkPaths = await downloadReports(page, bulkSettings);
            const bulkSplitMisses = [];

            for (const report of bulkReports) {
                const sourcePath = bulkPaths[report.id];
                if (!sourcePath) continue;

                const split = splitSpreadsheetByStoreColumn(sourcePath, {
                    colIndex: 2,
                    storeNumbers,
                    runSlug,
                    outputBasename: report.outputBasename,
                    reportsRoot: REPORTS_DIR,
                });

                log.info(
                    `${report.label || report.id}: split ${split.totalRows} row(s) → ${Object.keys(split.stores).length} store file(s)` +
                        (split.storeColumnIndex != null ? ` (store column ${split.storeColumnIndex})` : '')
                );

                for (const [storeNum, info] of Object.entries(split.stores)) {
                    if (!results.stores[storeNum]) continue;
                    results.stores[storeNum].files[report.id] = info.path;
                    log.info(`  store ${storeNum}: ${info.kept} row(s) → ${path.basename(info.path)}`);
                }

                for (const storeNum of storeNumbers) {
                    if (!split.stores[storeNum]) {
                        bulkSplitMisses.push({ report, storeNum });
                        const inFile = (split.storesInFile || []).join(', ') || 'none';
                        const samples = (split.sampleRows || []).map((s) => `  ${s}`).join('\n');
                        const bulkFilterHint =
                            split.totalRows > 0 && split.totalRows < 300
                                ? '\n  Hint: Export looks area-filtered (~100 rows). Per-store SCM fallback will run when enabled.'
                                : '';
                        log.warn(
                            `${report.label || report.id}: no rows for store ${storeNum} in bulk export (stores in file: ${inFile})` +
                                (samples ? `\n${samples}` : '') +
                                bulkFilterHint
                        );
                    }
                }
            }

            if (scmPerStoreFallbackEnabled() && bulkSplitMisses.length) {
                for (const { report, storeNum } of bulkSplitMisses) {
                    if (results.stores[storeNum]?.files[report.id]) continue;
                    const store = stores.find((s) => s.storeNumber === storeNum);
                    if (!store) continue;

                    log.info(
                        `Bulk split missed store ${storeNum} - retrying ${report.label || report.id} with per-store selection`
                    );
                    const storeDir = path.join(REPORTS_DIR, storeNum);
                    ensureDir(storeDir);
                    try {
                        const dest = await retryScmReportPerStore(
                            page,
                            pipeline,
                            store,
                            report,
                            runSlug,
                            storeDir
                        );
                        if (dest) {
                            results.stores[storeNum].files[report.id] = dest;
                            log.info(`  store ${storeNum}: per-store SCM → ${path.basename(dest)}`);
                        }
                    } catch (err) {
                        log.error(`Per-store SCM fallback for ${storeNum} ${report.id}:`, err.message);
                    }
                }
            }
        }

        for (const store of stores) {
            const storeDir = path.join(REPORTS_DIR, store.storeNumber);
            ensureDir(storeDir);

            let reports = reportsForStore(pipeline, store);
            if (onlyReportIds.length) {
                reports = reports.filter((r) => onlyReportIds.includes(r.id));
            }
            if (useBulk) {
                reports = reports.filter((r) => !isSupplyChainReport(r));
            }
            if (!reports.length) continue;

            const storePipeline = {
                reportNavigation: pipeline.reportNavigation,
                reports,
            };
            const settings = buildSettings(storePipeline, storeDir);
            if (typeof options.onReportStep === 'function') {
                settings.onReportStep = options.onReportStep;
            }

            log.info(`Store ${store.storeNumber} (${store.storeName}) → ${storeDir}`);

            try {
                await configureDownloadPath(page, storeDir);
                const paths = await downloadReports(page, settings);
                results.stores[store.storeNumber].files = {
                    ...results.stores[store.storeNumber].files,
                    ...paths,
                };
            } catch (err) {
                log.error(`Store ${store.storeNumber} failed:`, err.message);
                results.stores[store.storeNumber].success = false;
                results.stores[store.storeNumber].error = err.message;
            }
        }
    } finally {
        if (ownsBrowser) {
            await closeBrowserQuietly(browser, 'report download');
        }
    }

    finalizeStoreResults(results, stores);
    return results;
}

function parallelReportDownloadEnabled(options = {}) {
    if (options.parallelReportDownload === false) return false;
    if (process.env.MMX_PARALLEL_BUILD_TO_REPORTS === '0') return false;
    if (options.afterCountApply) return true;
    if (options.parallelReportDownload === true) return true;
    if (Array.isArray(options.onlyReportIds) && options.onlyReportIds.length >= 2) return true;
    return process.env.MMX_PARALLEL_BUILD_TO_REPORTS === '1';
}

async function downloadOneBuildToReportForStore(store, reportId, options = {}) {
    const pipeline = loadPipelineConfig();
    const reports = reportsForStore(pipeline, store).filter((r) => r.id === reportId);
    if (!reports.length) {
        throw new Error(`Report ${reportId} is not configured in reports-pipeline.json`);
    }

    const report = reports[0];
    const storeDir =
        options.reportDownloadDir || path.join(REPORTS_DIR, store.storeNumber, '_parallel', reportId);
    ensureDir(storeDir);

    let browser;
    let page;
    const label = report.label || reportId;
    try {
        log.info(`[parallel] Store ${store.storeNumber}: opening browser for ${label}`);
        ({ browser, page } = await openMacromatixBrowser({ ...options, storeNumber: store.storeNumber }));
        const storePipeline = {
            reportNavigation: pipeline.reportNavigation,
            reports,
        };
        const settings = buildSettings(storePipeline, storeDir);
        settings.downloadWaitMs = Number(report.downloadWaitMs || settings.downloadWaitMs);
        settings.chainReports = false;
        if (typeof options.onReportStep === 'function') {
            settings.onReportStep = (step) => options.onReportStep(reportId, step);
        }
        await configureDownloadPath(page, storeDir);
        const paths = await downloadReports(page, settings);
        const filePath = paths[reportId];
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error(`${label} did not produce a file in ${storeDir}`);
        }
        log.info(`[parallel] Store ${store.storeNumber}: ${label} → ${path.basename(filePath)}`);
        return { reportId, filePath, storeDir };
    } finally {
        await closeBrowserQuietly(browser, `parallel ${reportId}`);
    }
}

function promoteParallelFile(mainDir, filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    ensureDir(mainDir);
    const dest = path.join(mainDir, path.basename(filePath));
    if (path.resolve(filePath) === path.resolve(dest)) return dest;
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    fs.copyFileSync(filePath, dest);
    return dest;
}

/**
 * Download ISE / SOH / SOO in parallel — one browser per report, isolated download folders.
 * Parent stock-count work should already hold the MMX MIC slot; each worker only opens a browser.
 */
async function downloadBuildToReportsParallel(storeNumber, options = {}) {
    const num = String(storeNumber).replace(/\D/g, '');
    const cfg = getStoreConfig(num);
    const store = cfg || { storeNumber: num, storeName: num };
    const onlyReportIds = Array.isArray(options.onlyReportIds) && options.onlyReportIds.length
        ? options.onlyReportIds
        : ['report1', 'report2', 'report3'];

    const mainDir = path.join(REPORTS_DIR, num);
    ensureDir(mainDir);

    log.info(
        `Store ${num}: parallel build-to download — ${onlyReportIds.length} browser(s) for ${onlyReportIds.join(', ')}`
    );

    const tasks = onlyReportIds.map((reportId) => {
        const workDir = path.join(mainDir, '_parallel', reportId);
        ensureDir(workDir);
        return downloadOneBuildToReportForStore(store, reportId, {
            ...options,
            reportDownloadDir: workDir,
        });
    });

    const settled = await Promise.allSettled(tasks);
    const files = {};
    const errors = [];
    for (let i = 0; i < settled.length; i++) {
        const reportId = onlyReportIds[i];
        const outcome = settled[i];
        if (outcome.status === 'fulfilled') {
            const promoted = promoteParallelFile(mainDir, outcome.value.filePath);
            if (promoted) files[reportId] = promoted;
        } else {
            errors.push(`${reportId}: ${outcome.reason?.message || outcome.reason}`);
        }
    }

    if (errors.length) {
        throw new Error(`Parallel report download failed for store ${num}: ${errors.join('; ')}`);
    }

    return { storeNumber: num, files, reportsDir: mainDir, parallel: true };
}

module.exports = {
    downloadReportsForStores,
    downloadBuildToReportsParallel,
    downloadOneBuildToReportForStore,
    loadPipelineConfig,
    REPORTS_DIR,
    DEFAULT_OUTPUT_BASENAMES,
    parallelReportDownloadEnabled,
};
