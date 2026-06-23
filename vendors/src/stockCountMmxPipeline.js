const path = require('path');
const { getStoreConfig } = require('../../stores/src/storeList');
const { getVendorCatalog } = require('./vendorCatalog');
const { isCombinedStockCountSlug, vendorSlugsFromPendingLabels } = require('./combinedStockCountCatalog');
const {
    getDraft,
    submitStockCount,
    markMmxSent,
    getMmxSentVendorSlugs,
    getSubmittedVendorSlugs,
    getStockCountQueueStatus,
    melbourneDateKey,
} = require('./stockCountState');
const {
    openMacromatixBrowser,
    closeBrowserQuietly,
    resolveStoreOnCurrentPage,
} = require('../../mmx/src/macromatixScraper');
const {
    enterCombinedStockCount,
    applyKeyItemCount,
    mergeVendorEntriesByLocation,
} = require('../../mmx/src/mmxReports/mmx-stock-count');
const { downloadReportsForStores, downloadBuildToReportsParallel, parallelReportDownloadEnabled } = require('../../mmx/src/mmxReportDownloader');
const { buildOrderLinesByVendorId } = require('./buildToOrderLines');
const { runVendorOrderEntry } = require('../../mmx/src/mmxReports/pipeline-enter-vendor-orders');
const { createSession, getSession, destroySession, destroySessionsForStore } = require('../../mmx/src/mmxCountSession');
require('../../dashboard/src/salesScrapeAbort');
const {
    PRIORITY,
    acquirePrioritySlot,
    releasePrioritySlot,
    getLocalHoldCount,
} = require('../../mmx/src/mmxTaskQueue');
const { refreshScrapePauseTimeout, isMmxResourceBusy } = require('../../mmx/src/mmxResourceGate');
const { setCheckpoint, getCheckpoint, clearCheckpoint, listAllCheckpoints } = require('../../mmx/src/mmxPipelineCheckpoint');

function touchStockCountWork() {
    refreshScrapePauseTimeout();
}

const STAGE_STEP_LABELS = {
    preparing: 'Opening Key Item Count in Macromatix',
    prepared: 'Variances ready for review',
    applying: 'Applying count in Macromatix',
    'applied-orders-pending': 'Preparing scheduled orders',
    'downloading-reports': 'Downloading stock reports',
    'checking-stock-levels': 'Checking stock levels',
    'filling-orders': 'Placing scheduled orders',
    completed: 'Complete',
    'prepare-failed': 'Key Item Count prepare failed',
    'apply-failed': 'Apply or orders failed',
    'check-levels-failed': 'Stock level check failed',
};

function defaultStepLabel(stage) {
    return STAGE_STEP_LABELS[stage] || 'Sending to Macromatix';
}

async function updateCheckpoint(storeNumber, patch) {
    const next = { ...patch };
    if (next.stage && !next.stepLabel) {
        next.stepLabel = defaultStepLabel(next.stage);
    }
    const checkpoint = await setCheckpoint(storeNumber, next);
    touchStockCountWork();
    return checkpoint;
}

async function touchPipelineStep(storeNumber, stepLabel) {
    if (!storeNumber || !stepLabel) return;
    await updateCheckpoint(storeNumber, { stepLabel: String(stepLabel).trim() });
}

async function beginStockCountMmxWork(reason, storeNumber) {
    await acquirePrioritySlot(PRIORITY.MIC, { type: 'mic-orders', label: reason });
    if (storeNumber) touchStockCountWork();
}

async function endStockCountMmxWork(storeNumber, reason) {
    void storeNumber;
    await releasePrioritySlot(PRIORITY.MIC, reason);
}

async function discardStockCountMmxWork(storeNumber, reason = 'discarded', options = {}) {
    await destroySessionsForStore(storeNumber, reason);
    await clearCheckpoint(storeNumber);
    if (options.releaseMicSlot !== false) {
        await endStockCountMmxWork(storeNumber, `prior MMX work ${reason} (store ${storeNumber})`);
    }
}

const { runStoreOrdersCompleteCleanup } = require('./storeOrdersCompleteCleanup');
const log = require('../../mmx/src/mmxReports/util-logging');
const runLockByStore = new Map();

function storeSelectorLabel(store) {
    const num = String(store.storeNumber || '').trim();
    const name = String(store.storeName || '').trim();
    if (num && name) return `${num} ${name}`;
    return name || num;
}

function withStoreMmxOptions(storeNumber, options = {}) {
    return { ...options, storeNumber: String(storeNumber).replace(/\D/g, '') };
}

/** Select the target store on the current MMX page (combo, report picker, or single-store session). */
async function selectStoreInMacromatix(page, storeNumber) {
    const picked = await resolveStoreOnCurrentPage(page, storeNumber, { optional: true });
    if (picked) {
        log.info(`Store selected: ${picked}`);
        return picked;
    }
    log.info(`Store ${storeNumber}: no store picker on this page - using current single-store session`);
    return String(storeNumber).replace(/\D/g, '');
}

async function withStoreLock(storeNumber, fn) {
    const key = String(storeNumber);
    const prev = runLockByStore.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    runLockByStore.set(key, prev.then(() => gate));
    await prev;
    try {
        return await fn();
    } finally {
        release();
        if (runLockByStore.get(key) === gate) runLockByStore.delete(key);
    }
}

async function shouldRunOrderPipeline(storeNumber, dateKey) {
    const submitted = await getSubmittedVendorSlugs(storeNumber, dateKey);
    if (!submitted.length) return false;
    const sent = await getMmxSentVendorSlugs(storeNumber, dateKey);
    return submitted.every((slug) => sent.includes(slug));
}

async function buildVendorEntries(storeNumber, toSend, dateKey) {
    const vendorEntries = [];
    for (const entry of toSend) {
        const catalog = getVendorCatalog(entry.slug, { forStockCount: true, storeNumber });
        if (!catalog) throw new Error(`Vendor catalog not found: ${entry.slug}`);

        const draft = await getDraft(storeNumber, entry.slug, dateKey);
        if (!draft?.locations || !Object.keys(draft.locations).length) {
            throw new Error(`No stock count draft for ${catalog.label}.`);
        }

        vendorEntries.push({
            slug: entry.slug,
            catalog,
            draftLocations: draft.locations,
        });
    }
    return vendorEntries;
}

