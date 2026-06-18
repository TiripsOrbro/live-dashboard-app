/** Cooperative abort for forecast MMX browser when MIC work preempts. */

class MmxForecastAbortedError extends Error {
    constructor(reason = 'Forecast MMX aborted') {
        super(reason);
        this.name = 'MmxForecastAbortedError';
        this.aborted = true;
    }
}

let abortRequested = false;
let activeBrowser = null;

function isForecastMmxAbortRequested() {
    return abortRequested;
}

function resetForecastMmxAbort() {
    abortRequested = false;
}

function registerForecastMmxBrowser(browser) {
    activeBrowser = browser || null;
}

function clearForecastMmxBrowser(browser) {
    if (activeBrowser === browser) activeBrowser = null;
}

function requestForecastMmxAbort(reason) {
    abortRequested = true;
    const browser = activeBrowser;
    if (!browser) return false;
    console.log(`[MMX Queue] Aborting in-flight forecast MMX - ${reason}`);
    activeBrowser = null;
    browser.close().catch(() => {});
    return true;
}

function throwIfForecastMmxAborted() {
    if (abortRequested) {
        throw new MmxForecastAbortedError('Forecast MMX aborted - higher-priority work in progress');
    }
}

const { registerMmxAbortHandler } = require('../../mmx/src/mmxResourceGate');
const { getLocalSlotPriority, shouldAbortForPreempt, markPreemptHandled, PRIORITY } = require('../../mmx/src/mmxTaskQueue');

registerMmxAbortHandler((reason) => {
    const localPriority = getLocalSlotPriority();
    if (localPriority === PRIORITY.ADMIN || shouldAbortForPreempt(PRIORITY.ADMIN)) {
        markPreemptHandled();
        requestForecastMmxAbort(reason);
    }
});

module.exports = {
    MmxForecastAbortedError,
    isForecastMmxAbortRequested,
    resetForecastMmxAbort,
    registerForecastMmxBrowser,
    clearForecastMmxBrowser,
    requestForecastMmxAbort,
    throwIfForecastMmxAborted,
};
