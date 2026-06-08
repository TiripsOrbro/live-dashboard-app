/** Cooperative abort for dashboard sales scrape when stock count / orders take MMX. */

class MmxWorkAbortedError extends Error {
    constructor(reason = 'MMX work aborted') {
        super(reason);
        this.name = 'MmxWorkAbortedError';
        this.aborted = true;
    }
}

let abortRequested = false;
let activeBrowser = null;

function isSalesScrapeAbortRequested() {
    return abortRequested;
}

function resetSalesScrapeAbort() {
    abortRequested = false;
}

function registerSalesScrapeBrowser(browser) {
    activeBrowser = browser || null;
}

function clearSalesScrapeBrowser(browser) {
    if (activeBrowser === browser) activeBrowser = null;
}

function requestSalesScrapeAbort(reason) {
    abortRequested = true;
    const browser = activeBrowser;
    if (!browser) return false;
    console.log(`[MMX Resource] Aborting in-flight sales scrape — ${reason}`);
    activeBrowser = null;
    browser.close().catch(() => {});
    return true;
}

function throwIfSalesScrapeAborted() {
    if (abortRequested) {
        throw new MmxWorkAbortedError('Sales scrape aborted — stock count / orders in progress');
    }
}

const { registerMmxAbortHandler } = require('./mmxResourceGate');
registerMmxAbortHandler(requestSalesScrapeAbort);

module.exports = {
    MmxWorkAbortedError,
    isSalesScrapeAbortRequested,
    resetSalesScrapeAbort,
    registerSalesScrapeBrowser,
    clearSalesScrapeBrowser,
    requestSalesScrapeAbort,
    throwIfSalesScrapeAborted,
};