/** Counted lines (qty > 0) that must be entered on Macromatix Key Item Count. */
function countKeyItemCountLines(vendorEntries) {
    const byLocation = mergeVendorEntriesByLocation(vendorEntries);
    let n = 0;
    for (const items of byLocation.values()) n += items.length;
    return { locationCount: byLocation.size, lineCount: n };
}

/** True when submitted draft has at least one counted item that goes on Key Item Count. */
function vendorEntriesNeedKeyItemCount(vendorEntries) {
    return countKeyItemCountLines(vendorEntries).lineCount > 0;
}

function logStockCountMmxPlan(storeNumber, vendorEntries) {
    const { locationCount, lineCount } = countKeyItemCountLines(vendorEntries);
    if (lineCount === 0) {
        log.info(
            `Store ${storeNumber}: submitted counts are manual / supplies / oh-only only (${lineCount} Key Item Count lines) - skipping Key Item Count screen`
        );
    } else {
        log.info(
            `Store ${storeNumber}: ${lineCount} Key Item Count line(s) in ${locationCount} location(s) - opening Key Item Count`
        );
    }
}

/** Read drafts and report whether Send to MMX needs the Key Item Count UI (no browser). */
async function getStockCountSendPlan(storeNumber, vendorSlug, options = {}) {
    const dateKey = options.dateKey || melbourneDateKey();
    const queueStatus = await getStockCountQueueStatus(storeNumber, {
        dateKey,
        vendorSlug,
        pendingVendorLabels: options.pendingVendorLabels,
    });
    const submitted = (queueStatus.queue || []).filter((entry) => entry.submittedAt);
    if (!submitted.length) {
        return {
            success: true,
            storeNumber: String(storeNumber),
            canSendToMmx: false,
            needsKeyItemCount: false,
            manualOnly: false,
            submittedVendors: [],
        };
    }
    const toSend = submitted.map((entry) => ({ slug: entry.slug }));
    const vendorEntries = await buildVendorEntries(storeNumber, toSend, dateKey);
    const { lineCount, locationCount } = countKeyItemCountLines(vendorEntries);
    const needsKeyItemCount = lineCount > 0;
    return {
        success: true,
        storeNumber: String(storeNumber),
        dateKey,
        canSendToMmx: Boolean(queueStatus.canSendToMmx),
        needsKeyItemCount,
        manualOnly: !needsKeyItemCount,
        keyItemCountLineCount: lineCount,
        keyItemCountLocationCount: locationCount,
        submittedVendors: submitted.map((e) => e.slug),
    };
}

/**
 * Submitted counts are manual / manual= only - skip KIC, use counts for scheduled orders.
 */
async function runOrdersFromManualCountsOnly(storeNumber, toSend, dateKey, options = {}) {
    for (const row of toSend) {
        await markMmxSent(storeNumber, row.slug, dateKey);
    }

    await beginStockCountMmxWork(`manual counts → orders (store ${storeNumber})`, storeNumber);
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser(withStoreMmxOptions(storeNumber, options)));
        log.info(
            `Store ${storeNumber}: manual-only stock count - skipping Key Item Count; downloading ISE, SOH, and SOO, then filling scheduled orders from app counts`
        );
        await updateCheckpoint(storeNumber, {
            stage: 'downloading-reports',
            stepLabel: 'Downloading stock reports (inventory, on-hand, on-order)',
            dateKey,
            vendorSlugs: toSend.map((row) => row.slug),
            lastError: '',
        });
        const cycle = await runStoreBuildToCycle(storeNumber, {
            ...options,
            dateKey,
            page,
            browser,
            skipReportDownload: false,
            cleanupReports: options.cleanupReports !== false,
        });
        const orders = cycle.orders;
        if (ordersAllSuccessful(orders)) {
            await runStoreOrdersCompleteCleanup(storeNumber, dateKey);
        }
        const orderFailures = formatOrderFailures(orders);
        if (orderFailures) {
            log.warn(`Store ${storeNumber} scheduled order failures: ${orderFailures}`);
        }
        await clearCheckpoint(storeNumber);
        return {
            success: true,
            keyItemCountSkipped: true,
            sessionId: null,
            storeNumber: String(storeNumber),
            dateKey,
            variances: [],
            redVarianceCount: 0,
            vendorsSent: toSend.map((row) => row.slug),
            ordersRan: true,
            reportsDownloaded: true,
            orders,
            orderFailures: orderFailures || null,
        };
    } finally {
        await closeBrowserQuietly(browser, 'manual counts orders');
        await endStockCountMmxWork(storeNumber, `manual counts orders finished (store ${storeNumber})`);
    }
}

async function resolveToSend(storeNumber, vendorSlug, options = {}) {
    const dateKey = options.dateKey || melbourneDateKey();
    const queueStatus = await getStockCountQueueStatus(storeNumber, {
        dateKey,
        vendorSlug,
        pendingVendorLabels: options.pendingVendorLabels,
    });

    if (!queueStatus.canSendToMmx) {
        throw new Error('Submit at least one vendor count before sending to Macromatix.');
    }

    if (isCombinedStockCountSlug(vendorSlug)) {
        const slugs = vendorSlugsFromPendingLabels(options.pendingVendorLabels);
        for (const slug of slugs) {
            const vendorDraft = await getDraft(storeNumber, slug, dateKey);
            if (
                vendorDraft?.locations &&
                Object.keys(vendorDraft.locations).length &&
                !vendorDraft.submittedAt
            ) {
                await submitStockCount(storeNumber, slug, dateKey);
            }
        }
    } else {
        const triggerDraft = await getDraft(storeNumber, vendorSlug, dateKey);
        if (triggerDraft?.locations && Object.keys(triggerDraft.locations).length && !triggerDraft.submittedAt) {
            await submitStockCount(storeNumber, vendorSlug, dateKey);
        }
    }

    const toSend = queueStatus.queue.filter((entry) => entry.submittedAt);
    if (!toSend.length) {
        throw new Error('No submitted vendor counts ready to send to Macromatix.');
    }

    return { dateKey, toSend };
}

