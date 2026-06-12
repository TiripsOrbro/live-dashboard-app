const { getFastScrapePlan } = require('./scrapePresence');
const { isMmxResourceBusy } = require('../../mmx/src/mmxResourceGate');

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const FAST_INTERVAL_MS = Math.max(30, Number(process.env.SCRAPE_FAST_INTERVAL_SECONDS || 120)) * 1000;

function melbourneWallClock(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: TIME_ZONE,
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false,
    }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    return { hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** Milliseconds until the next top-of-hour in the dashboard timezone. */
function msUntilNextHourBoundary(now = new Date()) {
    const { minute, second } = melbourneWallClock(now);
    const ms = now.getMilliseconds();
    const secondsRemaining = (60 - minute - 1) * 60 + (60 - second);
    return Math.max(0, secondsRemaining * 1000 - ms);
}

/**
 * @param {{
 *   runFullScrape: (opts?: object) => Promise<unknown>,
 *   runFastScrape: (plan: { mode: string, storeNumbers: string[], reason: string }) => Promise<unknown>,
 *   shouldPrimeOnBoot?: () => boolean,
 *   isScrapeInFlight?: () => boolean,
 * }} handlers
 */
function startSalesScrapeScheduler(handlers) {
    const { runFullScrape, runFastScrape, shouldPrimeOnBoot, isScrapeInFlight } = handlers;

    let hourlyTimeoutId = null;
    let fastIntervalId = null;
    let bootTimeoutId = null;

    const scheduleHourly = () => {
        const delay = msUntilNextHourBoundary();
        hourlyTimeoutId = setTimeout(async () => {
            try {
                await runFullScrape({ scrapeReason: 'hourly' });
            } catch (error) {
                console.warn('[Dashboard] Hourly sales scrape failed:', error.message);
            }
            scheduleHourly();
        }, delay);
        hourlyTimeoutId.unref?.();
    };

    const fastTick = async () => {
        try {
            const plan = getFastScrapePlan();
            if (plan.mode === 'skip') return;
            if (isScrapeInFlight?.()) return;
            if (isMmxResourceBusy()) return;
            await runFastScrape(plan);
        } catch (error) {
            console.warn('[Dashboard] Fast sales scrape failed:', error.message);
        }
    };

    scheduleHourly();
    fastIntervalId = setInterval(fastTick, FAST_INTERVAL_MS);
    fastIntervalId.unref?.();

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

    const nextHourMin = Math.round(msUntilNextHourBoundary() / 60000);
    console.log(
        `[Dashboard] Sales scrape scheduler — hourly full market (next in ~${nextHourMin}m ${TIME_ZONE}), fast every ${FAST_INTERVAL_MS / 1000}s when users/kiosks active`
    );

    return {
        cancel() {
            if (hourlyTimeoutId) clearTimeout(hourlyTimeoutId);
            if (fastIntervalId) clearInterval(fastIntervalId);
            if (bootTimeoutId) clearTimeout(bootTimeoutId);
        },
    };
}

module.exports = {
    startSalesScrapeScheduler,
    msUntilNextHourBoundary,
};
