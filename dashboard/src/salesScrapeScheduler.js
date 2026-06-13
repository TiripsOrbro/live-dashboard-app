const { isMmxResourceBusy } = require('../../mmx/src/mmxResourceGate');
const { anyStoreInActiveScrapeWindow } = require('./scrapeSchedule');

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const INTERVAL_MS = Math.max(30, Number(process.env.SCRAPE_FAST_INTERVAL_SECONDS || 120)) * 1000;

/**
 * @param {{
 *   runFullScrape: (opts?: object) => Promise<unknown>,
 *   shouldPrimeOnBoot?: () => boolean,
 *   isScrapeInFlight?: () => boolean,
 * }} handlers
 */
function startSalesScrapeScheduler(handlers) {
    const { runFullScrape, shouldPrimeOnBoot, isScrapeInFlight } = handlers;

    let intervalId = null;
    let bootTimeoutId = null;

    const intervalTick = async () => {
        try {
            if (!anyStoreInActiveScrapeWindow()) return;
            if (isScrapeInFlight?.()) return;
            if (isMmxResourceBusy()) return;
            await runFullScrape({ scrapeReason: 'interval' });
        } catch (error) {
            console.warn('[Dashboard] Interval sales scrape failed:', error.message);
        }
    };

    intervalId = setInterval(intervalTick, INTERVAL_MS);
    intervalId.unref?.();

    if (shouldPrimeOnBoot?.()) {
        bootTimeoutId = setTimeout(async () => {
            try {
                await runFullScrape({ scrapeReason: 'boot-prime' });
            } catch (error) {
                console.warn('[Dashboard] Boot prime scrape failed:', error.message);
            }
        }, 3000);
        bootTimeoutId.unref?.();
    }

    console.log(
        `[Dashboard] Sales scrape scheduler — full market every ${INTERVAL_MS / 1000}s during store active hours (${TIME_ZONE})`
    );

    return {
        cancel() {
            if (intervalId) clearInterval(intervalId);
            if (bootTimeoutId) clearTimeout(bootTimeoutId);
        },
    };
}

module.exports = {
    startSalesScrapeScheduler,
};