async function runVendorOrdersForStore(page, storeNumber, dateKey, orderPack = null) {
    const storeCfg = getStoreConfig(storeNumber) || { storeNumber, storeName: storeNumber };
    const storeLabel = storeSelectorLabel(storeCfg);

    const pack =
        orderPack ||
        (await buildOrderLinesByVendorId(storeNumber, {
            dateKey,
        }));
    const { byVendorId, vendorOrdersCfg, buildTo } = pack;

    const selectStore = async (p, num) => selectStoreInMacromatix(p, num);

    const settings = {
        navTimeoutMs: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
        vendorOrders: vendorOrdersCfg,
        storeNumber,
        storeName: storeLabel,
        storeContext: {
            storeNumber,
            storeName: storeLabel,
            selectStore: async (p) => selectStore(p, storeNumber),
        },
        orderLinesByVendorId: byVendorId,
        onOrderStep: (label) => touchPipelineStep(storeNumber, label),
    };

    log.info(`Store ${storeNumber}: scheduled order entry only - no report downloads or other MMX tasks`);
    const orderPipelineResult = await runVendorOrderEntry(page, settings, { continueOnError: true });
    orderPipelineResult.buildToSummary = {
        orderLineCount: buildTo.orderLines.length,
        totalCartons: buildTo.orderLines.reduce((s, l) => s + l.orderQty, 0),
    };
    return orderPipelineResult;
}

function ordersAllSuccessful(orderPipelineResult) {
    const processed = orderPipelineResult?.processed;
    return Array.isArray(processed) && processed.length > 0 && processed.every((p) => p && p.ok);
}

function formatOrderFailures(orderPipelineResult) {
    const failed = (orderPipelineResult?.processed || []).filter((p) => p && !p.ok);
    if (!failed.length) return '';
    return failed.map((f) => `${f.label}: ${f.error || 'failed'}`).join('; ');
}

async function ensureReportsForOrders(storeNumber, options = {}) {
    touchStockCountWork();
    const { REPORTS_DIR } = require('./buildToCalculator');
    const {
        reportIdsNeedingDownload,
        reportsReadyForReportIds,
        resolveStoreReports,
    } = require('./reportReader');
    const reportsDir = options.reportsDir || REPORTS_DIR;
    const allReportIds = ['report1', 'report2', 'report3'];
    const targetReportIds = Array.isArray(options.onlyReportIds) && options.onlyReportIds.length
        ? options.onlyReportIds.filter((id) => allReportIds.includes(id))
        : allReportIds;
    const idsToDownload = reportIdsNeedingDownload(storeNumber, targetReportIds, reportsDir, {
        forceDownload: Boolean(options.forceDownload),
        dateKey: options.dateKey,
    });

    if (!idsToDownload.length) {
        log.info(`Reports already valid for store ${storeNumber} - skipping download (${targetReportIds.join(', ')})`);
        return;
    }

    const labelForIds = {
        report1: 'Stock On Hand',
        report2: 'Stock On Order',
        report3: 'Inventory Special Event',
    };
    const downloadLabels = idsToDownload.map((id) => labelForIds[id] || id).join(', ');
    await updateCheckpoint(storeNumber, {
        stage: 'downloading-reports',
        stepLabel: `Downloading build-to reports - ${downloadLabels}`,
    });

    const { ready, validation } = reportsReadyForReportIds(storeNumber, targetReportIds, reportsDir);
    if (!ready && validation?.issues?.length && !options.forceDownload) {
        log.info(`Reports need refresh for store ${storeNumber}: ${validation.issues.join('; ')}`);
    }

    const downloadOpts = {
        storeNumber,
        reportsDir: options.reportsDir,
        onlyReportIds: idsToDownload,
        afterCountApply: Boolean(options.afterCountApply),
        parallelReportDownload: options.parallelReportDownload,
    };
    const mmxOpts = withStoreMmxOptions(storeNumber, options);
    const useParallel =
        parallelReportDownloadEnabled(downloadOpts) &&
        (idsToDownload.length >= 2 || downloadOpts.parallelReportDownload || downloadOpts.forceDownload);

    if (useParallel) {
        log.info(
            options.forceDownload
                ? `Re-downloading ${idsToDownload.join(', ')} for store ${storeNumber} (${idsToDownload.length} parallel browsers)`
                : `Reports missing for store ${storeNumber} - downloading ${idsToDownload.join(', ')} in ${idsToDownload.length} parallel browsers`
        );
        await downloadBuildToReportsParallel(storeNumber, {
            ...mmxOpts,
            ...downloadOpts,
            onReportStep: (reportId, label) =>
                touchPipelineStep(storeNumber, `${labelForIds[reportId] || reportId}: ${label}`),
        });
    } else if (options.page) {
        log.info(
            options.forceDownload
                ? `Re-downloading ${idsToDownload.join(', ')} for store ${storeNumber} (current MMX session)`
                : `Reports missing for store ${storeNumber} - downloading ${idsToDownload.join(', ')} via current MMX session`
        );
        await downloadReportsForStores({
            ...downloadOpts,
            ...mmxOpts,
            page: options.page,
            browser: options.browser || null,
            onReportStep: (label) => touchPipelineStep(storeNumber, label),
        });
    } else {
        log.info(
            options.forceDownload
                ? `Re-downloading ${idsToDownload.join(', ')} for store ${storeNumber}`
                : `Reports missing for store ${storeNumber} - downloading ${idsToDownload.join(', ')} in a separate browser pass`
        );
        let browser;
        let page;
        try {
            ({ browser, page } = await openMacromatixBrowser(mmxOpts));
            await downloadReportsForStores({
                ...downloadOpts,
                ...mmxOpts,
                page,
                browser,
                onReportStep: (label) => touchPipelineStep(storeNumber, label),
            });
        } finally {
            await closeBrowserQuietly(browser, 'pre-order report download');
        }
    }

    const { normalizeMacromatixExportsForStore } = require('../../mmx/src/mmxReports/pipeline-download-reports');
    const storeReportDir = path.join(reportsDir, String(storeNumber));
    const adopted = normalizeMacromatixExportsForStore(storeReportDir, idsToDownload, { storeNumber });
    if (Object.keys(adopted).length) {
        log.info(
            `Store ${storeNumber}: adopted Macromatix default export(s) → ${Object.entries(adopted)
                .map(([id, filePath]) => `${id}=${path.basename(filePath)}`)
                .join(', ')}`
        );
    }

    const after = reportsReadyForReportIds(storeNumber, targetReportIds, reportsDir);
    if (!after.ready) {
        const detail = after.issues?.length
            ? after.issues.join('; ')
            : 'inventory-special-event, stock-on-hand, and stock-on-order required';
        throw new Error(
            `Report download did not produce valid reports in ${after.files.storeDir}: ${detail}`
        );
    }
    const { loadPipelineConfig } = require('../../mmx/src/mmxReportDownloader');
    const { resolveReportDate } = require('../../mmx/src/mmxReports/util-dates');
    const pipeline = loadPipelineConfig();
    const sohCfg = pipeline.reports.find((r) => r.id === 'report1');
    const sohStart = sohCfg
        ? resolveReportDate(sohCfg.startDate || 'tomorrow', {
              timeZone: sohCfg.timeZone,
              dateOnly: false,
          })
        : '';
    const files = resolveStoreReports(storeNumber, reportsDir);
    log.info(
        `Reports ready for store ${storeNumber}: ISE=${path.basename(files.inventorySpecialEvent || '')}, SOH=${path.basename(files.stockOnHand || '')} (MMX start ${sohStart || '-'}), SOO=${path.basename(files.stockOnOrder || '')}`
    );
    const { writeStoreReportManifest } = require('./reportReader');
    writeStoreReportManifest(storeNumber, reportsDir, {
        storeNumber: String(storeNumber),
        sohStartDate: sohStart,
        ise: path.basename(files.inventorySpecialEvent || ''),
        soh: path.basename(files.stockOnHand || ''),
        soo: path.basename(files.stockOnOrder || ''),
    });
}

