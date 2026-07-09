const { melbourneDateKey } = require('./stockCountState');
const {
    reportIdsNeedingDownload,
    reportsReadyForReportIds,
    resolveStoreReports,
} = require('./reportReader');

const paths = require('../../src/paths');
const REPORTS_DIR = paths.vendors.reports;

/** ISE + on-order — safe to download before stock count (SOH reflects pre-count inventory). */
const ORDERING_PREFETCH_REPORT_IDS = ['report2', 'report3'];

/** SOH only — download after Key Item Count apply when counts are in Macromatix. */
const POST_STOCK_COUNT_REPORT_IDS = ['report1'];

const REPORT_LABELS = {
    report1: 'Stock On Hand',
    report2: 'Stock On Order',
    report3: 'Inventory Special Event',
};

function orderingPrefetchEnabled() {
    return !/^(0|false|no|off)$/i.test(String(process.env.ORDERING_PREFETCH_REPORTS ?? '1').trim());
}

function orderingPrefetchOnScrapeEnabled() {
    if (!orderingPrefetchEnabled()) return false;
    return !/^(0|false|no|off)$/i.test(String(process.env.ORDERING_PREFETCH_ON_SCRAPE ?? '1').trim());
}

function reportIdsNeedingRefresh(storeNumber, reportIds, reportsDir, options = {}) {
    const targets = (reportIds || []).filter(Boolean);
    if (!targets.length) return [];
    if (options.forceDownload) return targets;
    const forceSet = new Set(Array.isArray(options.forceReportIds) ? options.forceReportIds : []);
    const needs = reportIdsNeedingDownload(storeNumber, targets, reportsDir, options);
    const forced = targets.filter((id) => forceSet.has(id));
    return [...new Set([...needs, ...forced])];
}

/**
 * After count apply: always refresh SOH; reuse morning ISE/SOO when still valid for today.
 */
function reportIdsForAfterCountApply(storeNumber, reportsDir = REPORTS_DIR, options = {}) {
    const dateKey = options.dateKey || melbourneDateKey();
    const ids = [...POST_STOCK_COUNT_REPORT_IDS];
    const { files } = resolveStoreReports(storeNumber, reportsDir);
    const { validateReportId } = require('./reportReader');
    for (const reportId of ORDERING_PREFETCH_REPORT_IDS) {
        if (validateReportId(storeNumber, files, reportId, { dateKey }).length) {
            ids.push(reportId);
        }
    }
    return [...new Set(ids)];
}

function describeReportIds(reportIds) {
    return (reportIds || []).map((id) => REPORT_LABELS[id] || id).join(', ');
}

function storeHasPendingOrders(pendingVendors = []) {
    return Array.isArray(pendingVendors) && pendingVendors.length > 0;
}

function prefetchStatusForStore(storeNumber, reportsDir = REPORTS_DIR, options = {}) {
    const dateKey = options.dateKey || melbourneDateKey();
    const prefetchReady = reportsReadyForReportIds(
        storeNumber,
        ORDERING_PREFETCH_REPORT_IDS,
        reportsDir,
        { dateKey }
    );
    const missing = reportIdsNeedingDownload(
        storeNumber,
        ORDERING_PREFETCH_REPORT_IDS,
        reportsDir,
        { dateKey }
    );
    return {
        storeNumber: String(storeNumber),
        dateKey,
        prefetchReportIds: ORDERING_PREFETCH_REPORT_IDS,
        ready: prefetchReady.ready,
        missingReportIds: missing,
        issues: prefetchReady.issues || [],
    };
}

const prefetchChainByStore = new Map();
const prefetchInFlight = new Set();

function queuePrefetchForStore(storeNumber, fn) {
    const key = String(storeNumber);
    const prev = prefetchChainByStore.get(key) || Promise.resolve();
    const run = prev
        .catch(() => {})
        .then(fn)
        .finally(() => {
            if (prefetchChainByStore.get(key) === run) prefetchChainByStore.delete(key);
        });
    prefetchChainByStore.set(key, run);
    return run;
}

