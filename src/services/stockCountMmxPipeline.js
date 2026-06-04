const { getStoreConfig } = require('./storeList');
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
const { openMacromatixBrowser, closeBrowserQuietly, selectStoreOnPage } = require('./macromatixScraper');
const { enterCombinedStockCount, applyKeyItemCount } = require('./mmxReports/mmx-stock-count');
const { downloadReportsForStores } = require('./mmxReportDownloader');
const { buildOrderLinesByVendorId } = require('./buildToOrderLines');
const { runVendorOrderEntry } = require('./mmxReports/pipeline-enter-vendor-orders');
const { createSession, getSession, destroySession } = require('./mmxCountSession');
const { acquireMmxResource, releaseMmxResource } = require('./mmxResourceGate');
const { setCheckpoint, getCheckpoint, clearCheckpoint } = require('./mmxPipelineCheckpoint');
const { runStoreOrdersCompleteCleanup } = require('./storeOrdersCompleteCleanup');
const log = require('./mmxReports/util-logging');
const runLockByStore = new Map();

function storeSelectorLabel(store) {
    const num = String(store.storeNumber || '').trim();
    const name = String(store.storeName || '').trim();
    if (num && name) return `${num} ${name}`;
    return name || num;
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
        const catalog = getVendorCatalog(entry.slug, { forStockCount: true });
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

    const selectStore = async (p, num) => {
        await p.waitForTimeout(800);
        let picked = await selectStoreOnPage(p, num);
        if (!picked && storeLabel && storeLabel !== String(num)) {
            log.info(`Store combo miss for ${num} — trying label "${storeLabel}"`);
            const { selectStore: selectStoreByLabel } = require('./mmxReports/pipeline-supply-chain-reports');
            await selectStoreByLabel(p, storeLabel, { storeNumber: num, waitMs: 500 });
            picked = await selectStoreOnPage(p, num);
        }
        if (!picked) throw new Error(`Could not select store ${num} in Macromatix`);
    };

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
    };

    log.info(`Store ${storeNumber}: scheduled order entry only — no report downloads or other MMX tasks`);
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

/**
 * Pre-build order lines from on-disk reports + dashboard counts, then fill scheduled orders.
 * Report downloads are never run on the same browser session before order entry.
 */
async function runOrdersAfterApply(storeNumber, dateKey, page) {
    const orderPack = await buildOrderLinesByVendorId(storeNumber, { dateKey });
    return runVendorOrdersForStore(page, storeNumber, dateKey, orderPack);
}

async function ensureReportsOnDisk(storeNumber, options = {}) {
    const { resolveStoreReports } = require('./reportReader');
    const { REPORTS_DIR } = require('./buildToCalculator');
    const files = resolveStoreReports(storeNumber, options.reportsDir || REPORTS_DIR);
    if (files.inventorySpecialEvent && files.stockOnHand) return;

    log.info(`Reports missing for store ${storeNumber} — downloading in a separate browser pass`);
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser(options));
        await downloadReportsForStores({ storeNumber, page, browser });
    } finally {
        await closeBrowserQuietly(browser, 'pre-order report download');
    }
}

/**
 * Open MMX and fill scheduled orders only (skip stock count + optional report download).
 * Downloads reports first when missing or when skipReportDownload is false.
 */
async function runScheduledOrdersOnly(storeNumber, options = {}) {
    return withStoreLock(storeNumber, async () => {
        acquireMmxResource(`scheduled orders (store ${storeNumber})`);
        const dateKey = options.dateKey || melbourneDateKey();
        let browser;
        let page;
        try {
            const { resolveStoreReports } = require('./reportReader');
            const { REPORTS_DIR } = require('./buildToCalculator');
            const files = resolveStoreReports(storeNumber, options.reportsDir || REPORTS_DIR);
            const reportsReady = Boolean(files.inventorySpecialEvent && files.stockOnHand);
            const shouldDownload = !options.skipReportDownload || !reportsReady;

            if (shouldDownload) {
                await ensureReportsOnDisk(storeNumber, options);
            } else if (!reportsReady) {
                log.warn(
                    `Reports incomplete for store ${storeNumber} — using existing data; order quantities may be incomplete`
                );
            } else {
                log.info(`Using existing reports in ${files.storeDir} — skipping download`);
            }

            const orderPack = await buildOrderLinesByVendorId(storeNumber, { dateKey });

            ({ browser, page } = await openMacromatixBrowser(options));
            log.info(`Filling scheduled orders for store ${storeNumber}`);
            const orders = await runVendorOrdersForStore(page, storeNumber, dateKey, orderPack);
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
                skippedReportDownload: !shouldDownload,
            };
        } finally {
            await closeBrowserQuietly(browser, 'scheduled orders only');
            releaseMmxResource(`scheduled orders finished (store ${storeNumber})`);
        }
    });
}

/**
 * Fill Macromatix Key Item Count, continue to confirm screen, return red variances.
 * Keeps browser session open for user review.
 */