/** @deprecated Prefer ensureReportsForOrders */
async function ensureReportsOnDisk(storeNumber, options = {}) {
    return ensureReportsForOrders(storeNumber, options);
}

/**
 * Download ISE + SOH + SOO → build order qty (incl. on-order) → fill MMX → delete report files.
 * Reuses the post-apply browser session when `page` is provided.
 */
async function runStoreBuildToCycle(storeNumber, options = {}) {
    const {
        clearStoreReportFiles,
        clearStoreReportFilesByReportIds,
        validateStoreReports,
        validateReportId,
        resolveStoreReports,
        describeResolvedStoreReports,
        reportsReadyForStore,
    } = require('./reportReader');
    const { REPORTS_DIR, calculateBuildToOrders } = require('./buildToCalculator');
    const { computeLowStockAlerts } = require('./lowStockAlerts');
    const reportsDir = options.reportsDir || REPORTS_DIR;
    const dateKey = options.dateKey || melbourneDateKey();
    const afterCountApply = Boolean(options.afterCountApply);
    const allReportIds = ['report1', 'report2', 'report3'];
    let refreshReportIds = afterCountApply ? ['report1', 'report2'] : allReportIds;
    if (afterCountApply) {
        const preFiles = resolveStoreReports(storeNumber, reportsDir);
        const iseIssues = validateReportId(storeNumber, preFiles, 'report3', { dateKey });
        if (iseIssues.length) {
            refreshReportIds = [...refreshReportIds, 'report3'];
            log.info(
                `Store ${storeNumber}: ISE not reusable (${iseIssues.join('; ')}) — will download inventory-special-event`
            );
        }
    }
    const preReady = reportsReadyForStore(storeNumber, reportsDir);
    const skipDownload = options.requireAllReports
        ? false
        : Boolean(options.skipReportDownload) ||
          (!afterCountApply && !options.forceReportDownload && preReady.ready);
    const cleanup = options.cleanupReports !== false;
    const page = options.page;

    if (!skipDownload) {
        if (afterCountApply) {
            const { removed } = clearStoreReportFilesByReportIds(storeNumber, reportsDir, refreshReportIds);
            if (removed.length) {
                log.info(
                    `Build-to cycle: cleared ${removed.length} SOH/SOO file(s) for store ${storeNumber} (keeping ISE if present)`
                );
            }
        } else if (!preReady.ready || options.forceReportDownload) {
            const { removed } = clearStoreReportFiles(storeNumber, reportsDir);
            if (removed.length) {
                log.info(
                    `Build-to cycle: cleared ${removed.length} old report file(s) for store ${storeNumber}`
                );
            }
        }
    }

    let cycleSucceeded = false;
    try {
        if (!skipDownload) {
            if (afterCountApply) {
                const iseReuse = refreshReportIds.includes('report3')
                    ? 'downloading ISE'
                    : 'reusing ISE';
                log.info(
                    `Store ${storeNumber}: refreshing SOH + SOO after count apply (${iseReuse})`
                );
            } else if (!preReady.ready) {
                log.info(
                    `Store ${storeNumber}: downloading build-to reports (ISE, stock-on-hand, stock-on-order)`
                );
            }
            await ensureReportsForOrders(storeNumber, {
                page: options.page,
                browser: options.browser,
                reportsDir,
                onlyReportIds: refreshReportIds,
                forceDownload: Boolean(options.forceReportDownload),
                dateKey,
                afterCountApply,
            });
            await touchPipelineStep(
                storeNumber,
                'All build-to reports downloaded - calculating order quantities'
            );
        } else {
            const files = resolveStoreReports(storeNumber, reportsDir);
            const validation = validateStoreReports(storeNumber, files);
            if (!validation.valid) {
                throw new Error(
                    `Cannot fill orders for store ${storeNumber}: ${validation.issues.join('; ')}`
                );
            }
            const names = describeResolvedStoreReports(files);
            log.info(
                `Build-to cycle (no download): ISE=${names.inventorySpecialEvent}, SOH=${names.stockOnHand}, SOO=${names.stockOnOrder}`
            );
        }

        const buildToOpts = {
            reportsDir,
            dateKey,
            noOrderRounding: options.noOrderRounding,
            preferReportOnHand: true,
        };
        const buildTo = await calculateBuildToOrders(storeNumber, buildToOpts);
        const lowStockAlerts = computeLowStockAlerts(buildTo.lines || [], { storeNumber });
        if (lowStockAlerts.length) {
            await updateCheckpoint(storeNumber, {
                lowStockAlerts,
                lowStockCount: lowStockAlerts.length,
            });
            log.info(
                `Store ${storeNumber}: ${lowStockAlerts.length} item(s) below stock warning threshold`
            );
            const { invalidateLowStockSummaryCache } = require('./lowStockAlerts');
            invalidateLowStockSummaryCache(storeNumber);
        }
        const onOrderLines = (buildTo.lines || []).filter((l) => Number(l.onOrderCartons) > 0);
        log.info(
            `Build-to for store ${storeNumber}: ${buildTo.lines?.length || 0} ISE line(s), ${onOrderLines.length} with on-order deducted`
        );
        for (const auditCode of ['37876', '37909']) {
            const line = (buildTo.lines || []).find(
                (l) =>
                    String(l.iseItemCode || l.itemCode || '') === auditCode ||
                    String(l.itemCode || '') === auditCode
            );
            if (line) {
                log.info(
                    `Build-to audit ${storeNumber} ${line.iseItemCode || line.itemCode}: avg=${line.avgDaily} buildTo=${line.buildTo} onHand=${line.onHandCartons} order=${line.orderQty}`
                );
            }
        }
        log.info(
            `On-hand sources: ${buildTo.onHandFromReportCount || 0} from SOH report (${buildTo.reportFiles?.stockOnHand ? path.basename(buildTo.reportFiles.stockOnHand) : 'missing'}), ${buildTo.onHandFromManualCount || 0} from stock-count (ignored in this cycle)`
        );

        const orderPack = await buildOrderLinesByVendorId(storeNumber, buildToOpts);
        const dryManual = (orderPack.byVendorId['americold-dry']?.buildToEntries || []).filter(
            (e) => e.buildToSource === 'count-manual'
        );
        if (dryManual.length) {
            log.info(
                `Store ${storeNumber} manual= dry orders: ${dryManual
                    .map((e) => `${e.catalogItemCode || e.iseItemCode}=${e.orderQty}`)
                    .join(', ')}`
            );
        } else {
            log.warn(
                `Store ${storeNumber}: no manual= dry order lines - check stock count draft for ${dateKey}`
            );
        }

        if (options.dryRun) {
            cycleSucceeded = true;
            return { dryRun: true, dateKey, buildTo, orderPack, lowStockAlerts };
        }
        if (!page) {
            throw new Error('runStoreBuildToCycle requires an active MMX page to fill scheduled orders');
        }

        await updateCheckpoint(storeNumber, {
            stage: 'filling-orders',
            stepLabel: 'Placing scheduled orders in Macromatix',
        });
        const orders = await runVendorOrdersForStore(page, storeNumber, dateKey, orderPack);
        cycleSucceeded = true;
        return { dateKey, buildTo, orderPack, orders, lowStockAlerts };
    } finally {
        if (cleanup && cycleSucceeded) {
            const { removed } = clearStoreReportFiles(storeNumber, reportsDir);
            log.info(
                `Build-to cycle: removed ${removed.length} report file(s) from Reports/${storeNumber}/ after successful run`
            );
        } else if (cleanup && !cycleSucceeded) {
            log.warn(
                `Build-to cycle failed for store ${storeNumber} - report files left in Reports/${storeNumber}/ for retry`
            );
        }
    }
}

