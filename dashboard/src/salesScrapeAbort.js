/** Cooperative abort for dashboard sales scrape when stock count / orders take MMX. */

const { closeBrowserQuietly } = require('../../mmx/src/browserLifecycle');

class MmxWorkAbortedError extends Error {
    constructor(reason = 'MMX work aborted') {
        super(reason);
        this.name = 'MmxWorkAbortedError';
        this.aborted = true;
    }
}

let abortRequested = false;
let activeBrowser = null;
let abortCloseTimer = null;

const ABORT_FORCE_CLOSE_MS = Number(process.env.SALES_SCRAPE_ABORT_CLOSE_MS || 2500);

function isSalesScrapeAbortRequested() {
    return abortRequested;
}

function resetSalesScrapeAbort() {
    abortRequested = false;
    if (abortCloseTimer) {
        clearTimeout(abortCloseTimer);
        abortCloseTimer = null;
    }
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
    // Cooperative abort: scrape checks the flag and closes its own browser. A delayed
    // force-close avoids racing workers mid-page.evaluate (immediate close caused retry storms).
    if (abortCloseTimer) clearTimeout(abortCloseTimer);
    abortCloseTimer = setTimeout(() => {
        abortCloseTimer = null;
        const browser = activeBrowser;
        if (!browser) return;
        activeBrowser = null;
        closeBrowserQuietly(browser, `sales-scrape-abort:${reason}`).catch(() => {});
    }, ABORT_FORCE_CLOSE_MS);
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
