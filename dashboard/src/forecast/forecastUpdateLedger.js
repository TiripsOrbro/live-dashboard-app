const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
const { writeJsonAtomic } = require('./atomicJson');
const UPDATES_DIR = path.join(paths.dashboard.data, 'forecast-updates');

function updatesFilePath(weekStart, storeNumber) {
    const week = String(weekStart || '').replace(/[^0-9-]/g, '');
    const store = String(storeNumber || '').replace(/[^0-9a-z]/gi, '');
    return path.join(UPDATES_DIR, week || 'unknown', `${store || 'unknown'}.json`);
}

function normalizeUpdatedBy(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === 'scheduler' || raw === 'auto') return 'auto';
    return raw;
}

function sourceFromUpdatedBy(updatedBy) {
    return normalizeUpdatedBy(updatedBy) === 'auto' ? 'auto' : 'user';
}

function emptyUpdatesDoc(storeNumber, weekStart) {
    return {
        storeNumber: String(storeNumber || '').trim(),
        weekStart: String(weekStart || '').trim(),
        days: {},
        lastRunAt: null,
        lastRunBy: null,
    };
}

function readForecastUpdates(storeNumber, weekStart) {
    const filePath = updatesFilePath(weekStart, storeNumber);
    if (!fs.existsSync(filePath)) return emptyUpdatesDoc(storeNumber, weekStart);
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const base = emptyUpdatesDoc(storeNumber, weekStart);
        return {
            ...base,
            ...raw,
            storeNumber: String(raw.storeNumber || storeNumber).trim(),
            weekStart: String(raw.weekStart || weekStart).trim(),
            days: raw.days && typeof raw.days === 'object' ? raw.days : {},
        };
    } catch {
        return emptyUpdatesDoc(storeNumber, weekStart);
    }
}

function writeForecastUpdates(doc) {
    const store = String(doc?.storeNumber || '').trim();
    const week = String(doc?.weekStart || '').trim();
    if (!store || !week) throw new Error('storeNumber and weekStart are required.');
    writeJsonAtomic(updatesFilePath(week, store), doc);
    return doc;
}

function recordForecastDayUpdate(weekStart, storeNumber, date, platform, meta = {}) {
    const store = String(storeNumber || '').trim();
    const week = String(weekStart || '').trim();
    const day = String(date || '').trim();
    const plat = String(platform || 'mmx').trim().toLowerCase();
    if (!store || !week || !day) return null;

    const doc = readForecastUpdates(store, week);
    const updatedBy = normalizeUpdatedBy(meta.updatedBy || doc.lastRunBy);
    const now = meta.updatedAt || new Date().toISOString();
    const prev = doc.days[day] || {};
    doc.days[day] = {
        updatedAt: now,
        updatedBy,
        source: sourceFromUpdatedBy(updatedBy),
        mmx: plat === 'mmx' ? true : Boolean(prev.mmx),
        lifelenz: plat === 'lifelenz' ? true : Boolean(prev.lifelenz),
    };
    doc.lastRunAt = now;
    doc.lastRunBy = updatedBy;
    return writeForecastUpdates(doc).days[day];
}

function buildForecastUpdatesForStores(storeNumbers, weekStart) {
    const stores = {};
    for (const storeNumber of storeNumbers || []) {
        stores[String(storeNumber)] = readForecastUpdates(storeNumber, weekStart);
    }
    return stores;
}

function isForecastDayCompleteForPlatform(storeNumber, weekStart, date, platform) {
    const doc = readForecastUpdates(storeNumber, weekStart);
    const row = doc.days?.[String(date || '').trim()];
    if (!row) return false;
    const plat = String(platform || 'mmx').trim().toLowerCase();
    return plat === 'lifelenz' ? Boolean(row.lifelenz) : Boolean(row.mmx);
}

/** Drop days marked complete in the ledger (opt-in via resumeFromLedger only). */
function filterPlanForPlatformResume(storeNumber, plan, weekStart, platform) {
    const store = String(storeNumber || '').trim();
    const week = String(weekStart || '').trim();
    const plat = String(platform || 'mmx').trim().toLowerCase();
    const skippedDates = [];
    const remaining = [];
    for (const day of plan || []) {
        if (isForecastDayCompleteForPlatform(store, week, day.date, plat)) {
            skippedDates.push(day.date);
        } else {
            remaining.push(day);
        }
    }
    return { plan: remaining, skippedDates };
}

function summarizeForecastUpdates(doc) {
    const days = doc?.days || {};
    const entries = Object.values(days);
    const latest = entries.reduce((best, row) => {
        if (!row?.updatedAt) return best;
        if (!best?.updatedAt || row.updatedAt > best.updatedAt) return row;
        return best;
    }, null);
    return {
        daysUpdated: entries.length,
        lastUpdatedAt: latest?.updatedAt || doc?.lastRunAt || null,
        lastUpdatedBy: latest?.updatedBy || doc?.lastRunBy || null,
        lastSource: latest?.source || sourceFromUpdatedBy(doc?.lastRunBy),
    };
}

module.exports = {
    UPDATES_DIR,
    readForecastUpdates,
    writeForecastUpdates,
    recordForecastDayUpdate,
    buildForecastUpdatesForStores,
    isForecastDayCompleteForPlatform,
    filterPlanForPlatformResume,
    summarizeForecastUpdates,
    sourceFromUpdatedBy,
    normalizeUpdatedBy,
};