async function runOrdersAfterApply(storeNumber, dateKey, mmx = {}) {
    const page = mmx?.page ?? mmx;
    const result = await runStoreBuildToCycle(storeNumber, {
        dateKey,
        page,
        browser: mmx?.browser,
        reportsDir: mmx.reportsDir,
        noOrderRounding: mmx.noOrderRounding,
        skipReportDownload: false,
        afterCountApply: true,
        cleanupReports: true,
    });
    return result.orders;
}

async function resumeScheduledOrdersInNewBrowser(storeNumber, dateKey, options = {}) {
    await beginStockCountMmxWork(`resume scheduled orders (store ${storeNumber})`, storeNumber);
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser(withStoreMmxOptions(storeNumber, options)));
        const orders = await runOrdersAfterApply(storeNumber, dateKey, { page, browser });
        const orderFailures = formatOrderFailures(orders);
        return { orders, orderFailures };
    } finally {
        await closeBrowserQuietly(browser, 'resume scheduled orders');
        await endStockCountMmxWork(storeNumber, `resume scheduled orders finished (store ${storeNumber})`);
    }
}

function allVendorsMarkedMmxSent(vendorSlugs, sentSlugs) {
    const sent = new Set(sentSlugs || []);
    return vendorSlugs.length > 0 && vendorSlugs.every((slug) => sent.has(slug));
}

/**
 * Full build-to cycle: clear old reports → download ISE/SOH/SOO → fill MMX → delete reports.
 * Pass skipReportDownload to use on-disk reports only (still requires valid ISE+SOH+SOO).
 */
async function runScheduledOrdersOnly(storeNumber, options = {}) {
    return withStoreLock(storeNumber, async () => {
        await beginStockCountMmxWork(`scheduled orders (store ${storeNumber})`, storeNumber);
        const dateKey = options.dateKey || melbourneDateKey();
        let browser;
        let page;
        try {
            ({ browser, page } = await openMacromatixBrowser(withStoreMmxOptions(storeNumber, options)));
            log.info(`Build-to cycle for store ${storeNumber} - download 3 reports, fill orders, clear reports`);
            const cycle = await runStoreBuildToCycle(storeNumber, {
                ...options,
                dateKey,
                page,
                browser,
                cleanupReports: options.cleanupReports !== false,
            });
            const orders = cycle.orders;
            if (ordersAllSuccessful(orders)) {
                await runStoreOrdersCompleteCleanup(storeNumber, dateKey);
            }
            const orderFailures = formatOrderFailures(orders);
            if (orderFailures) {
                log.warn(`Store ${storeNumber} scheduled order failures: ${orderFailures}`);
            }
            return {
                success: true,
                storeNumber: String(storeNumber),
                dateKey,
                ordersRan: true,
                orders,
                orderFailures: orderFailures || null,
                skippedReportDownload: Boolean(options.skipReportDownload),
            };
        } finally {
            await closeBrowserQuietly(browser, 'scheduled orders only');
            await endStockCountMmxWork(storeNumber, `scheduled orders finished (store ${storeNumber})`);
        }
    });
}

/**
 * Fill Macromatix Key Item Count, continue to confirm screen, return red variances.
 * Keeps browser session open for user review.
 */
