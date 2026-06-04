const path = require('path');
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
const {
    enterCombinedStockCount,
    applyKeyItemCount,
    mergeVendorEntriesByLocation,
} = require('./mmxReports/mmx-stock-count');
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

/** True when submitted draft has at least one item that goes on Macromatix Key Item Count. */
function vendorEntriesNeedKeyItemCount(vendorEntries) {
    return mergeVendorEntriesByLocation(vendorEntries).size > 0;
}

/**
 * Submitted counts are manual / manual= only — skip KIC, use counts for scheduled orders.
 */
async function runOrdersFromManualCountsOnly(storeNumber, toSend, dateKey, options = {}) {
    for (const row of toSend) {
        await markMmxSent(storeNumber, row.slug, dateKey);
    }

    acquireMmxResource(`manual counts → orders (store ${storeNumber})`);
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser(options));
        log.info(
            `Store ${storeNumber}: manual-only stock count — skipping Key Item Count, filling scheduled orders from app counts`
        );
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
            orders,
            orderFailures: orderFailures || null,
        };
    } finally {
        await closeBrowserQuietly(browser, 'manual counts orders');
        releaseMmxResource(`manual counts orders finished (store ${storeNumber})`);
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

function reportsReadyForStore(storeNumber, reportsDir) {
    const { resolveStoreReports, validateStoreReports } = require('./reportReader');
    const { REPORTS_DIR } = require('./buildToCalculator');
    const files = resolveStoreReports(storeNumber, reportsDir || REPORTS_DIR);
    const validation = validateStoreReports(storeNumber, files);
    return {
        ready: validation.valid,
        files,
        validation,
    };
}

async function ensureReportsForOrders(storeNumber, options = {}) {
    const { REPORTS_DIR } = require('./buildToCalculator');
    const reportsDir = options.reportsDir || REPORTS_DIR;
    const { ready, files, validation } = reportsReadyForStore(storeNumber, reportsDir);
    if (ready && !options.forceDownload) return;
    if (!ready && validation?.issues?.length && !options.forceDownload) {
        log.info(
            `Reports need refresh for store ${storeNumber}: ${validation.issues.join('; ')}`
        );
    }

    const downloadOpts = { storeNumber, reportsDir: options.reportsDir };
    if (options.page) {
        log.info(
            options.forceDownload
                ? `Re-downloading reports for store ${storeNumber} (current MMX session)`
                : `Reports missing for store ${storeNumber} — downloading via current MMX session`
        );
        await downloadReportsForStores({
            ...downloadOpts,
            page: options.page,
            browser: options.browser || null,
        });
    } else {
        log.info(
            options.forceDownload
                ? `Re-downloading reports for store ${storeNumber}`
                : `Reports missing for store ${storeNumber} — downloading in a separate browser pass`
        );
        let browser;
        let page;
        try {
            ({ browser, page } = await openMacromatixBrowser(options));
            await downloadReportsForStores({ ...downloadOpts, page, browser });
        } finally {
            await closeBrowserQuietly(browser, 'pre-order report download');
        }
    }

    const after = reportsReadyForStore(storeNumber, reportsDir);
    if (!after.ready) {
        const detail = after.validation?.issues?.length
            ? after.validation.issues.join('; ')
            : 'inventory-special-event, stock-on-hand, and stock-on-order required';
        throw new Error(
            `Report download did not produce valid ISE, SOH, and SOO in ${after.files.storeDir}: ${detail}`
        );
    }
    const { loadPipelineConfig } = require('./mmxReportDownloader');
    const { resolveReportDate } = require('./mmxReports/util-dates');
    const pipeline = loadPipelineConfig();
    const sohCfg = pipeline.reports.find((r) => r.id === 'report1');
    const sohStart = sohCfg
        ? resolveReportDate(sohCfg.startDate || 'tomorrow', {
              timeZone: sohCfg.timeZone,
              dateOnly: false,
          })
        : '';
    log.info(
        `Reports ready for store ${storeNumber}: ISE=${path.basename(after.files.inventorySpecialEvent || '')}, SOH=${path.basename(after.files.stockOnHand || '')} (MMX start ${sohStart || '—'}), SOO=${path.basename(after.files.stockOnOrder || '')}`
    );
    const { writeStoreReportManifest } = require('./reportReader');
    writeStoreReportManifest(storeNumber, reportsDir, {
        storeNumber: String(storeNumber),
        sohStartDate: sohStart,
        ise: path.basename(after.files.inventorySpecialEvent || ''),
        soh: path.basename(after.files.stockOnHand || ''),
        soo: path.basename(after.files.stockOnOrder || ''),
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
        validateStoreReports,
        resolveStoreReports,
        describeResolvedStoreReports,
    } = require('./reportReader');
    const { REPORTS_DIR, calculateBuildToOrders } = require('./buildToCalculator');
    const reportsDir = options.reportsDir || REPORTS_DIR;
    const dateKey = options.dateKey || melbourneDateKey();
    const skipDownload = Boolean(options.skipReportDownload);
    const cleanup = options.cleanupReports !== false;
    const page = options.page;

    if (!skipDownload) {
        const { removed } = clearStoreReportFiles(storeNumber, reportsDir);
        if (removed.length) {
            log.info(
                `Build-to cycle: cleared ${removed.length} old report file(s) for store ${storeNumber}`
            );
        }
    }

    let cycleSucceeded = false;
    try {
        if (!skipDownload) {
            await ensureReportsForOrders(storeNumber, {
                page: options.page,
                browser: options.browser,
                reportsDir,
                forceDownload: true,
            });
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
        const onOrderLines = (buildTo.lines || []).filter((l) => Number(l.onOrderCartons) > 0);
        log.info(
            `Build-to for store ${storeNumber}: ${buildTo.lines?.length || 0} ISE line(s), ${onOrderLines.length} with on-order deducted`
        );
        log.info(
            `On-hand sources: ${buildTo.onHandFromReportCount || 0} from SOH report (${buildTo.reportFiles?.stockOnHand ? path.basename(buildTo.reportFiles.stockOnHand) : 'missing'}), ${buildTo.onHandFromManualCount || 0} from stock-count (ignored in this cycle)`
        );

        const orderPack = await buildOrderLinesByVendorId(storeNumber, buildToOpts);

        if (options.dryRun) {
            cycleSucceeded = true;
            return { dryRun: true, dateKey, buildTo, orderPack };
        }
        if (!page) {
            throw new Error('runStoreBuildToCycle requires an active MMX page to fill scheduled orders');
        }

        const orders = await runVendorOrdersForStore(page, storeNumber, dateKey, orderPack);
        cycleSucceeded = true;
        return { dateKey, buildTo, orderPack, orders };
    } finally {
        if (cleanup && cycleSucceeded) {
            const { removed } = clearStoreReportFiles(storeNumber, reportsDir);
            log.info(
                `Build-to cycle: removed ${removed.length} report file(s) from Reports/${storeNumber}/ after successful run`
            );
        } else if (cleanup && !cycleSucceeded) {
            log.warn(
                `Build-to cycle failed for store ${storeNumber} — report files left in Reports/${storeNumber}/ for retry`
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
        cleanupReports: true,
    });
    return result.orders;
}

async function resumeScheduledOrdersInNewBrowser(storeNumber, dateKey, options = {}) {
    acquireMmxResource(`resume scheduled orders (store ${storeNumber})`);
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser(options));
        const orders = await runOrdersAfterApply(storeNumber, dateKey, { page, browser });
        const orderFailures = formatOrderFailures(orders);
        return { orders, orderFailures };
    } finally {
        await closeBrowserQuietly(browser, 'resume scheduled orders');
        releaseMmxResource(`resume scheduled orders finished (store ${storeNumber})`);
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
        acquireMmxResource(`scheduled orders (store ${storeNumber})`);
        const dateKey = options.dateKey || melbourneDateKey();
        let browser;
        let page;
        try {
            ({ browser, page } = await openMacromatixBrowser(options));
            log.info(`Build-to cycle for store ${storeNumber} — download 3 reports, fill orders, clear reports`);
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

        if (!vendorEntriesNeedKeyItemCount(vendorEntries)) {
            return runOrdersFromManualCountsOnly(storeNumber, toSend, dateKey, options);
        }

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

            const redVariances = session.variances || [];
            if (!redVariances.length) {
                log.info(
                    `Store ${storeNumber}: no red variances — applying count and filling scheduled orders in one run`
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

const PIPELINE_IN_PROGRESS_STAGES = new Set([
    'prepared',
    'applying',
    'applied-orders-pending',
    'filling-orders',
]);

async function getStockCountPipelineStatus(storeNumber) {
    const checkpoint = await getCheckpoint(storeNumber);
    const stage = checkpoint?.stage || 'idle';
    return {
        success: true,
        storeNumber: String(storeNumber),
        stage,
        inProgress: PIPELINE_IN_PROGRESS_STAGES.has(stage),
        ordersComplete: stage === 'completed',
        lastError: checkpoint?.lastError || null,
        dateKey: checkpoint?.dateKey || null,
        sessionId: checkpoint?.sessionId || null,
        updatedAt: checkpoint?.updatedAt || null,
    };
}

/**
 * Apply confirmed count in Macromatix, then download reports and enter orders.
 */
async function applyStockCountSessionWork(storeNumber, sessionId, options = {}) {
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
                    `Store ${storeNumber}: MMX session ended — resuming scheduled orders (count already applied)`
                );
                const { orders, orderFailures } = await resumeScheduledOrdersInNewBrowser(
                    storeNumber,
                    dateKey,
                    options
                );
                await setCheckpoint(storeNumber, {
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
                    `Store ${storeNumber}: count already applied in Macromatix — no further apply needed`
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
            await setCheckpoint(storeNumber, {
                stage: 'applying',
                dateKey,
                sessionId,
                vendorSlugs,
                lastError: '',
            });
            const { loadMmxStockCountConfig } = require('./mmxReports/mmx-stock-count');
            const applyResult = await applyKeyItemCount(page, loadMmxStockCountConfig());
            appliedInMmx = applyResult.applied || applyResult.alreadyApplied;
            countAlreadyApplied = Boolean(applyResult.alreadyApplied);

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
                await setCheckpoint(storeNumber, {
                    stage: 'filling-orders',
                    dateKey,
                    sessionId,
                    vendorSlugs,
                    lastError: '',
                });
                orderPipelineResult = await runOrdersAfterApply(storeNumber, dateKey, { page, browser });
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
            alreadyApplied: countAlreadyApplied,
            ordersRan: Boolean(orderPipelineResult),
            orders: orderPipelineResult,
            orderFailures: orderFailures || null,
        };
}

async function applyStockCountSession(storeNumber, sessionId, options = {}) {
    const run = () => applyStockCountSessionWork(storeNumber, sessionId, options);
    if (options._withinStoreLock) return run();
    return withStoreLock(storeNumber, run);
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
    getStockCountPipelineStatus,
    runScheduledOrdersOnly,
    runStoreBuildToCycle,
    ensureReportsForOrders,
    shouldRunOrderPipeline,
};
