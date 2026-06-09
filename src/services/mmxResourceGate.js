/** Blocks dashboard sales scraping while Macromatix stock count / order entry holds a browser session. */

let holdCount = 0;
const idleWaiters = [];
const abortHandlers = new Set();
let pauseTimer = null;
const SCRAPE_PAUSE_MAX_MS = Number(process.env.MMX_SCRAPE_PAUSE_MAX_MS || 5 * 60 * 1000);

function registerMmxAbortHandler(handler) {
    if (typeof handler === 'function') abortHandlers.add(handler);
}

/** Force-stop in-flight MMX browsers (sales scrape, upselling, etc.) before stock count / orders. */
function abortCompetingMmxWork(reason) {
    const label = String(reason || 'stock count / orders').trim();
    for (const handler of abortHandlers) {
        try {
            handler(label);
        } catch (err) {
            console.warn('[MMX Resource] Abort handler failed:', err.message);
        }
    }
}

function clearPauseTimeout() {
    if (!pauseTimer) return;
    clearTimeout(pauseTimer);
    pauseTimer = null;
}

function schedulePauseTimeout() {
    clearPauseTimeout();
    if (SCRAPE_PAUSE_MAX_MS <= 0) return;
    pauseTimer = setTimeout(() => {
        pauseTimer = null;
        if (holdCount <= 0) return;
        console.log(
            `[MMX Resource] Scrape pause exceeded ${Math.round(SCRAPE_PAUSE_MAX_MS / 1000)}s — resuming sales scrape`
        );
        holdCount = 0;
        while (idleWaiters.length) {
            idleWaiters.shift()();
        }
    }, SCRAPE_PAUSE_MAX_MS);
}

function acquireMmxResource(reason) {
    const wasIdle = holdCount === 0;
    holdCount++;
    if (wasIdle && reason) {
        console.log(`[MMX Resource] Pausing sales scrape — ${reason}`);
    }
    if (holdCount === 1) {
        schedulePauseTimeout();
    }
}

function releaseMmxResource(reason) {
    clearPauseTimeout();
    if (holdCount <= 0) return;
    holdCount--;
    if (holdCount === 0) {
        console.log(
            `[MMX Resource] Sales scrape may resume${reason ? ` (${reason})` : ''}`
        );
        while (idleWaiters.length) {
            idleWaiters.shift()();
        }
    }
}

function isMmxResourceBusy() {
    return holdCount > 0;
}

function waitUntilMmxResourceIdle() {
    if (!isMmxResourceBusy()) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
}

module.exports = {
    acquireMmxResource,
    releaseMmxResource,
    isMmxResourceBusy,
    waitUntilMmxResourceIdle,
    registerMmxAbortHandler,
    abortCompetingMmxWork,
};