async function prepareStockCountForMmx(storeNumber, vendorSlug, options = {}) {
    return withStoreLock(storeNumber, async () => {
        const { dateKey, toSend } = await resolveToSend(storeNumber, vendorSlug, options);
        const vendorEntries = await buildVendorEntries(storeNumber, toSend, dateKey);
        logStockCountMmxPlan(storeNumber, vendorEntries);

        await beginStockCountMmxWork(`stock count prepare (store ${storeNumber})`, storeNumber);
        await discardStockCountMmxWork(storeNumber, 'replaced', { releaseMicSlot: false });

        if (!vendorEntriesNeedKeyItemCount(vendorEntries)) {
            return runOrdersFromManualCountsOnly(storeNumber, toSend, dateKey, options);
        }

        await updateCheckpoint(storeNumber, {
            stage: 'preparing',
            dateKey,
            vendorSlugs: toSend.map((row) => row.slug),
            lastError: '',
            sessionId: null,
        });

        let sessionStarted = false;

        let browser;
        let page;
        try {
            ({ browser, page } = await openMacromatixBrowser(withStoreMmxOptions(storeNumber, options)));

            const selectStore = async (p, num) => {
                await selectStoreInMacromatix(p, num);
            };

            const vendorLabels = vendorEntries.map((e) => e.catalog.label).join(', ');
            log.info(`Preparing combined Key Item Count for store ${storeNumber}: ${vendorLabels}`);

            const onPipelineStep = (label) => touchPipelineStep(storeNumber, label);
            const stockCountResult = await enterCombinedStockCount(page, {
                storeNumber,
                vendorEntries,
                navTimeoutMs: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
                selectStore,
                stopAtConfirm: true,
                onPipelineStep,
            });

            const redVariances = stockCountResult.variances || [];
            const session = await createSession({
                storeNumber,
                dateKey,
                vendorSlugs: toSend.map((row) => row.slug),
                browser,
                page,
                variances: redVariances,
            });
            sessionStarted = true;

            if (!redVariances.length) {
                log.info(
                    `Store ${storeNumber}: no red variances - applying count and filling scheduled orders in one run`
                );
                const applyResult = await applyStockCountSessionWork(storeNumber, session.sessionId, {
                    ...options,
                    _withinStoreLock: true,
                });
                browser = null;
                page = null;
                return {
                    success: true,
                    autoApplied: true,
                    sessionId: null,
                    storeNumber: String(storeNumber),
                    dateKey,
                    variances: [],
                    redVarianceCount: 0,
                    vendorsSent: toSend.map((row) => row.slug),
                    stockCount: stockCountResult,
                    ordersRan: Boolean(applyResult.ordersRan),
                    orders: applyResult.orders,
                    orderFailures: applyResult.orderFailures || null,
                };
            }

            await updateCheckpoint(storeNumber, {
                stage: 'prepared',
                dateKey,
                sessionId: session.sessionId,
                vendorSlugs: toSend.map((row) => row.slug),
                lastError: '',
            });

            browser = null;
            page = null;

            return {
                success: true,
                sessionId: session.sessionId,
                storeNumber: String(storeNumber),
                dateKey,
                variances: session.variances,
                redVarianceCount: session.variances.length,
                vendorsSent: toSend.map((row) => row.slug),
                stockCount: stockCountResult,
            };
        } catch (error) {
            await closeBrowserQuietly(browser, 'mmx count prepare failed');
            if (!sessionStarted) {
                await updateCheckpoint(storeNumber, {
                    stage: 'prepare-failed',
                    dateKey,
                    vendorSlugs: toSend.map((row) => row.slug),
                    lastError: error.message || String(error),
                    sessionId: null,
                }).catch(() => {});
            }
            throw error;
        } finally {
            if (!sessionStarted) {
                await endStockCountMmxWork(storeNumber, `stock count prepare ended without session (store ${storeNumber})`);
            }
        }
    });
}

const PIPELINE_IN_PROGRESS_STAGES = new Set([
    'preparing',
    'prepared',
    'applying',
    'applied-orders-pending',
    'downloading-reports',
    'checking-stock-levels',
    'filling-orders',
]);

const PIPELINE_ACTIVE_WORK_STAGES = new Set([
    'preparing',
    'applying',
    'applied-orders-pending',
    'downloading-reports',
    'checking-stock-levels',
    'filling-orders',
]);

/** Active MMX work must hold the resource gate; if not, the checkpoint is stale after this grace. */
const PIPELINE_ACTIVE_STALE_MS = Number(process.env.MMX_PIPELINE_ACTIVE_STALE_MS || 90 * 1000);

function checkpointAgeMs(checkpoint) {
    if (!checkpoint?.updatedAt) return Number.POSITIVE_INFINITY;
    const updated = new Date(checkpoint.updatedAt).getTime();
    if (!Number.isFinite(updated)) return Number.POSITIVE_INFINITY;
    return Math.max(0, Date.now() - updated);
}

function preparedCheckpointHasLiveSession(storeNumber, checkpoint) {
    if (!checkpoint?.sessionId || checkpoint.stage !== 'prepared') return false;
    return Boolean(getSession(storeNumber, checkpoint.sessionId));
}

function isCheckpointStale(storeNumber, checkpoint, { onStartup = false } = {}) {
    if (!checkpoint?.stage) return false;
    const stage = checkpoint.stage;

    if (stage === 'prepared') {
        return !preparedCheckpointHasLiveSession(storeNumber, checkpoint);
    }

    if (!PIPELINE_ACTIVE_WORK_STAGES.has(stage)) return false;

    if (isMmxResourceBusy()) return false;
    if (onStartup) return true;
    return checkpointAgeMs(checkpoint) >= PIPELINE_ACTIVE_STALE_MS;
}

async function clearStaleCheckpoint(storeNumber, checkpoint, reason) {
    console.log(
        `[StockCount] Clearing stale pipeline checkpoint - store ${storeNumber} stage ${checkpoint?.stage || 'unknown'} (${reason})`
    );
    await destroySessionsForStore(storeNumber, 'stale-checkpoint');
    await clearCheckpoint(storeNumber);
    await endStockCountMmxWork(storeNumber, `stale checkpoint (${reason})`);
}

async function reconcileStaleCheckpoint(storeNumber) {
    const checkpoint = await getCheckpoint(storeNumber);
    if (!checkpoint || !isCheckpointStale(storeNumber, checkpoint)) return checkpoint;
    await clearStaleCheckpoint(storeNumber, checkpoint, 'no live MMX work');
    return null;
}

function pipelineWorkIsLive(storeNumber, checkpoint) {
    if (!checkpoint?.stage) return false;
    const stage = checkpoint.stage;
    if (stage === 'prepared') {
        return preparedCheckpointHasLiveSession(storeNumber, checkpoint);
    }
    if (PIPELINE_ACTIVE_WORK_STAGES.has(stage)) {
        return isMmxResourceBusy();
    }
    return false;
}

async function resetStalePipelineCheckpointsOnStartup() {
    const stores = await listAllCheckpoints();
    const keys = Object.keys(stores);
    if (!keys.length) return 0;

    let cleared = 0;
    for (const storeNumber of keys) {
        const checkpoint = stores[storeNumber];
        if (!checkpoint || !isCheckpointStale(storeNumber, checkpoint, { onStartup: true })) continue;
        await clearStaleCheckpoint(storeNumber, checkpoint, 'server restart');
        cleared++;
    }
    if (cleared) {
        console.log(`[StockCount] Cleared ${cleared} stale MMX pipeline checkpoint(s) after startup`);
    }
    return cleared;
}

