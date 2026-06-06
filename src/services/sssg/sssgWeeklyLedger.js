const fs = require('fs');
const path = require('path');
const { getStoreList, getStoreConfig, resolveHours } = require('../storeList');
const { TIME_ZONE } = require('../upselling/upsellingConfig');
const {
    computeFullDayActualTotal,
    computeFullDayLyTotal,
    computeActualSalesSoFar,
    computeLastYearSalesSoFar,
    computeSssgPercentFromTotals,
} = require('./sssgCalc');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const WEEKLY_DIR = path.join(PROJECT_ROOT, 'data', 'sssg-weekly');
const FLEET_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const FLEET_OPEN_HOUR = 10;

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
    const y2 = dt.getUTCFullYear();
    const m2 = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d2 = String(dt.getUTCDate()).padStart(2, '0');
    return `${y2}-${m2}-${d2}`;
}

function getMelbourneWeekStart(date = new Date()) {
    const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: FLEET_TIME_ZONE }).format(date);
    const daysFromMonday = (melbourneWeekdayIndex(date) + 6) % 7;
    return addDaysToIso(todayIso, -daysFromMonday);
}

function getStoreDateKey(storeOrNumber, date = new Date()) {
    const cfg =
        typeof storeOrNumber === 'object' && storeOrNumber
            ? storeOrNumber
            : getStoreConfig(storeOrNumber) || { timeZone: FLEET_TIME_ZONE };
    const timeZone = String(cfg.timeZone || FLEET_TIME_ZONE).trim() || FLEET_TIME_ZONE;
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(date);
}

function resolveStoreHours(store) {
    const cfg = getStoreConfig(store?.storeNumber) || store || {};
    const merged = { ...cfg, ...store };
    const hours = resolveHours(merged, new Date());
    return {
        openHour: Number.isFinite(merged.openHour) ? merged.openHour : hours.openHour,
        closeHour: Number.isFinite(merged.closeHour) ? merged.closeHour : hours.closeHour,
        timeZone: String(merged.timeZone || cfg.timeZone || FLEET_TIME_ZONE).trim() || FLEET_TIME_ZONE,
    };
}

