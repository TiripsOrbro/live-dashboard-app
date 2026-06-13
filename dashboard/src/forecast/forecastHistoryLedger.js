const fs = require('fs');
const path = require('path');

const { getStoreConfig, parseStoreList, resolveHours, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('../../../stores/src/storeList');
const { trimHourlyToTradingWindow, RAW_BASE_HOUR } = require('../salesProgress');
const { getStoreDateKey } = require('../sssg/sssgWeeklyLedger');

const paths = require('../../../src/paths');
const HISTORY_DIR = path.join(paths.dashboard.data, 'forecast-history');
const HISTORY_DAYS = Number(process.env.FORECAST_HISTORY_DAYS || 35);
const MIN_WEEKDAY_SAMPLES = 3;

function historyFilePath(storeNumber) {
    const key = String(storeNumber || '').replace(/[^0-9a-z]/gi, '');
    return path.join(HISTORY_DIR, `${key || 'unknown'}.json`);
}

function emptyStoreHistory(storeNumber) {
    const cfg = getStoreConfig(storeNumber) || {};
    return {
        storeNumber: String(storeNumber || '').trim(),
        timeZone: String(cfg.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim(),
        defaultOpenHour: Number.isFinite(cfg.openHour) ? cfg.openHour : DEFAULT_OPEN_HOUR,
        defaultCloseHour: Number.isFinite(cfg.closeHour) ? cfg.closeHour : DEFAULT_CLOSE_HOUR,
        days: {},
    };
}

function readStoreHistory(storeNumber) {
    const filePath = historyFilePath(storeNumber);
    if (!fs.existsSync(filePath)) return emptyStoreHistory(storeNumber);
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const base = emptyStoreHistory(storeNumber);
        return {
            ...base,
            ...raw,
            storeNumber: String(raw.storeNumber || storeNumber).trim(),
            days: raw.days && typeof raw.days === 'object' ? raw.days : {},
        };
    } catch {
        return emptyStoreHistory(storeNumber);
    }
}

function writeStoreHistory(doc) {
    const storeNumber = String(doc?.storeNumber || '').trim();
    if (!storeNumber) throw new Error('storeNumber is required');
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(historyFilePath(storeNumber), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    return doc;
}

function addDaysToIso(iso, days) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function weekdayForIso(iso, timeZone) {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(
        new Date(`${iso}T12:00:00`)
    );
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] ?? 0;
}

function sumHourly(values) {
    if (!Array.isArray(values)) return 0;
    return values.reduce((sum, v) => sum + (Number(v) || 0), 0);
}

function pruneOldDays(doc, keepDays = HISTORY_DAYS) {
    const keys = Object.keys(doc.days || {}).sort();
    while (keys.length > keepDays) {
        const oldest = keys.shift();
        delete doc.days[oldest];
    }
    return doc;
}

function normalizeHourlyEntry(entry = {}, storeDefaults = {}) {
    const openHour = Number.isFinite(entry.openHour) ? entry.openHour : storeDefaults.defaultOpenHour;
    const closeHour = Number.isFinite(entry.closeHour) ? entry.closeHour : storeDefaults.defaultCloseHour;
    let actual = Array.isArray(entry.actual) ? entry.actual.map((v) => Number(v) || 0) : [];
    let actualRaw = Array.isArray(entry.actualRaw) ? entry.actualRaw.map((v) => Number(v) || 0) : null;

    if (entry.actualFormat === 'raw-mmx' || (actualRaw && actualRaw.length && !actual.length)) {
        actualRaw = actualRaw || actual;
        const trimmed = trimHourlyToTradingWindow(actualRaw, [], openHour, closeHour);
        actual = trimmed.actual;
    } else if (actual.length > closeHour - openHour + 2) {
        const trimmed = trimHourlyToTradingWindow(actual, [], openHour, closeHour);
        actual = trimmed.actual;
    }

    const actualTotal =
        Number.isFinite(entry.actualTotal) && entry.actualTotal >= 0
            ? Math.round(entry.actualTotal * 100) / 100
            : Math.round(sumHourly(actual) * 100) / 100;

    return {
        openHour,
        closeHour,
        actual,
        actualRaw: actualRaw || undefined,
        actualTotal,
    };
}

function recordForecastHistoryDay(storeNumber, dateKey, entry, options = {}) {
    const store = String(storeNumber || '').trim();
    const date = String(dateKey || '').trim();
    if (!store || !date) return null;

    const doc = readStoreHistory(store);
    const normalized = normalizeHourlyEntry(entry, doc);
    if (normalized.actualTotal <= 0 && !options.force) return null;

    const timeZone = String(entry.timeZone || doc.timeZone || '').trim() || doc.timeZone;
    doc.days[date] = {
        date,
        weekday: weekdayForIso(date, timeZone),
        openHour: normalized.openHour,
        closeHour: normalized.closeHour,
        actual: normalized.actual,
        ...(normalized.actualRaw ? { actualRaw: normalized.actualRaw } : {}),
        actualTotal: normalized.actualTotal,
        finalized: options.finalized !== false,
        capturedAt: new Date().toISOString(),
        source: String(options.source || 'live').trim(),
    };
    pruneOldDays(doc);
    writeStoreHistory(doc);
    return doc.days[date];
}

function recordForecastHistoryFromStore(store, dateKey, options = {}) {
    if (!store?.storeNumber || !Array.isArray(store.actual)) return null;
    if (sumHourly(store.actual) <= 0 && !options.force) return null;

    const cfg = getStoreConfig(store.storeNumber) || {};
    const openHour = Number.isFinite(store.openHour) ? store.openHour : cfg.openHour ?? DEFAULT_OPEN_HOUR;
    const closeHour = Number.isFinite(store.closeHour) ? store.closeHour : cfg.closeHour ?? DEFAULT_CLOSE_HOUR;
    const trimmed = trimHourlyToTradingWindow(store.actual, store.forecast || [], openHour, closeHour);
    const day =
        dateKey ||
        getStoreDateKey(
            { storeNumber: store.storeNumber, timeZone: store.timeZone || cfg.timeZone },
            options.now || new Date()
        );

    return recordForecastHistoryDay(
        store.storeNumber,
        day,
        {
            openHour: trimmed.openHour,
            closeHour: trimmed.closeHour,
            actual: trimmed.actual,
            actualRaw: store.actual,
            actualFormat: 'raw-mmx',
            timeZone: store.timeZone || cfg.timeZone,
        },
        { ...options, source: options.source || 'live-scrape' }
    );
}

function listHistoryDays(storeNumber, maxDays = HISTORY_DAYS) {
    const doc = readStoreHistory(storeNumber);
    return Object.keys(doc.days || {})
        .sort()
        .slice(-maxDays)
        .map((date) => doc.days[date])
        .filter(Boolean);
}

function dailyRowsFromHistory(storeNumber, maxDays = HISTORY_DAYS) {
    return listHistoryDays(storeNumber, maxDays).map((day) => ({
        date: day.date,
        weekday: day.weekday,
        total: day.actualTotal,
        openHour: day.openHour,
        closeHour: day.closeHour,
        actual: day.actual,
    }));
}

function assessHistoryReadiness(storeNumber, options = {}) {
    const minSamples = Number(options.minWeekdaySamples) || MIN_WEEKDAY_SAMPLES;
    const days = listHistoryDays(storeNumber, HISTORY_DAYS);
    const byWeekday = new Map();
    for (const day of days) {
        if (!day.finalized || day.actualTotal <= 0) continue;
        const w = Number(day.weekday);
        if (!byWeekday.has(w)) byWeekday.set(w, []);
        byWeekday.get(w).push(day);
    }

    const weekdayGaps = [];
    for (let w = 0; w <= 6; w += 1) {
        const count = byWeekday.get(w)?.length || 0;
        if (count < minSamples) weekdayGaps.push(w);
    }

    const weekdayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return {
        storeNumber: String(storeNumber),
        daysRecorded: days.filter((d) => d.finalized && d.actualTotal > 0).length,
        daysRequired: HISTORY_DAYS,
        minWeekdaySamples: minSamples,
        ready: weekdayGaps.length === 0 && days.length >= minSamples * 7,
        weekdayGaps: weekdayGaps.map((w) => weekdayLabels[w] || String(w)),
        oldestDate: days[0]?.date || null,
        newestDate: days[days.length - 1]?.date || null,
    };
}

function buildHistoryCoverageForStores(storeNumbers, options = {}) {
    const stores = {};
    for (const storeNumber of storeNumbers || []) {
        stores[String(storeNumber)] = assessHistoryReadiness(storeNumber, options);
    }
    return { historyDays: HISTORY_DAYS, stores };
}

/**
 * Import bulk history. Accepts:
 * - { days: { "2026-05-01": { "3811": { actual: [...] } } } }
 * - { stores: { "3811": { days: { "2026-05-01": { actual: [...] } } } } }
 */
function loadParsedStore(storeNumber) {
    try {
        const storeListPath = fs.existsSync(path.join(paths.stores.root, '.storelist'))
            ? path.join(paths.stores.root, '.storelist')
            : path.join(paths.stores.root, '.storelist.example');
        if (!fs.existsSync(storeListPath)) return null;
        return parseStoreList(fs.readFileSync(storeListPath, 'utf8')).find((s) => s.storeNumber === storeNumber) || null;
    } catch {
        return null;
    }
}

function weekStartingMondayFromDate(isoDate, timeZone) {
    const wd = weekdayForIso(isoDate, timeZone);
    const daysFromMonday = (wd + 6) % 7;
    return addDaysToIso(isoDate, -daysFromMonday);
}

const WEEKDAY_OFFSET_FROM_MONDAY = [6, 0, 1, 2, 3, 4, 5];
const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function calendarDateForWeekdayIndex(weekStartingMonday, weekdayIndex) {
    const offset = WEEKDAY_OFFSET_FROM_MONDAY[Number(weekdayIndex)];
    if (offset === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(String(weekStartingMonday || ''))) return '';
    return addDaysToIso(weekStartingMonday, offset);
}

function weekColumnLabel(weeksAgo) {
    if (weeksAgo === 0) return 'Current week';
    if (weeksAgo === 1) return 'Last week';
    return `${weeksAgo + 1} weeks ago`;
}

function formatHourLabel(hour) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return '';
    const end = h + 1;
    const fmt = (v) => {
        if (v === 0 || v === 24) return '12am';
        if (v === 12) return '12pm';
        if (v < 12) return `${v}am`;
        return `${v - 12}pm`;
    };
    return `${fmt(h)}–${fmt(end)}`;
}

