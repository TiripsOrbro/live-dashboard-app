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

const DEFAULT_AREA = 'Area 22';
const TEST_AREA = 'Test Store';
const PERTH_STORE_NAMES = ['midland', 'ellenbrook', 'canning vale', 'butler'];
const PERTH_STORE_NUMBERS = new Set(['3901', '3902', '3903', '3904']);
/** 375x / 376x — Queensland stores on Macromatix store picker. */
const QLD_STORE_NUMBER_RE = /^37[56]\d{2}$/;

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

function normalizeArea(value) {
    const s = String(value || '').trim();
    return s || DEFAULT_AREA;
}

function inferStoreTimeZone(storeNumber, storeName, explicit) {
    const fromFile = String(explicit || '').trim();
    if (fromFile) return fromFile;
    const name = String(storeName || '').trim().toLowerCase();
    const num = String(storeNumber || '').trim();
    if (PERTH_STORE_NUMBERS.has(num)) return 'Australia/Perth';
    if (PERTH_STORE_NAMES.some((n) => name.includes(n))) return 'Australia/Perth';
    if (QLD_STORE_NUMBER_RE.test(num)) return 'Australia/Brisbane';
    return TIME_ZONE;
}

function isNumericToken(value) {
    return /^-?\d+(?:\.\d+)?$/.test(String(value || '').trim());
}

/**
 * Parse the store list text into raw store objects:
 *   {
 *     storeNumber, storeName, area, timeZone,
 *     uniform?: {openHour, closeHour},
 *     hoursByDay?: {0..6: {openHour, closeHour}}
 *   }
 *
 * Two line shapes are supported:
 *   `3811 | Chirnside Park | 10 | 22 | Area 22 | Australia/Melbourne`  → uniform + metadata
 *   `3901 | Midland | Area 22 | Australia/Perth`                         → metadata + per-day lines
 *   `3901 | Midland`                                                      → defaults + per-day lines
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

        const storeName = parts[1] || storeNumber;
        const p2 = parts[2];
        const p3 = parts[3];
        const hasUniformHours = isNumericToken(p2) && isNumericToken(p3);
        const area = hasUniformHours ? parts[4] : parts[2];
        const zone = hasUniformHours ? parts[5] : parts[3];

        current = {
            storeNumber,
            storeName,
            area: normalizeArea(area),
            timeZone: inferStoreTimeZone(storeNumber, storeName, zone),
        };
        if (hasUniformHours) {
            current.uniform = normalizeHours(p2, p3);
        }
        byNumber.set(storeNumber, current);
        stores.push(current);
    }

    return stores;
}

/** Weekday index (0=Sun..6=Sat) for `date` in the dashboard time zone. */
function timeZoneWeekdayIndex(date, timeZone = TIME_ZONE) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
    return dayNameToIndex(wd);
}

/** Resolve a parsed store's hours for a given date: per-day override → uniform → defaults. */
function resolveHours(store, date) {
    if (store.hoursByDay) {
        const today = store.hoursByDay[timeZoneWeekdayIndex(date, store.timeZone || TIME_ZONE)];
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
        const out = {
            storeNumber: store.storeNumber,
            storeName: store.storeName,
            area: normalizeArea(store.area),
            timeZone: store.timeZone || inferStoreTimeZone(store.storeNumber, store.storeName),
            openHour,
            closeHour,
        };
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