async function stockCountMmxOrdersComplete(storeNumber, dateKey = melbourneDateKey()) {
    const submitted = await getSubmittedVendorSlugs(storeNumber, dateKey);
    if (!submitted.length) return false;
    const sent = await getMmxSentVendorSlugs(storeNumber, dateKey);
    return submitted.every((slug) => sent.includes(slug));
}

async function getStockCountPipelineStatus(storeNumber) {
    const checkpoint = await reconcileStaleCheckpoint(storeNumber);
    const stage = checkpoint?.stage || 'idle';
    const sessionId = checkpoint?.sessionId || null;
    const dateKey = checkpoint?.dateKey || melbourneDateKey();
    const workLive = pipelineWorkIsLive(storeNumber, checkpoint);
    const payload = {
        success: true,
        storeNumber: String(storeNumber),
        stage,
        inProgress: PIPELINE_IN_PROGRESS_STAGES.has(stage),
        workLive,
        ordersComplete: stage === 'completed',
        lastError: checkpoint?.lastError || null,
        failedAtStep: checkpoint?.failedAtStep || null,
        stepLabel: checkpoint?.stepLabel || defaultStepLabel(stage),
        dateKey,
        sessionId,
        updatedAt: checkpoint?.updatedAt || null,
        vendorsSent: checkpoint?.vendorSlugs || [],
        variances: [],
        redVarianceCount: 0,
        lowStockAlerts: Array.isArray(checkpoint?.lowStockAlerts) ? checkpoint.lowStockAlerts : [],
        lowStockCount: Number(checkpoint?.lowStockCount) || 0,
    };

    if (sessionId && stage === 'prepared') {
        const session = getSession(storeNumber, sessionId);
        if (session) {
            payload.variances = session.variances || [];
            payload.redVarianceCount = payload.variances.length;
            payload.vendorsSent = session.vendorSlugs?.length ? session.vendorSlugs : payload.vendorsSent;
        }
    }

    // mmxSentAt is set when the count is applied, not when scheduled orders finish - only
    // treat all-vendors-sent as orders complete when the pipeline is not actively running.
    if (
        !payload.ordersComplete &&
        !payload.inProgress &&
        (await stockCountMmxOrdersComplete(storeNumber, dateKey))
    ) {
        payload.ordersComplete = true;
        if (stage === 'idle') {
            payload.stage = 'completed';
        }
    }

    return payload;
}

function isStockCountPipelineBusy(stage) {
    return PIPELINE_ACTIVE_WORK_STAGES.has(stage);
}

async function recordStockCountPrepareFailure(storeNumber, error) {
    const cp = await getCheckpoint(storeNumber);
    if (!cp || cp.stage === 'completed' || cp.stage === 'prepare-failed') return;
    await updateCheckpoint(storeNumber, {
        stage: 'prepare-failed',
        lastError: error?.message || String(error || 'Prepare failed'),
        failedAtStep: cp?.stepLabel || defaultStepLabel(cp?.stage || 'preparing'),
        sessionId: null,
    });
}

/**
 * Apply confirmed count in Macromatix, then download reports and enter orders.
 */
async function applyStockCountSessionWork(storeNumber, sessionId, options = {}) {
    if (getLocalHoldCount(PRIORITY.MIC) === 0) {
        await beginStockCountMmxWork(`stock count apply (store ${storeNumber})`, storeNumber);
    } else {
        touchStockCountWork();
    }

    try {
        let session = getSession(storeNumber, sessionId);
        const checkpoint = await getCheckpoint(storeNumber);
        if (!session) {
            const dateKey = checkpoint?.dateKey || melbourneDateKey();
            const vendorSlugs =
                checkpoint?.vendorSlugs?.length > 0
                    ? checkpoint.vendorSlugs
                    : await getSubmittedVendorSlugs(storeNumber, dateKey);
            const sentSlugs = await getMmxSentVendorSlugs(storeNumber, dateKey);

            if (
                (checkpoint?.stage === 'applied-orders-pending' ||
                    checkpoint?.stage === 'filling-orders') &&
                dateKey
            ) {
                log.info(
                    `Store ${storeNumber}: MMX session ended - resuming scheduled orders (count already applied)`
                );
                const { orders, orderFailures } = await resumeScheduledOrdersInNewBrowser(
                    storeNumber,
                    dateKey,
                    options
                );
                await updateCheckpoint(storeNumber, {
                    stage: 'completed',
                    resumedFromCheckpoint: true,
                    dateKey,
                    vendorSlugs,
                    ordersCompletedAt: new Date().toISOString(),
                    lastError: orderFailures,
                });
                await clearCheckpoint(storeNumber);
                return {
                    success: true,
                    resumed: true,
                    alreadyApplied: true,
                    storeNumber: String(storeNumber),
                    dateKey,
                    vendorsSent: vendorSlugs,
                    ordersRan: true,
                    orders,
                    orderFailures: orderFailures || null,
                };
            }

            if (allVendorsMarkedMmxSent(vendorSlugs, sentSlugs)) {
                log.info(
                    `Store ${storeNumber}: count already applied in Macromatix - no further apply needed`
                );
                return {
                    success: true,
                    alreadyApplied: true,
                    ordersRan: false,
                    storeNumber: String(storeNumber),
                    dateKey,
                    vendorsSent: vendorSlugs,
                    orderFailures: null,
                };
            }

            throw new Error('Macromatix count session expired or not found. Send to MMX again.');
        }

        const { page, browser, dateKey, vendorSlugs } = session;
        let orderPipelineResult = null;
        let appliedInMmx = false;
        let countAlreadyApplied = false;

        try {
            await updateCheckpoint(storeNumber, {
                stage: 'applying',
                dateKey,
                sessionId,
                vendorSlugs,
                lastError: '',
            });
            await touchPipelineStep(storeNumber, 'Applying count in Macromatix');
            const { loadMmxStockCountConfig } = require('../../mmx/src/mmxReports/mmx-stock-count');
            const applyResult = await applyKeyItemCount(page, loadMmxStockCountConfig());
            appliedInMmx = applyResult.applied || applyResult.alreadyApplied;
            countAlreadyApplied = Boolean(applyResult.alreadyApplied);

            for (const slug of vendorSlugs) {
                await markMmxSent(storeNumber, slug, dateKey);
            }

            await updateCheckpoint(storeNumber, {
                stage: 'applied-orders-pending',
                dateKey,
                sessionId,
                vendorSlugs,
                appliedAt: new Date().toISOString(),
                lastError: '',
            });

            if (await shouldRunOrderPipeline(storeNumber, dateKey)) {
                log.info(`Key Item Count applied for store ${storeNumber} - downloading reports, then scheduled orders`);
                orderPipelineResult = await runOrdersAfterApply(storeNumber, dateKey, { page, browser });
                if (ordersAllSuccessful(orderPipelineResult)) {
                    await runStoreOrdersCompleteCleanup(storeNumber, dateKey);
                }
                const orderFailures = formatOrderFailures(orderPipelineResult);
                if (orderFailures) {
                    log.warn(`Store ${storeNumber} scheduled order failures: ${orderFailures}`);
                }
                await updateCheckpoint(storeNumber, {
                    stage: 'completed',
                    dateKey,
                    sessionId,
                    vendorSlugs,
                    ordersCompletedAt: new Date().toISOString(),
                    lastError: orderFailures,
                });
            }
            await clearCheckpoint(storeNumber);
        } catch (error) {
            const cp = await getCheckpoint(storeNumber);
            await updateCheckpoint(storeNumber, {
                stage: appliedInMmx ? 'applied-orders-pending' : 'apply-failed',
                dateKey,
                sessionId,
                vendorSlugs,
                lastError: error.message || String(error),
                failedAtStep: cp?.stepLabel || defaultStepLabel(cp?.stage || 'applying'),
            });
            throw error;
        } finally {
            await destroySession(session, 'applied');
        }

        const orderFailures = formatOrderFailures(orderPipelineResult);
        return {
            success: true,
            storeNumber: String(storeNumber),
            sessionId,
            dateKey,
            vendorsSent: vendorSlugs,
            alreadyApplied: countAlreadyApplied,
            ordersRan: Boolean(orderPipelineResult),
            orders: orderPipelineResult,
            orderFailures: orderFailures || null,
        };
    } finally {
        await endStockCountMmxWork(storeNumber, `stock count apply finished (store ${storeNumber})`);
    }
}

