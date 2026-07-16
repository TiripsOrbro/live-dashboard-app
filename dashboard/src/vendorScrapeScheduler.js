const { isMmxResourceBusy, mmxPauseScrapeForPriority } = require('../../mmx/src/mmxResourceGate');
const {
    hasPendingHigherPriority,
    hasBlockingWorkForPriority,
    PRIORITY,
} = require('../../mmx/src/mmxTaskQueue');
const { anyStoreInActiveScrapeWindow } = require('./scrapeSchedule');

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const INTERVAL_MS =
    Math.max(1, Number(process.env.VENDOR_SCRAPE_INTERVAL_MINUTES || 15)) * 60 * 1000;

/**
 * @param {{
 *   runVendorScrape: (opts?: object) => Promise<unknown>,
 *   isVendorScrapeInFlight?: () => boolean,
 * }} handlers
 */
function startVendorScrapeScheduler(handlers) {
    const { runVendorScrape, isVendorScrapeInFlight } = handlers;

    let intervalId = null;
    let bootTimeoutId = null;
    let lastDeferLogAt = 0;

    const shouldSkipTick = () => {
        if (!mmxPauseScrapeForPriority()) return false;
        let reason = '';
        if (isMmxResourceBusy()) reason = 'MMX resource busy';
        else if (hasPendingHigherPriority(PRIORITY.SCRAPE)) reason = 'higher-priority MMX queue work pending';
        else if (hasBlockingWorkForPriority(PRIORITY.SCRAPE)) reason = 'MMX queue slot blocked';
        if (!reason) return false;
        const now = Date.now();
        if (now - lastDeferLogAt >= 5 * 60 * 1000) {
            console.log(`[Dashboard] Vendor scrape deferred — ${reason}`);
            lastDeferLogAt = now;
        }
        return true;
    };

    const intervalTick = async () => {
        try {
            if (!anyStoreInActiveScrapeWindow()) {
                try {
                    const { maybeTeardownOutsideWindow } = require('../../mmx/src/salesSessionPool');
                    await maybeTeardownOutsideWindow();
                } catch {
                    /* ignore */
                }
                return;
            }
            if (isVendorScrapeInFlight?.()) return;
            if (shouldSkipTick()) return;
            await runVendorScrape({ scrapeReason: 'vendor-interval' });
        } catch (error) {
            console.warn('[Dashboard] Interval vendor scrape failed:', error.message);
        }
    };

    intervalId = setInterval(intervalTick, INTERVAL_MS);
    intervalId.unref?.();

    // First vendor pass a few minutes after boot so sales can prime first.
    bootTimeoutId = setTimeout(async () => {
        try {
            if (!anyStoreInActiveScrapeWindow()) return;
            if (shouldSkipTick()) return;
            await runVendorScrape({ scrapeReason: 'vendor-boot' });
        } catch (error) {
            console.warn('[Dashboard] Boot vendor scrape failed:', error.message);
        }
    }, 45 * 1000);
    bootTimeoutId.unref?.();

    console.log(
        `[Dashboard] Vendor scrape scheduler - every ${INTERVAL_MS / 60000}m during store active hours (${TIME_ZONE})` +
            (mmxPauseScrapeForPriority() ? '' : ' (parallel with stock count / orders)')
    );

    return {
        cancel() {
            if (intervalId) clearInterval(intervalId);
            if (bootTimeoutId) clearTimeout(bootTimeoutId);
        },
    };
}

module.exports = {
    startVendorScrapeScheduler,
};
