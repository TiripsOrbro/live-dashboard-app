const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
const STATUS_DIR = path.join(paths.dashboard.data, 'forecast-status');
const FLEET_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

function melbourneWeekdayIndex(date = new Date()) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: FLEET_TIME_ZONE, weekday: 'short' }).format(
        date
    );
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] ?? 0;
}

function addDaysToIso(iso, days) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function getMelbourneTodayIso(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: FLEET_TIME_ZONE }).format(date);
}

function getMelbourneWeekStart(date = new Date()) {
    const todayIso = getMelbourneTodayIso(date);
    const daysFromMonday = (melbourneWeekdayIndex(date) + 6) % 7;
    return addDaysToIso(todayIso, -daysFromMonday);
}

function getTargetForecastWeekStarts(fromDate = new Date()) {
    const currentWeekStart = getMelbourneWeekStart(fromDate);
    return [addDaysToIso(currentWeekStart, 14)];
}

function ledgerFilePath(weekStart) {
    const key = String(weekStart || '').replace(/[^0-9-]/g, '');
    return path.join(STATUS_DIR, `${key}.json`);
}

function emptyLedger(weekStart) {
    return { weekStart, stores: {} };
}

function readLedger(weekStart) {
    const filePath = ledgerFilePath(weekStart);
    if (!fs.existsSync(filePath)) return emptyLedger(weekStart);
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
            weekStart: String(raw.weekStart || weekStart),
            stores: raw.stores && typeof raw.stores === 'object' ? raw.stores : {},
        };
    } catch {
        return emptyLedger(weekStart);
    }
}

function writeLedger(ledger) {
    const weekStart = String(ledger?.weekStart || '').trim();
    if (!weekStart) throw new Error('weekStart is required');
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    fs.writeFileSync(ledgerFilePath(weekStart), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    return ledger;
}

function normalizeStoreWeekRow(row = {}) {
    const mmxCompleted = Boolean(row.mmxCompleted ?? row.completed);
    const lifelenzCompleted = Boolean(row.lifelenzCompleted);
    const completed = Boolean(row.completed && row.mmxCompleted != null && row.lifelenzCompleted != null
        ? row.completed
        : mmxCompleted && lifelenzCompleted);
    return {
        mmxCompleted,
        lifelenzCompleted,
        completed,
        completedAt: row.completedAt || null,
        mmxCompletedAt: row.mmxCompletedAt || null,
        lifelenzCompletedAt: row.lifelenzCompletedAt || null,
        completedBy: row.completedBy || null,
    };
}

function markStoreWeekPlatformComplete(weekStart, storeNumber, platform, meta = {}) {
    const store = String(storeNumber || '').trim();
    const plat = String(platform || '').trim().toLowerCase();
    if (!store || !['mmx', 'lifelenz'].includes(plat)) {
        throw new Error('storeNumber and platform (mmx|lifelenz) are required.');
    }

    const ledger = readLedger(weekStart);
    ledger.stores[store] = ledger.stores[store] || {};
    const prev = ledger.stores[store][weekStart] || {};
    const now = meta.completedAt || new Date().toISOString();
    const completedBy = String(meta.completedBy || prev.completedBy || '').trim() || null;

    const next = {
        ...prev,
        mmxCompleted: plat === 'mmx' ? true : Boolean(prev.mmxCompleted ?? prev.completed),
        lifelenzCompleted: plat === 'lifelenz' ? true : Boolean(prev.lifelenzCompleted),
        completedBy,
    };
    if (plat === 'mmx') next.mmxCompletedAt = now;
    if (plat === 'lifelenz') next.lifelenzCompletedAt = now;
    next.completed = Boolean(next.mmxCompleted && next.lifelenzCompleted);
    if (next.completed) next.completedAt = now;

    ledger.stores[store][weekStart] = next;
    return writeLedger(ledger);
}

/** @deprecated Use markStoreWeekPlatformComplete for each platform. */
function markStoreWeekComplete(weekStart, storeNumber, meta = {}) {
    return markStoreWeekPlatformComplete(weekStart, storeNumber, 'mmx', meta);
}

function buildStatusForStores(storeNumbers, fromDate = new Date()) {
    const targetWeeks = getTargetForecastWeekStarts(fromDate);
    const stores = {};
    for (const storeNumber of storeNumbers) {
        const store = String(storeNumber || '').trim();
        if (!store) continue;
        stores[store] = {};
        for (const weekStart of targetWeeks) {
            const ledger = readLedger(weekStart);
            const row = normalizeStoreWeekRow(ledger.stores?.[store]?.[weekStart] || {});
            stores[store][weekStart] = row;
        }
    }
    return { targetWeeks, stores };
}

module.exports = {
    STATUS_DIR,
    getMelbourneWeekStart,
    getMelbourneTodayIso,
    getTargetForecastWeekStarts,
    addDaysToIso,
    readLedger,
    writeLedger,
    markStoreWeekComplete,
    markStoreWeekPlatformComplete,
    normalizeStoreWeekRow,
    buildStatusForStores,
};
