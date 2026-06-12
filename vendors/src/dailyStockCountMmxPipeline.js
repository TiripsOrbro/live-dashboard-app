const {
    openMacromatixBrowser,
    closeBrowserQuietly,
    resolveStoreOnCurrentPage,
} = require('../../mmx/src/macromatixScraper');
const {
    enterCombinedStockCount,
    applyKeyItemCount,
    listOpenCounts,
    loadMmxStockCountConfig,
} = require('../../mmx/src/mmxReports/mmx-stock-count');
const {
    getDraft,
    submitDraft,
    markMmxSent,
    melbourneDateKey,
    getCatalog,
} = require('./dailyStockCountState');
const { createSession, getSession, destroySessionsForStore } = require('../../mmx/src/dailyCountSession');
const { setCheckpoint, getCheckpoint, clearCheckpoint } = require('./dailyStockCountCheckpoint');
const {
    acquireMmxResource,
    releaseMmxResource,
    refreshScrapePauseTimeout,
    abortCompetingMmxWork,
    isMmxResourceBusy,
} = require('../../mmx/src/mmxResourceGate');

const log = {
    info: (...args) => console.log('[DailyStockCount]', ...args),
    warn: (...args) => console.warn('[DailyStockCount]', ...args),
};

const runLockByStore = new Map();

const PIPELINE_IN_PROGRESS_STAGES = new Set(['checking-existing', 'preparing', 'prepared', 'applying']);
const PIPELINE_ACTIVE_WORK_STAGES = new Set(['checking-existing', 'preparing', 'applying']);

function withStoreMmxOptions(storeNumber, options = {}) {
    return { ...options, storeNumber: String(storeNumber).replace(/\D/g, '') };
}

async function selectStoreInMacromatix(page, storeNumber) {
    const picked = await resolveStoreOnCurrentPage(page, storeNumber, { requireComboSelection: true });
    log.info(`Store selected: ${picked}`);
    return picked;
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

function beginDailyCountMmxWork(reason, storeNumber) {
    abortCompetingMmxWork(reason);
    acquireMmxResource(reason);
    refreshScrapePauseTimeout();
    void storeNumber;
}

function endDailyCountMmxWork(storeNumber, reason) {
    releaseMmxResource(reason || `daily count finished (store ${storeNumber})`);
}

function touchPipelineStep(storeNumber, stepLabel) {
    refreshScrapePauseTimeout();
    return setCheckpoint(storeNumber, { stepLabel: String(stepLabel || '').trim() });
}

async function probeOpenCounts(storeNumber, options = {}) {
    let browser;
    let page;
    beginDailyCountMmxWork(`daily count status probe (store ${storeNumber})`, storeNumber);
    try {
        ({ browser, page } = await openMacromatixBrowser(withStoreMmxOptions(storeNumber, options)));
        const cfg = loadMmxStockCountConfig();
        await page.goto(cfg.url, { waitUntil: 'load', timeout: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000) });
        await page.waitForTimeout(1500);
        await selectStoreInMacromatix(page, storeNumber);
        const openCounts = await listOpenCounts(page, cfg);
        return {
            success: true,
            storeNumber: String(storeNumber),
            openCounts,
            hasOpenCount: openCounts.length > 0,
        };
    } finally {
        await closeBrowserQuietly(browser, 'daily count probe');
        endDailyCountMmxWork(storeNumber, `daily count probe finished (store ${storeNumber})`);
    }
}

async function buildVendorEntry(storeNumber, dateKey) {
    const catalog = getCatalog();
    const draft = await getDraft(storeNumber, dateKey);
    if (!catalog) throw new Error('Daily count catalog is not configured.');
    if (!draft?.locations || !Object.keys(draft.locations).length) {
        throw new Error('No daily count draft to send.');
    }
    return {
        slug: 'daily',
        catalog,
        draftLocations: draft.locations,
    };
}

