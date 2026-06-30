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

/** Monday-start weeks: this week, next week, and the week after (Melbourne). */
function getSelectableForecastWeekStarts(fromDate = new Date()) {
    const currentWeekStart = getMelbourneWeekStart(fromDate);
    return [
        currentWeekStart,
        addDaysToIso(currentWeekStart, 7),
        addDaysToIso(currentWeekStart, 14),
    ];
}

/** All weeks shown in the forecast tool status table. */
function getTargetForecastWeekStarts(fromDate = new Date()) {
    return getSelectableForecastWeekStarts(fromDate);
}

function datesForWeekStart(weekStart) {
    const dates = [];
    for (let i = 0; i < 7; i += 1) {
        dates.push(addDaysToIso(weekStart, i));
    }
    return dates;
}

/** When submitting the current calendar week, only update from tomorrow onwards. */
function submitDatesForWeek(weekStart, fromDate = new Date()) {
    const dates = datesForWeekStart(weekStart);
    const currentWeekStart = getSelectableForecastWeekStarts(fromDate)[0];
    if (weekStart !== currentWeekStart) return dates;
    const tomorrow = addDaysToIso(getMelbourneTodayIso(fromDate), 1);
    const filtered = dates.filter((date) => date >= tomorrow);
    if (!filtered.length) {
        throw new Error('No remaining days to update this week (submissions start from tomorrow).');
    }
    return filtered;
}

/**
 * Resolve which calendar dates to forecast/submit.
 * @param {object} options
 * @param {string} [options.targetScope] - this-week | next-week | week-after | week | day
 * @param {string} [options.weekStart] - for scope=week, first of 7 consecutive days
 * @param {string} [options.date] - for scope=day
 */
function resolveForecastTarget(options = {}) {
    const fromDate = options.fromDate || new Date();
    const weeks = getSelectableForecastWeekStarts(fromDate);
    const scope = String(options.targetScope || options.scope || 'week-after').trim();

    if (scope === 'this-week') {
        const weekStart = weeks[0];
        return {
            scope,
            targetWeeks: [weekStart],
            dates: submitDatesForWeek(weekStart, fromDate),
            weekStart,
            partialCurrentWeek: true,
        };
    }
    if (scope === 'next-week') {
        const weekStart = weeks[1];
        return { scope, targetWeeks: [weekStart], dates: datesForWeekStart(weekStart), weekStart };
    }
    if (scope === 'day') {
        const date = String(options.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new Error('date is required for single-day forecast (YYYY-MM-DD).');
        }
        const weekStart = getMelbourneWeekStart(new Date(`${date}T12:00:00`));
        return { scope, targetWeeks: [weekStart], dates: [date], weekStart };
    }
    if (scope === 'week') {
        const weekStart = String(options.weekStart || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
            throw new Error('weekStart is required for custom week forecast (YYYY-MM-DD).');
        }
        const dates = submitDatesForWeek(weekStart, fromDate);
        return {
            scope,
            targetWeeks: [weekStart],
            dates,
            weekStart,
            partialCurrentWeek: weekStart === weeks[0] && dates.length < 7,
        };
    }
    // week-after (default; matches legacy 2-weeks-out behaviour)
    const weekStart = weeks[2];
    return { scope: 'week-after', targetWeeks: [weekStart], dates: datesForWeekStart(weekStart), weekStart };
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
    getSelectableForecastWeekStarts,
    getTargetForecastWeekStarts,
    resolveForecastTarget,
    datesForWeekStart,
    submitDatesForWeek,
    addDaysToIso,
    readLedger,
    writeLedger,
    markStoreWeekComplete,
    markStoreWeekPlatformComplete,
    normalizeStoreWeekRow,
    buildStatusForStores,
};
