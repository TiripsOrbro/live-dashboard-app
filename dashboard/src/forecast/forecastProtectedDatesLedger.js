const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
const { writeJsonAtomic } = require('./atomicJson');
const { defaultPublicHolidaysByArea } = require('./forecastPublicHolidays2026');

const SETTINGS_FILE = path.join(paths.dashboard.data, 'forecast-protected-dates.json');
const DEFAULT_AREAS = ['VIC-1', 'WA-1', 'QLD-1'];

function normalizeDateKey(value) {
    const date = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function normalizeAreaKey(value) {
    return String(value || '').trim();
}

function normalizeLabel(value) {
    const label = String(value || '').trim();
    return label || null;
}

/** Accept legacy string dates or { date, label } objects. */
function normalizeProtectedEntry(raw) {
    if (typeof raw === 'string') {
        const date = normalizeDateKey(raw);
        return date ? { date, label: null } : null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const date = normalizeDateKey(raw.date);
    if (!date) return null;
    return { date, label: normalizeLabel(raw.label) };
}

function normalizeEntriesList(values) {
    const seen = new Set();
    const out = [];
    for (const raw of values || []) {
        const entry = normalizeProtectedEntry(raw);
        if (!entry || seen.has(entry.date)) continue;
        seen.add(entry.date);
        out.push(entry);
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
}

function entriesToDates(entries) {
    return normalizeEntriesList(entries).map((row) => row.date);
}

function defaultSettings() {
    return {
        byArea: defaultPublicHolidaysByArea(),
        updatedAt: null,
        updatedBy: null,
        seededFrom: '2026-public-holidays',
    };
}

function mergeSettingsWithDefaults(raw = {}) {
    const base = defaultSettings();
    const byArea = { ...base.byArea };
    if (raw.byArea && typeof raw.byArea === 'object') {
        for (const [area, entries] of Object.entries(raw.byArea)) {
            const key = normalizeAreaKey(area);
            if (!key) continue;
            byArea[key] = normalizeEntriesList(entries);
        }
    }
    return {
        ...base,
        byArea,
        updatedAt: raw.updatedAt || null,
        updatedBy: raw.updatedBy || null,
        seededFrom: raw.seededFrom || null,
    };
}

function readProtectedDatesSettings() {
    if (!fs.existsSync(SETTINGS_FILE)) return defaultSettings();
    try {
        const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        return mergeSettingsWithDefaults(raw);
    } catch {
        return defaultSettings();
    }
}

function ensureProtectedDatesInitialized(updatedBy = 'system') {
    if (fs.existsSync(SETTINGS_FILE)) return readProtectedDatesSettings();
    const doc = defaultSettings();
    doc.updatedAt = new Date().toISOString();
    doc.updatedBy = updatedBy;
    writeJsonAtomic(SETTINGS_FILE, doc);
    return doc;
}

function writeProtectedDatesSettings(patch = {}, updatedBy = null) {
    const prev = readProtectedDatesSettings();
    const byArea = { ...prev.byArea };
    if (patch.byArea && typeof patch.byArea === 'object') {
        for (const [area, entries] of Object.entries(patch.byArea)) {
            const key = normalizeAreaKey(area);
            if (!key) continue;
            byArea[key] = normalizeEntriesList(entries);
        }
    }
    if (patch.area != null) {
        const key = normalizeAreaKey(patch.area);
        if (key) {
            if (Array.isArray(patch.entries)) {
                byArea[key] = normalizeEntriesList(patch.entries);
            } else if (Array.isArray(patch.dates)) {
                byArea[key] = normalizeEntriesList(patch.dates);
            }
        }
    }
    const doc = {
        byArea,
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy ? String(updatedBy).trim() : prev.updatedBy,
        seededFrom: prev.seededFrom || '2026-public-holidays',
    };
    writeJsonAtomic(SETTINGS_FILE, doc);
    return doc;
}

function getProtectedEntriesForArea(areaId) {
    const settings = readProtectedDatesSettings();
    const area = normalizeAreaKey(areaId);
    return normalizeEntriesList(settings.byArea?.[area]);
}

function getProtectedDatesForArea(areaId) {
    return entriesToDates(getProtectedEntriesForArea(areaId));
}

function getProtectedDatesForStore(storeNumber) {
    const { getStoreConfig } = require('../../../stores/src/storeList');
    const cfg = getStoreConfig(storeNumber) || {};
    return getProtectedDatesForArea(cfg.area);
}

function isProtectedForecastDate(areaId, dateKey) {
    const date = normalizeDateKey(dateKey);
    if (!date) return false;
    return getProtectedDatesForArea(areaId).includes(date);
}

/** Drop PH-protected calendar days so submit runs do not overwrite them. */
function filterPlanForProtectedDates(storeNumber, plan) {
    const protectedSet = new Set(getProtectedDatesForStore(storeNumber));
    const skippedDates = [];
    const remaining = [];
    for (const day of plan || []) {
        if (protectedSet.has(day.date)) {
            skippedDates.push(day.date);
        } else {
            remaining.push(day);
        }
    }
    return { plan: remaining, skippedDates };
}

module.exports = {
    SETTINGS_FILE,
    DEFAULT_AREAS,
    normalizeDateKey,
    normalizeProtectedEntry,
    normalizeEntriesList,
    readProtectedDatesSettings,
    ensureProtectedDatesInitialized,
    writeProtectedDatesSettings,
    getProtectedEntriesForArea,
    getProtectedDatesForArea,
    getProtectedDatesForStore,
    isProtectedForecastDate,
    filterPlanForProtectedDates,
};