async function applyStockCountSession(storeNumber, sessionId, options = {}) {
    const run = () => applyStockCountSessionWork(storeNumber, sessionId, options);
    if (options._withinStoreLock) return run();
    return withStoreLock(storeNumber, run);
}

async function cancelStockCountSession(storeNumber, sessionId) {
    let cancelled = false;
    if (sessionId) {
        const session = getSession(storeNumber, sessionId);
        if (session) {
            await destroySession(session, 'cancelled');
            cancelled = true;
        }
    } else {
        cancelled = await destroySessionsForStore(storeNumber, 'cancelled');
    }
    await clearCheckpoint(storeNumber);
    await endStockCountMmxWork(storeNumber, `stock count session cancelled (store ${storeNumber})`);
    return { success: true, cancelled };
}

async function recordStockCountCheckFailure(storeNumber, error) {
    const cp = await getCheckpoint(storeNumber);
    if (!cp || cp.stage === 'completed') return;
    await updateCheckpoint(storeNumber, {
        stage: 'check-levels-failed',
        lastError: error?.message || String(error || 'Stock level check failed'),
        failedAtStep: cp?.stepLabel || defaultStepLabel('checking-stock-levels'),
    });
}

async function checkStockLevelsForStore(storeNumber, options = {}) {
    const {
        computeLowStockAlerts,
        invalidateLowStockSummaryCache,
        buildLowStockSummaryFromAlerts,
        setLowStockSummaryCache,
        defaultStockWarningDays,
    } = require('./lowStockAlerts');
    const { calculateBuildToOrders } = require('./buildToCalculator');

    return withStoreLock(storeNumber, async () => {
        await beginStockCountMmxWork(`check stock levels (store ${storeNumber})`, storeNumber);
        try {
            await updateCheckpoint(storeNumber, {
                stage: 'checking-stock-levels',
                stepLabel: 'Downloading Macromatix reports (3 parallel browsers)…',
                lastError: null,
                failedAtStep: null,
            });
            invalidateLowStockSummaryCache(storeNumber);

            await ensureReportsForOrders(storeNumber, {
                forceDownload: true,
                parallelReportDownload: true,
                dateKey: options.dateKey,
                ...withStoreMmxOptions(storeNumber, options),
            });

            await updateCheckpoint(storeNumber, {
                stepLabel: 'Calculating stock shortfalls…',
            });

            const buildTo = await calculateBuildToOrders(storeNumber, {
                dateKey: options.dateKey,
                preferReportOnHand: true,
            });
            const alerts = computeLowStockAlerts(buildTo.lines || [], { storeNumber });
            const summary = buildLowStockSummaryFromAlerts(alerts, {
                thresholdDays: defaultStockWarningDays(),
            });
            setLowStockSummaryCache(storeNumber, summary, options.dateKey);
            await updateCheckpoint(storeNumber, {
                stage: 'idle',
                stepLabel: defaultStepLabel('idle'),
                lastError: null,
                failedAtStep: null,
                lowStockAlerts: summary.items || [],
                lowStockCount: summary.count || 0,
            });
            log.info(
                `Stock levels checked for store ${storeNumber}: ${summary.count} shortfall(s) under ${summary.thresholdDays} days`
            );
            return summary;
        } catch (error) {
            await recordStockCountCheckFailure(storeNumber, error);
            throw error;
        } finally {
            await endStockCountMmxWork(storeNumber, `check stock levels finished (store ${storeNumber})`);
        }
    });
}

/** @deprecated Use prepareStockCountForMmx + applyStockCountSession */
async function sendStockCountToMmx(storeNumber, vendorSlug, options = {}) {
    const prepared = await prepareStockCountForMmx(storeNumber, vendorSlug, options);
    return applyStockCountSession(storeNumber, prepared.sessionId);
}

module.exports = {
    prepareStockCountForMmx,
    applyStockCountSession,
    cancelStockCountSession,
    discardStockCountMmxWork,
    sendStockCountToMmx,
    getStockCountSendPlan,
    getStockCountPipelineStatus,
    isStockCountPipelineBusy,
    recordStockCountPrepareFailure,
    recordStockCountCheckFailure,
    resetStalePipelineCheckpointsOnStartup,
    runScheduledOrdersOnly,
    runStoreBuildToCycle,
    checkStockLevelsForStore,
    ensureReportsForOrders,
    shouldRunOrderPipeline,
    vendorEntriesNeedKeyItemCount,
};
