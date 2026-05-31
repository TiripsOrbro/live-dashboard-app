/** Blocks dashboard sales scraping while Macromatix stock count / order entry holds a browser session. */

let holdCount = 0;
const idleWaiters = [];

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
};
