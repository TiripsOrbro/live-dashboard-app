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
    PRIORITY,
    acquirePrioritySlot,
    releasePrioritySlot,
    getLocalHoldCount,
} = require('../../mmx/src/mmxTaskQueue');
const { refreshScrapePauseTimeout } = require('../../mmx/src/mmxResourceGate');

const log = {
    info: (...args) => console.log('[DailyStockCount]', ...args),
    warn: (...args) => console.warn('[DailyStockCount]', ...args),
};

const runLockByStore = new Map();
const PROBE_CACHE_MS = Number(process.env.DAILY_COUNT_PROBE_CACHE_MS || 8 * 60 * 1000);
const probeCacheByStore = new Map();

function invalidateDailyCountProbeCache(storeNumber) {
    probeCacheByStore.delete(String(storeNumber || '').trim());
}

function readCachedProbe(storeNumber) {
    const key = String(storeNumber || '').trim();
    const entry = probeCacheByStore.get(key);
    if (!entry || Date.now() - entry.at > PROBE_CACHE_MS) return null;
    return entry.result;
}

function writeCachedProbe(storeNumber, result) {
    probeCacheByStore.set(String(storeNumber || '').trim(), { at: Date.now(), result });
}

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

async function beginDailyCountMmxWork(reason, storeNumber) {
    await acquirePrioritySlot(PRIORITY.MIC, { type: 'mic-daily-count', label: reason });
    refreshScrapePauseTimeout();
    void storeNumber;
}

async function endDailyCountMmxWork(storeNumber, reason) {
    void storeNumber;
    await releasePrioritySlot(PRIORITY.MIC, reason || `daily count finished (store ${storeNumber})`);
}

function touchPipelineStep(storeNumber, stepLabel) {
    refreshScrapePauseTimeout();
    return setCheckpoint(storeNumber, { stepLabel: String(stepLabel || '').trim() });
}

async function probeOpenCounts(storeNumber, options = {}) {
    if (!options.forceRefresh) {
        const cached = readCachedProbe(storeNumber);
        if (cached) {
            log.info(`Using cached open-count probe for store ${storeNumber}`);
            return cached;
        }
    }

    let browser;
    let page;
    await beginDailyCountMmxWork(`daily count status probe (store ${storeNumber})`, storeNumber);
    try {
        ({ browser, page } = await openMacromatixBrowser(withStoreMmxOptions(storeNumber, options)));
        const cfg = loadMmxStockCountConfig();
        await page.goto(cfg.url, { waitUntil: 'load', timeout: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000) });
        await page.waitForTimeout(1500);
        await selectStoreInMacromatix(page, storeNumber);
        const openCounts = await listOpenCounts(page, cfg);
        const result = {
            success: true,
            storeNumber: String(storeNumber),
            openCounts,
            hasOpenCount: openCounts.length > 0,
            cached: false,
        };
        writeCachedProbe(storeNumber, { ...result, cached: true });
        return result;
    } finally {
        await closeBrowserQuietly(browser, 'daily count probe');
        await endDailyCountMmxWork(storeNumber, `daily count probe finished (store ${storeNumber})`);
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
    invalidateDailyCountProbeCache(storeNumber);
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

        await beginDailyCountMmxWork(`daily count prepare (store ${storeNumber})`, storeNumber);
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
                log.info(`Store ${storeNumber}: no red variances - applying daily count immediately`);
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
                await endDailyCountMmxWork(storeNumber, `daily count prepare ended without session (store ${storeNumber})`);
            }
        }
    });
}

async function applyDailyCountSessionWork(storeNumber, sessionId, options = {}) {
    if (getLocalHoldCount(PRIORITY.MIC) === 0) {
        await beginDailyCountMmxWork(`daily count apply (store ${storeNumber})`, storeNumber);
    } else {
        refreshScrapePauseTimeout();
    }

    try {
        const session = getSession(storeNumber, sessionId);
        if (!session?.page) {
            throw new Error('Daily count session expired - submit again.');
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
        await endDailyCountMmxWork(storeNumber, `daily count apply finished (store ${storeNumber})`);
    }
}

async function cancelDailyCountSession(storeNumber) {
    await destroySessionsForStore(storeNumber, 'recount');
    await clearCheckpoint(storeNumber);
    await endDailyCountMmxWork(storeNumber, `daily count session cancelled (store ${storeNumber})`);
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
    invalidateDailyCountProbeCache,
    prepareDailyCountForMmx,
    applyDailyCountSessionWork,
    cancelDailyCountSession,
    getDailyCountPipelineStatus,
    isDailyCountPipelineBusy,
    beginDailyCountMmxWork,
    endDailyCountMmxWork,
};