/**
 * Hourly sales grid for one store and weekday: columns = weeks ago (oldest first), rows = trading hours.
 */
function buildHistoryHourGrid(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const maxWeeks = Math.max(1, Math.min(8, Number(options.maxWeeks) || 5));
    const weekday = Number(options.weekday);
    const weekdayIndex =
        Number.isFinite(weekday) && weekday >= 0 && weekday <= 6
            ? weekday
            : weekdayForIso(
                  new Intl.DateTimeFormat('en-CA', {
                      timeZone: options.timeZone || 'Australia/Melbourne',
                  }).format(options.asOf || new Date()),
                  options.timeZone || 'Australia/Melbourne'
              );

    const doc = readStoreHistory(store);
    const cfg = getStoreConfig(store) || {};
    const timeZone = String(options.timeZone || doc.timeZone || cfg.timeZone || 'Australia/Melbourne').trim();
    const asOfIso =
        options.asOfIso ||
        new Intl.DateTimeFormat('en-CA', { timeZone }).format(options.asOf || new Date());
    const currentWeekStart = weekStartingMondayFromDate(asOfIso, timeZone);

    const refDate = new Date(`${calendarDateForWeekdayIndex(currentWeekStart, weekdayIndex) || asOfIso}T12:00:00`);
    const parsedStore = loadParsedStore(store);
    const hoursResolved = parsedStore
        ? resolveHours(parsedStore, refDate)
        : {
              openHour: Number.isFinite(cfg.openHour) ? cfg.openHour : DEFAULT_OPEN_HOUR,
              closeHour: Number.isFinite(cfg.closeHour) ? cfg.closeHour : DEFAULT_CLOSE_HOUR,
          };
    const open = hoursResolved.openHour;
    const close = hoursResolved.closeHour;

    const columns = [];
    for (let weeksAgo = maxWeeks - 1; weeksAgo >= 0; weeksAgo -= 1) {
        const weekStart = addDaysToIso(currentWeekStart, -7 * weeksAgo);
        const date = calendarDateForWeekdayIndex(weekStart, weekdayIndex);
        const day = date ? doc.days?.[date] : null;
        const hourly = [];
        if (day?.actual?.length) {
            for (let h = open; h < close; h += 1) {
                const idx = h - (Number.isFinite(day.openHour) ? day.openHour : open);
                hourly.push({
                    hour: h,
                    label: formatHourLabel(h),
                    sales: idx >= 0 && idx < day.actual.length ? Math.round((Number(day.actual[idx]) || 0) * 100) / 100 : 0,
                });
            }
        } else {
            for (let h = open; h < close; h += 1) {
                hourly.push({ hour: h, label: formatHourLabel(h), sales: null });
            }
        }
        columns.push({
            weeksAgo,
            label: weekColumnLabel(weeksAgo),
            weekStart,
            date: date || null,
            dayTotal: day?.actualTotal != null ? day.actualTotal : null,
            hasData: Boolean(day?.actual?.length),
            hourly,
        });
    }

    const rowHours = [];
    for (let h = open; h < close; h += 1) {
        rowHours.push({
            hour: h,
            label: formatHourLabel(h),
            values: columns.map((col) => {
                const cell = col.hourly.find((r) => r.hour === h);
                return cell?.sales ?? null;
            }),
        });
    }

    const dayTotals = columns.map((col) => col.dayTotal);

    return {
        storeNumber: store,
        storeName: cfg.storeName || parsedStore?.storeName || store,
        timeZone,
        weekday: weekdayIndex,
        weekdayLabel: WEEKDAY_LABELS[weekdayIndex] || String(weekdayIndex),
        asOf: asOfIso,
        currentWeekStart,
        openHour: open,
        closeHour: close,
        maxWeeks,
        columns: columns.map(({ weeksAgo, label, weekStart, date, dayTotal, hasData }) => ({
            weeksAgo,
            label,
            weekStart,
            date,
            dayTotal,
            hasData,
        })),
        rows: rowHours,
        dayTotals,
    };
}

