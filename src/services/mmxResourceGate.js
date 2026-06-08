/** Blocks dashboard sales scraping while Macromatix stock count / order entry holds a browser session. */

let holdCount = 0;
const idleWaiters = [];
const abortHandlers = new Set();

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

function acquireMmxResource(reason) {
    const wasIdle = holdCount === 0;
    holdCount++;
    if (wasIdle && reason) {
        console.log(`[MMX Resource] Pausing sales scrape — ${reason}`);
    }
}

function releaseMmxResource(reason) {
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