async function prepareStockCountForMmx(storeNumber, vendorSlug, options = {}) {
    return withStoreLock(storeNumber, async () => {
        acquireMmxResource(`stock count prepare (store ${storeNumber})`);
        let sessionStarted = false;

        const { dateKey, toSend } = await resolveToSend(storeNumber, vendorSlug, options);
        const vendorEntries = await buildVendorEntries(storeNumber, toSend, dateKey);

        let browser;
        let page;
        try {
            ({ browser, page } = await openMacromatixBrowser(options));

            const selectStore = async (p, num) => {
                const picked = await selectStoreOnPage(p, num);
                if (!picked) throw new Error(`Could not select store ${num} in Macromatix`);
                log.info(`Store selected: ${picked}`);
            };

            const vendorLabels = vendorEntries.map((e) => e.catalog.label).join(', ');
            log.info(`Preparing combined Key Item Count for store ${storeNumber}: ${vendorLabels}`);

            const stockCountResult = await enterCombinedStockCount(page, {
                storeNumber,
                vendorEntries,
                navTimeoutMs: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
                selectStore,
                stopAtConfirm: true,
            });

            const session = await createSession({
                storeNumber,
                dateKey,
                vendorSlugs: toSend.map((row) => row.slug),
                browser,
                page,
                variances: stockCountResult.variances || [],
            });
            sessionStarted = true;
            await setCheckpoint(storeNumber, {
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
            throw error;
        } finally {
            if (!sessionStarted) {
                releaseMmxResource(`stock count prepare ended without session (store ${storeNumber})`);
            }
        }
    });
}

/**
 * Apply confirmed count in Macromatix, then download reports and enter orders.
 */
async function applyStockCountSession(storeNumber, sessionId, options = {}) {
    return withStoreLock(storeNumber, async () => {
        let session = getSession(storeNumber, sessionId);
        const checkpoint = await getCheckpoint(storeNumber);
        if (!session) {
            if (checkpoint?.stage === 'applied-orders-pending' && checkpoint.dateKey) {
                log.info(`Resuming pending scheduled orders for store ${storeNumber} from checkpoint`);
                acquireMmxResource(`resume scheduled orders (store ${storeNumber})`);
                let browser;
                let page;
                try {
                    ({ browser, page } = await openMacromatixBrowser(options));
                    const orders = await runOrdersAfterApply(storeNumber, checkpoint.dateKey, page);
                    const orderFailures = formatOrderFailures(orders);
                    await setCheckpoint(storeNumber, {
                        stage: 'completed',
                        resumedFromCheckpoint: true,
                        ordersCompletedAt: new Date().toISOString(),
                        lastError: orderFailures,
                    });
                    await clearCheckpoint(storeNumber);
                    return {
                        success: true,
                        resumed: true,
                        storeNumber: String(storeNumber),
                        dateKey: checkpoint.dateKey,
                        vendorsSent: checkpoint.vendorSlugs || [],
                        ordersRan: true,
                        orders,
                        orderFailures: orderFailures || null,
                    };
                } finally {
                    await closeBrowserQuietly(browser, 'checkpoint resume orders');
                    releaseMmxResource(`resume scheduled orders finished (store ${storeNumber})`);
                }
            }
            throw new Error('Macromatix count session expired or not found. Send to MMX again.');
        }

        const { page, browser, dateKey, vendorSlugs } = session;
        let orderPipelineResult = null;
        let appliedInMmx = false;

        try {
            await setCheckpoint(storeNumber, {
                stage: 'applying',
                dateKey,
                sessionId,
                vendorSlugs,
                lastError: '',
            });
            const { loadMmxStockCountConfig } = require('./mmxReports/mmx-stock-count');
            await applyKeyItemCount(page, loadMmxStockCountConfig());
            appliedInMmx = true;

            for (const slug of vendorSlugs) {
                await markMmxSent(storeNumber, slug, dateKey);
            }

            await setCheckpoint(storeNumber, {
                stage: 'applied-orders-pending',
                dateKey,
                sessionId,
                vendorSlugs,
                appliedAt: new Date().toISOString(),
                lastError: '',
            });

            if (await shouldRunOrderPipeline(storeNumber, dateKey)) {
                log.info(`Key Item Count applied for store ${storeNumber} — entering scheduled orders`);
                orderPipelineResult = await runOrdersAfterApply(storeNumber, dateKey, page);
                if (ordersAllSuccessful(orderPipelineResult)) {
                    await runStoreOrdersCompleteCleanup(storeNumber, dateKey);
                }
                const orderFailures = formatOrderFailures(orderPipelineResult);
                if (orderFailures) {
                    log.warn(`Store ${storeNumber} scheduled order failures: ${orderFailures}`);
                }
                await setCheckpoint(storeNumber, {
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
            await setCheckpoint(storeNumber, {
                stage: appliedInMmx ? 'applied-orders-pending' : 'apply-failed',
                dateKey,
                sessionId,
                vendorSlugs,
                lastError: error.message || String(error),
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
            ordersRan: Boolean(orderPipelineResult),
            orders: orderPipelineResult,
            orderFailures: orderFailures || null,
        };
    });
}

async function cancelStockCountSession(storeNumber, sessionId) {
    const session = getSession(storeNumber, sessionId);
    if (!session) return { success: true, cancelled: false };
    await destroySession(session, 'recount');
    return { success: true, cancelled: true };
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
    sendStockCountToMmx,
    runScheduledOrdersOnly,
    shouldRunOrderPipeline,
};