function importForecastHistory(payload, options = {}) {
    const force = Boolean(options.force);
    let imported = 0;
    const storesTouched = new Set();

    const importDay = (storeNumber, dateKey, entry) => {
        const existing = readStoreHistory(storeNumber).days?.[dateKey];
        if (existing?.finalized && !force) return;
        const row = recordForecastHistoryDay(storeNumber, dateKey, entry, {
            force,
            finalized: true,
            source: options.source || 'import',
        });
        if (row) {
            imported += 1;
            storesTouched.add(String(storeNumber));
        }
    };

    if (payload?.days && typeof payload.days === 'object') {
        for (const [dateKey, storesMap] of Object.entries(payload.days)) {
            if (!storesMap || typeof storesMap !== 'object') continue;
            for (const [storeNumber, entry] of Object.entries(storesMap)) {
                importDay(storeNumber, dateKey, entry);
            }
        }
    }

    if (payload?.stores && typeof payload.stores === 'object') {
        for (const [storeNumber, storeBlock] of Object.entries(payload.stores)) {
            const days = storeBlock?.days;
            if (!days || typeof days !== 'object') continue;
            const defaults = {
                openHour: storeBlock.openHour,
                closeHour: storeBlock.closeHour,
                timeZone: storeBlock.timeZone,
            };
            for (const [dateKey, entry] of Object.entries(days)) {
                importDay(storeNumber, dateKey, { ...defaults, ...entry });
            }
        }
    }

    return {
        imported,
        stores: [...storesTouched].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    };
}

module.exports = {
    HISTORY_DIR,
    HISTORY_DAYS,
    RAW_BASE_HOUR,
    historyFilePath,
    readStoreHistory,
    writeStoreHistory,
    recordForecastHistoryDay,
    recordForecastHistoryFromStore,
    listHistoryDays,
    dailyRowsFromHistory,
    assessHistoryReadiness,
    buildHistoryCoverageForStores,
    buildHistoryHourGrid,
    importForecastHistory,
    normalizeHourlyEntry,
    weekdayForIso,
    addDaysToIso,
    sumHourly,
    WEEKDAY_LABELS,
    weekColumnLabel,
    formatHourLabel,
};
