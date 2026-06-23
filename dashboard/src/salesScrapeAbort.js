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
    if (abortRequested) return true;
    abortRequested = true;
    console.log(`[MMX Resource] Aborting in-flight sales scrape - ${reason}`);
    // Cooperative abort: scrape checks the flag and closes its own browser. Forcing
    // browser.close() here races workers mid-page.evaluate and causes "Session closed"
    // retry storms instead of a clean handoff to MIC stock-count work.
    return true;
}

function throwIfSalesScrapeAborted() {
    if (abortRequested) {
        throw new MmxWorkAbortedError('Sales scrape aborted - stock count / orders in progress');
    }
}

const { registerMmxAbortHandler } = require('../../mmx/src/mmxResourceGate');
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
