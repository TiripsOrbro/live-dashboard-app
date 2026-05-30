const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const STORELIST_PATH = path.join(PROJECT_ROOT, '.storelist');
const STORELIST_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.storelist.example');
const TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

/** Defaults applied when a store omits hours or none are configured at all. */
const DEFAULT_OPEN_HOUR = 10;
const DEFAULT_CLOSE_HOUR = 22;

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ALIASES = {
    sun: 0,
    mon: 1,
    tue: 2,
    tues: 2,
    wed: 3,
    weds: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    fri: 5,
    sat: 6,
};

/** Map a weekday word (Monday / Mon / Tues / ...) to a 0=Sunday..6=Saturday index, or -1. */
function dayNameToIndex(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return -1;
    const full = DAY_NAMES.indexOf(n);
    if (full >= 0) return full;
    return n in DAY_ALIASES ? DAY_ALIASES[n] : -1;
}

/**
 * Normalize an (open, close) pair. A close of `0` means midnight (24); closes past
 * midnight (e.g. 25 = 1AM) are allowed. Invalid/degenerate pairs fall back to defaults.
 */
function normalizeHours(open, close) {
    let openHour = Number(open);
    let closeHour = Number(close);
    if (closeHour === 0) closeHour = 24; // midnight written as 0
    if (!Number.isFinite(openHour) || openHour < 0 || openHour > 24) openHour = DEFAULT_OPEN_HOUR;
    if (!Number.isFinite(closeHour) || closeHour <= openHour || closeHour > 30) {
        openHour = DEFAULT_OPEN_HOUR;
        closeHour = DEFAULT_CLOSE_HOUR;
    }
    return { openHour: Math.trunc(openHour), closeHour: Math.trunc(closeHour) };
}

/**
 * Parse the store list text into raw store objects:
 *   { storeNumber, storeName, uniform?: {openHour, closeHour}, hoursByDay?: {0..6: {openHour, closeHour}} }
 *
 * Two line shapes are supported:
 *   `3811 | Chirnside Park | 10 | 22`     → same hours every day (uniform)
 *   `3901 | Midland`                       → header; per-day lines follow, e.g.
 *       `Friday | 10 | 24`                 → override just that weekday (indented or not)
 */
function parseStoreList(text) {
    const stores = [];
    const byNumber = new Map();
    let current = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const parts = line.split('|').map((p) => p.trim());
        const dayIdx = dayNameToIndex(parts[0]);

        if (dayIdx >= 0 && current) {
            const { openHour, closeHour } = normalizeHours(parts[1], parts[2]);
            if (!current.hoursByDay) current.hoursByDay = {};
            current.hoursByDay[dayIdx] = { openHour, closeHour };
            continue;
        }

        const storeNumber = (parts[0] || '').replace(/[^0-9]/g, '');
        if (!storeNumber) continue;

        if (byNumber.has(storeNumber)) {
            // Duplicate header — keep editing the first one (so stray repeats don't double up).
            current = byNumber.get(storeNumber);
            continue;
        }

        current = { storeNumber, storeName: parts[1] || storeNumber };
        if (parts[2] !== undefined && parts[2] !== '' && parts[3] !== undefined && parts[3] !== '') {
            current.uniform = normalizeHours(parts[2], parts[3]);
        }
        byNumber.set(storeNumber, current);
        stores.push(current);
    }

    return stores;
}

/** Weekday index (0=Sun..6=Sat) for `date` in the dashboard time zone. */
function timeZoneWeekdayIndex(date) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' }).format(date);
    return dayNameToIndex(wd);
}

/** Resolve a parsed store's hours for a given date: per-day override → uniform → defaults. */
function resolveHours(store, date) {
    if (store.hoursByDay) {
        const today = store.hoursByDay[timeZoneWeekdayIndex(date)];
        if (today) return { openHour: today.openHour, closeHour: today.closeHour };
    }
    if (store.uniform) return { openHour: store.uniform.openHour, closeHour: store.uniform.closeHour };
    return { openHour: DEFAULT_OPEN_HOUR, closeHour: DEFAULT_CLOSE_HOUR };
}

/** Resolve the active store list file: prefer `.storelist`, fall back to `.storelist.example`. */
function resolveStoreListPath() {
    if (fs.existsSync(STORELIST_PATH)) return STORELIST_PATH;
    if (fs.existsSync(STORELIST_EXAMPLE_PATH)) return STORELIST_EXAMPLE_PATH;
    return null;
}

/**
 * Read and parse the store list. This is the single source of truth for which stores
 * are scraped/served and their per-store trading hours. Read fresh each call (tiny file)
 * so edits to `.storelist` apply without a restart. `openHour`/`closeHour` are resolved
 * for the current day in the dashboard time zone; `hoursByDay` is included when a store
 * has a per-day schedule. De-duplicates by store number.
 */
function getStoreList() {
    const filePath = resolveStoreListPath();
    if (!filePath) return [];

    let text;
    try {
        text = fs.readFileSync(filePath, 'utf8');
    } catch {
        return [];
    }

    const now = new Date();
    return parseStoreList(text).map((store) => {
        const { openHour, closeHour } = resolveHours(store, now);
        const out = { storeNumber: store.storeNumber, storeName: store.storeName, openHour, closeHour };
        if (store.hoursByDay) out.hoursByDay = store.hoursByDay;
        return out;
    });
}

/** Look up a single store's config (today's resolved hours) by number, or null if not listed. */
function getStoreConfig(storeNumber) {
    const want = String(storeNumber || '').replace(/[^0-9]/g, '');
    if (!want) return null;
    return getStoreList().find((s) => s.storeNumber === want) || null;
}

module.exports = {
    getStoreList,
    getStoreConfig,
    parseStoreList,
    resolveHours,
    DEFAULT_OPEN_HOUR,
    DEFAULT_CLOSE_HOUR,
};
