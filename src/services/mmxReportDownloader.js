const path = require('path');
const fs = require('fs');
const { getStoreList, getStoreConfig } = require('./storeList');
const { openMacromatixBrowser, closeBrowserQuietly } = require('./macromatixScraper');
const { downloadReports, configureDownloadPath } = require('./mmxReports/pipeline-download-reports');
const { isSupplyChainReport } = require('./mmxReports/pipeline-supply-chain-reports');
const { splitSpreadsheetByStoreColumn, resolveStoreReports } = require('./reportReader');
const { ensureDir, timestampSlug } = require('./mmxReports/util-files');
const log = require('./mmxReports/util-logging');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const REPORTS_DIR = path.join(PROJECT_ROOT, 'Reports');
const PIPELINE_PATH = path.join(PROJECT_ROOT, 'config', 'reports-pipeline.json');

const DEFAULT_OUTPUT_BASENAMES = {
    report1: 'stock-on-hand',
    report2: 'stock-on-order',
    report3: 'inventory-special-event',
};

function loadPipelineConfig() {
    if (!fs.existsSync(PIPELINE_PATH)) {
        throw new Error(
            'Missing config/reports-pipeline.json — copy from config/reports-pipeline.json.example or pull from git.'
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
    return (pipeline.reports || []).map((report) => ({
        ...report,
        storeNumber: store.storeNumber,
        storeName: label,
        storeOptional: false,
        outputBasename: report.outputBasename || DEFAULT_OUTPUT_BASENAMES[report.id] || report.id,
    }));
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
    // SCM flat exports include every store — download once (no tree) and split by store column.
    return supplyChainReportsInRun(pipeline, onlyReportIds).length > 0;
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

function scmPerStoreFallbackEnabled(stores) {
    return stores.length === 1 || process.env.MMX_SCM_FALLBACK_PER_STORE === '1';
}

async function retryScmReportPerStore(page, pipeline, store, report, runSlug, storeDir) {
    const scmReport = {
        ...report,
        skipStoreSelection: false,
        storeName: storeSelectorLabel(store),
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
        const ready = Boolean(files.inventorySpecialEvent && files.stockOnHand);
        if (!ready) {
            entry.success = false;
            const missing = [];
            if (!files.stockOnHand) missing.push('stock-on-hand');
            if (!files.inventorySpecialEvent) missing.push('inventory-special-event');
            entry.missingReports = missing;
            log.error(`Store ${store.storeNumber}: missing ${missing.join(' and ')} in ${files.storeDir}`);
        }
    }
}

/**
 * Log into Macromatix and download the three build-to reports for each store in `.storelist`.
 * Full multi-store runs download on-hand + on-order once, then split by store column.
 * Single-store runs use the same bulk SCM download, then split rows into Reports/{store}/.
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
        throw new Error('No stores in .storelist — add stores before downloading reports.');
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

            if (scmPerStoreFallbackEnabled(stores) && bulkSplitMisses.length) {
                for (const { report, storeNum } of bulkSplitMisses) {
                    if (results.stores[storeNum]?.files[report.id]) continue;
                    const store = stores.find((s) => s.storeNumber === storeNum);
                    if (!store) continue;

                    log.info(
                        `Bulk split missed store ${storeNum} — retrying ${report.label || report.id} with per-store selection`
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

module.exports = {
    downloadReportsForStores,
    loadPipelineConfig,
    REPORTS_DIR,
    DEFAULT_OUTPUT_BASENAMES,
};
