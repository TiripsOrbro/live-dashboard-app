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

function markStoreWeekComplete(weekStart, storeNumber, meta = {}) {
    const store = String(storeNumber || '').trim();
    const ledger = readLedger(weekStart);
    ledger.stores[store] = ledger.stores[store] || {};
    ledger.stores[store][weekStart] = {
        completed: true,
        completedAt: meta.completedAt || new Date().toISOString(),
        completedBy: String(meta.completedBy || '').trim() || null,
    };
    return writeLedger(ledger);
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
            const row = ledger.stores?.[store]?.[weekStart];
            stores[store][weekStart] = {
                completed: Boolean(row?.completed),
                completedAt: row?.completedAt || null,
                completedBy: row?.completedBy || null,
            };
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
    buildStatusForStores,
};