function ledgerFilePath(weekStart) {
    const key = String(weekStart || '').replace(/[^0-9-]/g, '');
    return path.join(WEEKLY_DIR, `${key}.json`);
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
    const weekStart = String(ledger.weekStart || getMelbourneWeekStart());
    fs.mkdirSync(WEEKLY_DIR, { recursive: true });
    fs.writeFileSync(ledgerFilePath(weekStart), `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

function melbourneWallClock(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: FLEET_TIME_ZONE,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    return { hour: get('hour'), minute: get('minute'), weekday: melbourneWeekdayIndex(date) };
}

function isPastMondayFleetOpen(date = new Date()) {
    const { hour, minute, weekday } = melbourneWallClock(date);
    if (weekday !== 1) return weekday > 1; // Tue-Sun = new week already started
    return hour > FLEET_OPEN_HOUR || (hour === FLEET_OPEN_HOUR && minute >= 0);
}

function listLedgerWeekStarts() {
    if (!fs.existsSync(WEEKLY_DIR)) return [];
    return fs
        .readdirSync(WEEKLY_DIR)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .map((name) => name.replace(/\.json$/, ''));
}

function resetWeeklyLedgerIfNeeded(now = new Date()) {
    const currentWeek = getMelbourneWeekStart(now);
    if (!isPastMondayFleetOpen(now)) return false;

    let removed = 0;
    for (const weekStart of listLedgerWeekStarts()) {
        if (weekStart >= currentWeek) continue;
        try {
            fs.unlinkSync(ledgerFilePath(weekStart));
            removed++;
        } catch {
            /* ignore */
        }
    }
    if (removed) {
        console.log(`[SSSG] Cleared ${removed} prior weekly ledger file(s); week ${currentWeek}`);
    }
    return removed > 0;
}

function recordDayTotals(storeNumber, dateKey, totals, options = {}) {
    const store = String(storeNumber || '').trim();
    const day = String(dateKey || '').trim();
    if (!store || !day) return null;

    const weekStart = getMelbourneWeekStart(new Date(`${day}T12:00:00`));
    const ledger = readLedger(weekStart);
    if (!ledger.stores[store]) ledger.stores[store] = {};

    const existing = ledger.stores[store][day];
    if (existing?.finalized && !options.force) {
        return existing;
    }

    const entry = {
        actualTotal: Math.round((Number(totals.actualTotal) || 0) * 100) / 100,
        lyTotal: Math.round((Number(totals.lyTotal) || 0) * 100) / 100,
        capturedAt: new Date().toISOString(),
        finalized: Boolean(options.finalized),
    };
    ledger.stores[store][day] = entry;
    writeLedger(ledger);
    return entry;
}

function getStoreDayEntry(storeNumber, dateKey, weekStart = getMelbourneWeekStart()) {
    const ledger = readLedger(weekStart);
    return ledger.stores?.[String(storeNumber)]?.[String(dateKey)] || null;
}

function getStoreWeekDays(storeNumber, weekStart = getMelbourneWeekStart()) {
    const ledger = readLedger(weekStart);
    return ledger.stores?.[String(storeNumber)] || {};
}

function sumStoreWtdTotals(storeNumber, weekStart, todayPartial, todayKey) {
    const days = getStoreWeekDays(storeNumber, weekStart);
    let actualTotal = 0;
    let lyTotal = 0;

    for (const [dayKey, entry] of Object.entries(days)) {
        if (dayKey < weekStart || dayKey > todayKey) continue;
        if (dayKey === todayKey) continue;
        if (!entry) continue;
        actualTotal += Number(entry.actualTotal) || 0;
        lyTotal += Number(entry.lyTotal) || 0;
    }

    const todayEntry = days[todayKey];
    if (todayEntry?.finalized) {
        actualTotal += Number(todayEntry.actualTotal) || 0;
        lyTotal += Number(todayEntry.lyTotal) || 0;
    } else if (todayPartial) {
        actualTotal += Number(todayPartial.actualTotal) || 0;
        lyTotal += Number(todayPartial.lyTotal) || 0;
    } else if (todayEntry) {
        actualTotal += Number(todayEntry.actualTotal) || 0;
        lyTotal += Number(todayEntry.lyTotal) || 0;
    }

    return { actualTotal, lyTotal };
}

function computeStoreTodayPartial(store, slots, now = new Date()) {
    const { openHour, closeHour, timeZone } = resolveStoreHours(store);
    if (!Array.isArray(slots) || !slots.length) return null;
    const actualTotal = computeActualSalesSoFar(
        store.actual,
        store.forecast,
        openHour,
        closeHour,
        timeZone,
        now
    );
    const lyTotal = computeLastYearSalesSoFar(slots, openHour, closeHour, timeZone, now);
    return { actualTotal, lyTotal };
}

function computeStoreWtdSssgPercent(store, slots, now = new Date()) {
    const weekStart = getMelbourneWeekStart(now);
    const todayKey = getStoreDateKey(store, now);
    const todayEntry = getStoreDayEntry(store.storeNumber, todayKey, weekStart);

    let todayPartial = null;
    if (!todayEntry?.finalized) {
        todayPartial = computeStoreTodayPartial(store, slots, now);
    }

    const { actualTotal, lyTotal } = sumStoreWtdTotals(
        store.storeNumber,
        weekStart,
        todayPartial,
        todayKey
    );
    return computeSssgPercentFromTotals(actualTotal, lyTotal);
}

function computeAreaWtdSssgPercent(stores, getSlotsForStore, now = new Date()) {
    const weekStart = getMelbourneWeekStart(now);
    let actualTotal = 0;
    let lyTotal = 0;

    for (const store of stores || []) {
        const todayKey = getStoreDateKey(store, now);
        const slots = typeof getSlotsForStore === 'function' ? getSlotsForStore(store) : null;
        const todayEntry = getStoreDayEntry(store.storeNumber, todayKey, weekStart);

        let todayPartial = null;
        if (!todayEntry?.finalized && slots?.length) {
            todayPartial = computeStoreTodayPartial(store, slots, now);
        }

        const sums = sumStoreWtdTotals(store.storeNumber, weekStart, todayPartial, todayKey);
        actualTotal += sums.actualTotal;
        lyTotal += sums.lyTotal;
    }

    return computeSssgPercentFromTotals(actualTotal, lyTotal);
}

function captureEndOfDaySssg(store, slots) {
    if (!store?.storeNumber) return null;
    const { openHour, closeHour } = resolveStoreHours(store);
    const dateKey = getStoreDateKey(store);
    const actualTotal = computeFullDayActualTotal(store.actual, store.forecast, openHour, closeHour);
    const lyTotal = Array.isArray(slots) && slots.length
        ? computeFullDayLyTotal(slots, openHour, closeHour)
        : 0;

    if (actualTotal <= 0 && lyTotal <= 0) return null;

    return recordDayTotals(
        store.storeNumber,
        dateKey,
        { actualTotal, lyTotal },
        { finalized: true, force: false }
    );
}

function updateTodayPartialInLedger(store, slots, now = new Date()) {
    if (!store?.storeNumber || !Array.isArray(slots) || !slots.length) return null;
    const partial = computeStoreTodayPartial(store, slots, now);
    if (!partial || (partial.actualTotal <= 0 && partial.lyTotal <= 0)) return null;

    const dateKey = getStoreDateKey(store, now);
    const existing = getStoreDayEntry(store.storeNumber, dateKey);
    if (existing?.finalized) return existing;

    return recordDayTotals(store.storeNumber, dateKey, partial, { finalized: false });
}

function importWeeklyDays(payload, options = {}) {
    const weekStart = String(payload?.weekStart || getMelbourneWeekStart()).trim();
    const days = payload?.days;
    if (!days || typeof days !== 'object') {
        throw new Error('Import payload must include a "days" object');
    }

    const validStores = new Set(getStoreList().map((s) => String(s.storeNumber)));
    let imported = 0;

    for (const [dateKey, stores] of Object.entries(days)) {
        if (!stores || typeof stores !== 'object') continue;
        for (const [storeNumber, totals] of Object.entries(stores)) {
            if (!validStores.has(String(storeNumber))) {
                console.warn(`[SSSG] Import skip unknown store ${storeNumber}`);
                continue;
            }
            const actualTotal = Number(totals?.actualTotal);
            const lyTotal = Number(totals?.lyTotal);
            if (!Number.isFinite(actualTotal) || !Number.isFinite(lyTotal)) continue;
            recordDayTotals(
                storeNumber,
                dateKey,
                { actualTotal, lyTotal },
                { finalized: true, force: Boolean(options.force) }
            );
            imported++;
        }
    }

    return { weekStart, imported };
}

module.exports = {
    WEEKLY_DIR,
    FLEET_TIME_ZONE,
    FLEET_OPEN_HOUR,
    getMelbourneWeekStart,
    getStoreDateKey,
    isPastMondayFleetOpen,
    resetWeeklyLedgerIfNeeded,
    readLedger,
    recordDayTotals,
    getStoreDayEntry,
    getStoreWeekDays,
    captureEndOfDaySssg,
    updateTodayPartialInLedger,
    computeStoreWtdSssgPercent,
    computeAreaWtdSssgPercent,
    importWeeklyDays,
};