async function prefetchOrderingReportsForStore(storeNumber, options = {}) {
    if (!orderingPrefetchEnabled()) {
        return { skipped: true, reason: 'disabled' };
    }

    const num = String(storeNumber || '').replace(/\D/g, '');
    if (!num) return { skipped: true, reason: 'invalid-store' };

    const dateKey = options.dateKey || melbourneDateKey();
    const { shouldSkipPendingVendorScrape } = require('./orderingDayState');
    if (shouldSkipPendingVendorScrape(num, dateKey)) {
        return { skipped: true, reason: 'ordering-day-complete', storeNumber: num };
    }

    const reportsDir = options.reportsDir || REPORTS_DIR;
    const idsToDownload = reportIdsNeedingRefresh(num, ORDERING_PREFETCH_REPORT_IDS, reportsDir, {
        dateKey,
        forceDownload: Boolean(options.forceDownload),
    });

    if (!idsToDownload.length) {
        return {
            skipped: true,
            reason: 'already-ready',
            storeNumber: num,
            reportIds: ORDERING_PREFETCH_REPORT_IDS,
        };
    }

    if (prefetchInFlight.has(num) && !options.forceDownload) {
        return { skipped: true, reason: 'in-flight', storeNumber: num };
    }

    const { ensureReportsForOrders, getStockCountPipelineStatus, isStockCountExclusiveActive } =
        require('./stockCountMmxPipeline');
    const {
        withLightweightStoreLock,
        beginLightweightStockLevelsWork,
        endLightweightStockLevelsWork,
    } = require('./stockCountMmxPipeline');
    const { isMmxResourceBusy, waitUntilMmxResourceIdle } = require('../../mmx/src/mmxResourceGate');

    return queuePrefetchForStore(num, async () => {
        if (prefetchInFlight.has(num) && !options.forceDownload) {
            return { skipped: true, reason: 'in-flight', storeNumber: num };
        }

        const pipeline = await getStockCountPipelineStatus(num);
        if (isStockCountExclusiveActive(pipeline, num)) {
            return { skipped: true, reason: 'pipeline-active', storeNumber: num };
        }

        if (isMmxResourceBusy()) {
            if (options.waitForIdle !== false) {
                await waitUntilMmxResourceIdle();
            } else {
                return { skipped: true, reason: 'mmx-busy', storeNumber: num };
            }
        }

        prefetchInFlight.add(num);
        try {
            return await withLightweightStoreLock(num, async () => {
                await beginLightweightStockLevelsWork(
                    num,
                    `prefetch ordering reports (store ${num})`
                );
                try {
                    const labels = describeReportIds(idsToDownload);
                    console.log(
                        `[Ordering] Prefetch ${labels} for store ${num} (${idsToDownload.join(', ')})`
                    );
                    await ensureReportsForOrders(num, {
                        ...options,
                        storeNumber: num,
                        reportsDir,
                        dateKey,
                        onlyReportIds: idsToDownload,
                        forceDownload: Boolean(options.forceDownload),
                        parallelReportDownload: options.parallelReportDownload !== false,
                    });
                    return {
                        success: true,
                        storeNumber: num,
                        downloadedReportIds: idsToDownload,
                    };
                } finally {
                    await endLightweightStockLevelsWork(
                        num,
                        `prefetch ordering reports finished (store ${num})`
                    );
                }
            });
        } finally {
            prefetchInFlight.delete(num);
        }
    });
}

async function prefetchOrderingReportsForPendingStores(stores = [], options = {}) {
    if (!orderingPrefetchOnScrapeEnabled()) return { queued: 0, results: [] };
    const list = Array.isArray(stores) ? stores : [];
    const results = [];
    let queued = 0;

    for (const store of list) {
        const storeNumber = String(store?.storeNumber || store || '').trim();
        if (!storeNumber || store?.error) continue;
        if (!storeHasPendingOrders(store.pendingVendors)) continue;
        const dateKey = options.dateKey || melbourneDateKey();
        const { shouldSkipPendingVendorScrape } = require('./orderingDayState');
        if (shouldSkipPendingVendorScrape(storeNumber, dateKey)) {
            results.push({ storeNumber, skipped: true, reason: 'ordering-day-complete' });
            continue;
        }

        const status = prefetchStatusForStore(storeNumber, options.reportsDir, options);
        if (status.ready) {
            results.push({ storeNumber, skipped: true, reason: 'already-ready' });
            continue;
        }

        queued += 1;
        try {
            const result = await prefetchOrderingReportsForStore(storeNumber, {
                ...options,
                waitForIdle: true,
            });
            results.push(result);
        } catch (err) {
            results.push({
                storeNumber,
                success: false,
                error: err?.message || String(err),
            });
        }
    }

    if (queued) {
        console.log(
            `[Ordering] Prefetch complete for ${results.filter((r) => r.success).length}/${queued} store(s) with pending orders`
        );
    }
    return { queued, results };
}

module.exports = {
    ORDERING_PREFETCH_REPORT_IDS,
    POST_STOCK_COUNT_REPORT_IDS,
    REPORT_LABELS,
    orderingPrefetchEnabled,
    orderingPrefetchOnScrapeEnabled,
    reportIdsNeedingRefresh,
    reportIdsForAfterCountApply,
    describeReportIds,
    storeHasPendingOrders,
    prefetchStatusForStore,
    prefetchOrderingReportsForStore,
    prefetchOrderingReportsForPendingStores,
};