async function prepareDailyCountForMmx(storeNumber, options = {}) {
    return withStoreLock(storeNumber, async () => {
        const dateKey = options.dateKey || melbourneDateKey();
        const draft = await getDraft(storeNumber, dateKey);
        const resolution = draft?.resolution || 'create';
        const openBatchValue = draft?.openBatchValue || null;

        await submitDraft(storeNumber, dateKey);
        const vendorEntry = await buildVendorEntry(storeNumber, dateKey);

        await destroySessionsForStore(storeNumber, 'replaced');
        await setCheckpoint(storeNumber, {
            stage: 'preparing',
            dateKey,
            sessionId: null,
            lastError: '',
            resolution,
        });

        beginDailyCountMmxWork(`daily count prepare (store ${storeNumber})`, storeNumber);
        let sessionStarted = false;
        let browser;
        let page;

        try {
            ({ browser, page } = await openMacromatixBrowser(withStoreMmxOptions(storeNumber, options)));
            const onPipelineStep = (label) => touchPipelineStep(storeNumber, label);

            const stockCountResult = await enterCombinedStockCount(page, {
                storeNumber,
                vendorEntries: [vendorEntry],
                navTimeoutMs: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
                selectStore: async (p, num) => selectStoreInMacromatix(p, num),
                stopAtConfirm: true,
                countKind: 'daily',
                countResolution: resolution,
                openBatchValue,
                onPipelineStep,
            });

            const redVariances = stockCountResult.variances || [];
            const session = await createSession({
                storeNumber,
                dateKey,
                browser,
                page,
                variances: redVariances,
            });
            sessionStarted = true;

            if (!redVariances.length) {
                log.info(`Store ${storeNumber}: no red variances — applying daily count immediately`);
                const applyResult = await applyDailyCountSessionWork(storeNumber, session.sessionId, {
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
                    stockCount: stockCountResult,
                    applied: applyResult.applied,
                };
            }

            await setCheckpoint(storeNumber, {
                stage: 'prepared',
                dateKey,
                sessionId: session.sessionId,
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
                stockCount: stockCountResult,
            };
        } catch (error) {
            await closeBrowserQuietly(browser, 'daily count prepare failed');
            if (!sessionStarted) {
                await setCheckpoint(storeNumber, {
                    stage: 'prepare-failed',
                    dateKey,
                    lastError: error.message || String(error),
                    sessionId: null,
                }).catch(() => {});
            }
            throw error;
        } finally {
            if (!sessionStarted) {
                endDailyCountMmxWork(storeNumber, `daily count prepare ended without session (store ${storeNumber})`);
            }
        }
    });
}

async function applyDailyCountSessionWork(storeNumber, sessionId, options = {}) {
    if (!isMmxResourceBusy()) {
        beginDailyCountMmxWork(`daily count apply (store ${storeNumber})`, storeNumber);
    } else {
        refreshScrapePauseTimeout();
    }

    try {
        const session = getSession(storeNumber, sessionId);
        if (!session?.page) {
            throw new Error('Daily count session expired — submit again.');
        }

        await setCheckpoint(storeNumber, {
            stage: 'applying',
            sessionId,
            dateKey: session.dateKey,
            lastError: '',
        });

        const cfg = loadMmxStockCountConfig();
        const applied = await applyKeyItemCount(session.page, cfg);
        await markMmxSent(storeNumber, session.dateKey);
        await destroySessionsForStore(storeNumber, 'applied');
        await setCheckpoint(storeNumber, { stage: 'completed', sessionId: null, lastError: '' });
        await clearCheckpoint(storeNumber);

        return {
            success: true,
            applied,
            storeNumber: String(storeNumber),
            dateKey: session.dateKey,
        };
    } finally {
        endDailyCountMmxWork(storeNumber, `daily count apply finished (store ${storeNumber})`);
    }
}

async function cancelDailyCountSession(storeNumber) {
    await destroySessionsForStore(storeNumber, 'recount');
    await clearCheckpoint(storeNumber);
    endDailyCountMmxWork(storeNumber, `daily count session cancelled (store ${storeNumber})`);
    return { success: true };
}

function isDailyCountPipelineBusy(stage) {
    return PIPELINE_ACTIVE_WORK_STAGES.has(stage);
}

async function getDailyCountPipelineStatus(storeNumber) {
    const checkpoint = await getCheckpoint(storeNumber);
    const stage = checkpoint?.stage || 'idle';
    const sessionId = checkpoint?.sessionId || null;
    const payload = {
        success: true,
        storeNumber: String(storeNumber),
        stage,
        inProgress: PIPELINE_IN_PROGRESS_STAGES.has(stage),
        ordersComplete: stage === 'completed',
        lastError: checkpoint?.lastError || null,
        stepLabel: checkpoint?.stepLabel || '',
        dateKey: checkpoint?.dateKey || melbourneDateKey(),
        sessionId,
        updatedAt: checkpoint?.updatedAt || null,
        variances: [],
        redVarianceCount: 0,
    };

    if (sessionId && stage === 'prepared') {
        const session = getSession(storeNumber, sessionId);
        if (session) {
            payload.variances = session.variances || [];
            payload.redVarianceCount = payload.variances.length;
        }
    }

    return payload;
}

module.exports = {
    probeOpenCounts,
    prepareDailyCountForMmx,
    applyDailyCountSessionWork,
    cancelDailyCountSession,
    getDailyCountPipelineStatus,
    isDailyCountPipelineBusy,
    beginDailyCountMmxWork,
    endDailyCountMmxWork,
};
