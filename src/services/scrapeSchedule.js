const { getStoreList, getStoreConfig, resolveHours, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('./storeList');

const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const PRE_OPEN_HOURS = Number(process.env.SCRAPE_PRE_OPEN_HOURS || 2);
const POST_CLOSE_RETAIN_HOURS = Number(process.env.SCRAPE_POST_CLOSE_RETAIN_HOURS || 1);

function melbourneWallClock(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: TIME_ZONE,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    const hour = get('hour');
    const minute = get('minute');
    return { hour, minute, minuteOfDay: hour * 60 + minute };
}

function resolveStoreHoursForSchedule(store, now = new Date()) {
    if (store?.hoursByDay) {
        return resolveHours(store, now);
    }
    if (Number.isFinite(store?.openHour) && Number.isFinite(store?.closeHour)) {
        return { openHour: store.openHour, closeHour: store.closeHour };
    }
    const cfg = getStoreConfig(store?.storeNumber);
    if (cfg) {
        return {
            openHour: cfg.openHour,
            closeHour: cfg.closeHour,
        };
    }
    return { openHour: DEFAULT_OPEN_HOUR, closeHour: DEFAULT_CLOSE_HOUR };
}

/**
 * Scrape lifecycle for a store (Melbourne wall clock, from `.storelist` hours):
 * - active: PRE_OPEN_HOURS before open → closeHour (scrape Macromatix)
 * - retain: closeHour → closeHour + POST_CLOSE_RETAIN_HOURS (serve last data, no scrape)
 * - idle: otherwise (empty dashboard data until next active window)
 */
function getStoreScrapePhase(store, now = new Date()) {
    const { openHour, closeHour } = resolveStoreHoursForSchedule(store, now);
    const { minuteOfDay: t } = melbourneWallClock(now);
    const preOpen = Number.isFinite(PRE_OPEN_HOURS) && PRE_OPEN_HOURS >= 0 ? PRE_OPEN_HOURS : 2;
    const postRetain =
        Number.isFinite(POST_CLOSE_RETAIN_HOURS) && POST_CLOSE_RETAIN_HOURS >= 0 ? POST_CLOSE_RETAIN_HOURS : 1;

    const startMin = (openHour - preOpen) * 60;
    const closeMin = closeHour * 60;
    const retainMin = (closeHour + postRetain) * 60;

    // Close after midnight (e.g. closeHour 25 = 1:00 AM next calendar day).
    if (closeHour > 24) {
        const closeNextMin = (closeHour - 24) * 60;
        const retainNextMin = closeNextMin + postRetain * 60;
        const dayStartMin = Math.max(0, startMin);
        if (t >= dayStartMin || t < closeNextMin) return 'active';
        if (t >= closeNextMin && t < retainNextMin) return 'retain';
        return 'idle';
    }

    // Pre-open window starts the previous evening (rare).
    if (startMin < 0) {
        const startPrevMin = 24 * 60 + startMin;
        if (t >= startPrevMin || t < closeMin) return 'active';
        if (t >= closeMin && t < closeMin + postRetain * 60) return 'retain';
        return 'idle';
    }

    if (t >= startMin && t < closeMin) return 'active';
    if (t >= closeMin && t < retainMin) return 'retain';
    return 'idle';
}

function getStoreScrapePhaseByNumber(storeNumber, now = new Date()) {
    const cfg = getStoreConfig(storeNumber);
    if (!cfg) return 'idle';
    return getStoreScrapePhase(cfg, now);
}

function storesInActiveScrapeWindow(now = new Date()) {
    return getStoreList().filter((store) => getStoreScrapePhase(store, now) === 'active');
}

function anyStoreInActiveScrapeWindow(now = new Date()) {
    return storesInActiveScrapeWindow(now).length > 0;
}

/** True for the hour after close — serve last sales totals, do not scrape. */
function isPostCloseSalesGrace(store, now = new Date()) {
    return getStoreScrapePhase(store, now) === 'retain';
}

function formatScrapeWindow(store, now = new Date()) {
    const { openHour, closeHour } = resolveStoreHoursForSchedule(store, now);
    const preOpen = Number.isFinite(PRE_OPEN_HOURS) && PRE_OPEN_HOURS >= 0 ? PRE_OPEN_HOURS : 2;
    const postRetain =
        Number.isFinite(POST_CLOSE_RETAIN_HOURS) && POST_CLOSE_RETAIN_HOURS >= 0 ? POST_CLOSE_RETAIN_HOURS : 1;
    const startHour = openHour - preOpen;
    const retainEnd = closeHour + postRetain;
    return `${startHour}:00–${closeHour}:00 scrape, retain until ${retainEnd}:00`;
}

module.exports = {
    getStoreScrapePhase,
    getStoreScrapePhaseByNumber,
    storesInActiveScrapeWindow,
    anyStoreInActiveScrapeWindow,
    isPostCloseSalesGrace,
    formatScrapeWindow,
    melbourneWallClock,
    PRE_OPEN_HOURS,
    POST_CLOSE_RETAIN_HOURS,
};
