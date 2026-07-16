const { mmxPauseScrapeForPriority } = require('../../mmx/src/mmxResourceGate');
const {
    hasPendingHigherPriority,
    hasBlockingWorkForPriority,
    PRIORITY,
} = require('../../mmx/src/mmxTaskQueue');
const { anyStoreInActiveScrapeWindow } = require('./scrapeSchedule');

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const INTERVAL_MS =
    Math.max(1, Number(process.env.VENDOR_SCRAPE_INTERVAL_MINUTES || 15)) * 60 * 1000;
/** Let sales boot-prime finish before the first vendor pass (was 45s — too eager). */
const VENDOR_BOOT_DELAY_MS = Math.max(
    60_000,
    Number(process.env.VENDOR_SCRAPE_BOOT_DELAY_MS || 3 * 60 * 1000)
);

/**
 * @param {{
 *   runVendorScrape: (opts?: object) => Promise<unknown>,
 *   isVendorScrapeInFlight?: () => boolean,
 *   isSalesScrapeInFlight?: () => boolean,
 * }} handlers
 */
function startVendorScrapeScheduler(handlers) {
    const { runVendorScrape, isVendorScrapeInFlight, isSalesScrapeInFlight } = handlers;

    let intervalId = null;
    let bootTimeoutId = null;
    let lastDeferLogAt = 0;

    const shouldSkipTick = () => {
        if (isSalesScrapeInFlight?.()) {
            const now = Date.now();
            if (now - lastDeferLogAt >= 5 * 60 * 1000) {
                console.log('[Dashboard] Vendor scrape deferred — sales scrape in flight');
                lastDeferLogAt = now;
            }
            return true;
        }
        if (!mmxPauseScrapeForPriority()) return false;
        let reason = '';
        if (hasPendingHigherPriority(PRIORITY.VENDOR)) reason = 'higher-priority MMX queue work pending';
        else if (hasBlockingWorkForPriority(PRIORITY.VENDOR)) reason = 'MMX queue slot blocked';
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

    // First vendor pass after sales has had time to prime (default 3 min).
    bootTimeoutId = setTimeout(async () => {
        try {
            if (!anyStoreInActiveScrapeWindow()) return;
            if (shouldSkipTick()) return;
            await runVendorScrape({ scrapeReason: 'vendor-boot' });
        } catch (error) {
            console.warn('[Dashboard] Boot vendor scrape failed:', error.message);
        }
    }, VENDOR_BOOT_DELAY_MS);
    bootTimeoutId.unref?.();

    console.log(
        `[Dashboard] Vendor scrape scheduler - every ${INTERVAL_MS / 60000}m during store active hours (${TIME_ZONE})` +
            ` (boot delay ${Math.round(VENDOR_BOOT_DELAY_MS / 1000)}s)` +
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
