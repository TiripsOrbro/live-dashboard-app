const { assessHistoryReadiness, dailyRowsFromHistory, sumHourly, formatHourLabel, WEEKDAY_LABELS } = require('./forecastHistoryLedger');
const {
    getTargetForecastWeekStarts,
    addDaysToIso,
    markStoreWeekPlatformComplete,
} = require('./forecastStatusLedger');
const { saveManualEntryPacksForRun } = require('./forecastManualPack');const { getStoreConfig, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('../../../stores/src/storeList');

/**
 * Trim highest and lowest weekday totals from up to 5 weeks, average the remaining three.
 */
function computeTrimmedWeekdayAverages(dailyRows) {
    const byWeekday = new Map();
    for (const row of dailyRows || []) {
        const weekday = Number(row.weekday);
        const total = Number(row.total);
        if (!Number.isFinite(weekday) || weekday < 0 || weekday > 6) continue;
        if (!Number.isFinite(total) || total < 0) continue;
        if (!byWeekday.has(weekday)) byWeekday.set(weekday, []);
        byWeekday.get(weekday).push(total);
    }
    const out = new Map();
    for (const [weekday, values] of byWeekday) {
        if (values.length < 3) continue;
        const sorted = [...values].sort((a, b) => a - b);
        const trimmed = sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
        const avg = trimmed.reduce((sum, v) => sum + v, 0) / trimmed.length;
        out.set(weekday, Math.round(avg * 100) / 100);
    }
    return out;
}

function weekdayForIso(iso, timeZone = 'Australia/Melbourne') {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(
        new Date(`${iso}T12:00:00`)
    );
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] ?? 0;
}

function trimWeekdayDayRows(rows) {
    if (!rows?.length) return [];
    if (rows.length < 3) return [];
    const sorted = [...rows].sort((a, b) => (Number(a.total) || 0) - (Number(b.total) || 0));
    return sorted.length >= 5 ? sorted.slice(1, -1) : sorted;
}

/**
 * Average hourly share-of-day profiles per weekday (after trimming outlier days).
 * @returns {Map<number, { openHour, closeHour, shares: number[] }>}
 */
function computeTrimmedWeekdayHourlyMix(dailyRows) {
    const byWeekday = new Map();
    for (const row of dailyRows || []) {
        const weekday = Number(row.weekday);
        if (!Number.isFinite(weekday) || weekday < 0 || weekday > 6) continue;
        if (!Array.isArray(row.actual) || !row.actual.length) continue;
        const total = Number(row.total) || sumHourly(row.actual);
        if (total <= 0) continue;
        if (!byWeekday.has(weekday)) byWeekday.set(weekday, []);
        byWeekday.get(weekday).push({ ...row, total });
    }

    const out = new Map();
    for (const [weekday, rows] of byWeekday) {
        const trimmedDays = trimWeekdayDayRows(rows);
        if (!trimmedDays.length) continue;

        const hourCount = Math.max(...trimmedDays.map((r) => r.actual.length));
        const shareSums = new Array(hourCount).fill(0);
        let used = 0;
        for (const day of trimmedDays) {
            const total = Number(day.total) || sumHourly(day.actual);
            if (total <= 0) continue;
            used += 1;
            for (let i = 0; i < day.actual.length; i += 1) {
                shareSums[i] += (Number(day.actual[i]) || 0) / total;
            }
        }
        if (!used) continue;

        let shares = shareSums.map((s) => s / used);
        const shareTotal = shares.reduce((sum, v) => sum + v, 0) || 1;
        shares = shares.map((s) => s / shareTotal);

        const ref = trimmedDays[0];
        out.set(weekday, {
            openHour: Number.isFinite(ref.openHour) ? ref.openHour : DEFAULT_OPEN_HOUR,
            closeHour: Number.isFinite(ref.closeHour) ? ref.closeHour : DEFAULT_CLOSE_HOUR,
            shares,
        });
    }
    return out;
}

function buildDailyForecastPlan(dailyRows, targetDates, timeZone = 'Australia/Melbourne') {
    const averages = computeTrimmedWeekdayAverages(dailyRows);
    const plan = [];
    for (const date of targetDates || []) {
        const weekday = weekdayForIso(date, timeZone);
        const forecastTotal = averages.get(weekday);
        if (forecastTotal == null) continue;
        plan.push({ date, weekday, forecastTotal });
    }
    return plan;
}

function buildHourlyForecastPlan(dailyRows, targetDates, storeNumber) {
    const cfg = getStoreConfig(storeNumber) || {};
    const timeZone = String(cfg.timeZone || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();
    const dailyAvgs = computeTrimmedWeekdayAverages(dailyRows);
    const hourlyMix = computeTrimmedWeekdayHourlyMix(dailyRows);
    const defaultOpen = Number.isFinite(cfg.openHour) ? cfg.openHour : DEFAULT_OPEN_HOUR;
    const defaultClose = Number.isFinite(cfg.closeHour) ? cfg.closeHour : DEFAULT_CLOSE_HOUR;

    const plan = [];
    for (const date of targetDates || []) {
        const weekday = weekdayForIso(date, timeZone);
        const dailyTotal = dailyAvgs.get(weekday);
        const mix = hourlyMix.get(weekday);
        if (dailyTotal == null || !mix?.shares?.length) continue;

        const openHour = mix.openHour ?? defaultOpen;
        const hourly = mix.shares.map((share, index) => ({
            hour: openHour + index,
            forecast: Math.round(dailyTotal * share * 100) / 100,
        }));
        const shapedTotal = Math.round(hourly.reduce((sum, row) => sum + row.forecast, 0) * 100) / 100;
        const remainder = Math.round((dailyTotal - shapedTotal) * 100) / 100;
        if (hourly.length && Math.abs(remainder) >= 0.01) {
            hourly[hourly.length - 1].forecast = Math.round((hourly[hourly.length - 1].forecast + remainder) * 100) / 100;
        }

        plan.push({
            date,
            weekday,
            forecastTotal: dailyTotal,
            openHour,
            closeHour: mix.closeHour ?? defaultClose,
            hourly,
        });
    }
    return plan;
}

function buildTargetForecastDates(fromDate = new Date()) {
    const targetWeeks = getTargetForecastWeekStarts(fromDate);
    const dates = [];
    for (const weekStart of targetWeeks) {
        for (let i = 0; i < 7; i += 1) dates.push(addDaysToIso(weekStart, i));
    }
    return { targetWeeks, dates };
}

function loadDailyRowsForStore(storeNumber) {
    return dailyRowsFromHistory(storeNumber);
}

function buildForecastPreviewGrid(plan) {
    const days = plan || [];
    const hours = [];
    const hourSeen = new Set();
    for (const day of days) {
        for (const slot of day.hourly || []) {
            if (!hourSeen.has(slot.hour)) {
                hourSeen.add(slot.hour);
                hours.push(slot.hour);
            }
        }
    }
    hours.sort((a, b) => a - b);

    const rows = hours.map((hour) => ({
        hour,
        label: formatHourLabel(hour),
        values: days.map((day) => {
            const slot = (day.hourly || []).find((h) => h.hour === hour);
            return slot != null ? slot.forecast : null;
        }),
    }));

    return {
        columns: days.map((day) => ({
            date: day.date,
            weekday: day.weekday,
            weekdayLabel: WEEKDAY_LABELS[day.weekday] || String(day.weekday),
            forecastTotal: day.forecastTotal,
        })),
        rows,
        dayTotals: days.map((d) => d.forecastTotal),
        weekTotal: Math.round(days.reduce((sum, d) => sum + (Number(d.forecastTotal) || 0), 0) * 100) / 100,
    };
}

function previewForecastForStore(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    if (!store) throw new Error('Store number is required.');

    const readiness = assessHistoryReadiness(store);
    if (!readiness.ready && !options.force) {
        throw new Error(
            `Insufficient sales history for store ${store} (${readiness.daysRecorded} days, need ${readiness.minWeekdaySamples}+ samples per weekday; gaps: ${readiness.weekdayGaps.join(', ') || 'none'}). Import backfill or wait for more live capture.`
        );
    }

    const cfg = getStoreConfig(store) || {};
    const dailyRows = loadDailyRowsForStore(store);
    const { targetWeeks, dates } = buildTargetForecastDates();
    const plan = buildHourlyForecastPlan(dailyRows, dates, store);
    if (!plan.length) {
        throw new Error(`Could not build hourly forecast plan for store ${store}.`);
    }

    return {
        storeNumber: store,
        storeName: cfg.storeName || store,
        daysSampled: dailyRows.length,
        forecastDays: plan.length,
        targetWeeks,
        history: readiness,
        plan,
        grid: buildForecastPreviewGrid(plan),
    };
}

function previewForecastForStores(storeNumbers, options = {}) {
    const results = [];
    for (const storeNumber of storeNumbers || []) {
        try {
            results.push({ ok: true, ...previewForecastForStore(storeNumber, options) });
        } catch (err) {
            results.push({ storeNumber, ok: false, error: err.message || String(err) });
        }
    }
    return results;
}

async function runForecastForStore(storeNumber, options = {}) {
    const { writeForecastPlanToMmx } = require('../../../mmx/src/forecast/forecastScraper');
    const store = String(storeNumber || '').trim();
    if (!store) throw new Error('Store number is required.');

    const readiness = assessHistoryReadiness(store);
    if (!readiness.ready && !options.force) {
        throw new Error(
            `Insufficient sales history for store ${store} (${readiness.daysRecorded} days, need ${readiness.minWeekdaySamples}+ samples per weekday; gaps: ${readiness.weekdayGaps.join(', ') || 'none'}). Import backfill or wait for more live capture.`
        );
    }

    const cfg = getStoreConfig(store) || {};
    const dailyRows = loadDailyRowsForStore(store);
    const { targetWeeks, dates } = buildTargetForecastDates();
    const plan = buildHourlyForecastPlan(dailyRows, dates, store);
    if (!plan.length) {
        throw new Error(`Could not build hourly forecast plan for store ${store}.`);
    }

    if (typeof options.onProgress === 'function') {
        options.onProgress({
            type: 'store-start',
            storeNumber: store,
            storeName: cfg.storeName || store,
            dayCount: plan.length,
            targetWeeks,
        });
    }

    const writeResult = await writeForecastPlanToMmx(store, plan, options);
    return {
        storeNumber: store,
        storeName: cfg.storeName || store,
        daysSampled: dailyRows.length,
        forecastDays: plan.length,
        targetWeeks,
        history: readiness,
        ...writeResult,
    };
}

async function runForecastForStores(storeNumbers, options = {}) {
    const targetWeeks = getTargetForecastWeekStarts();
    const results = [];
    for (const storeNumber of storeNumbers || []) {
        try {
            const result = await runForecastForStore(storeNumber, options);
            results.push({ storeNumber, ok: true, ...result });
            if (options.markPlatformComplete !== false) {
                for (const weekStart of targetWeeks) {
                    markStoreWeekPlatformComplete(weekStart, storeNumber, 'mmx', {
                        completedBy: options.completedBy || null,
                    });
                }
            }
            if (typeof options.onProgress === 'function') {
                options.onProgress({ platform: 'mmx', type: 'store-complete', storeNumber, ok: true, ...result });
            }
        } catch (err) {
            const error = err.message || String(err);
            results.push({ storeNumber, ok: false, error });
            if (typeof options.onProgress === 'function') {
                options.onProgress({ platform: 'mmx', type: 'store-error', storeNumber, error });
            }
        }
    }
    return results;
}
async function runLifeLenzForecastForStores(storeNumbers, credentials, options = {}) {
    const { createAuthenticatedLifeLenzSession } = require('../../../lifelenz/src/lifelenzAuth');
    const { writeForecastPlanOnPage } = require('../../../lifelenz/src/lifelenzForecastScraper');
    const { closeBrowserQuietly } = require('../../../mmx/src/macromatixScraper');
    const targetWeeks = getTargetForecastWeekStarts();

    const email = String(credentials?.email || '').trim();
    const password = String(credentials?.password || '');
    if (!email || !password) {
        throw new Error('LifeLenz credentials are required.');
    }

    let browser;
    let page;
    let accessibleStores = [];
    const results = [];

    try {
        if (typeof options.onProgress === 'function') {
            options.onProgress({ platform: 'lifelenz', type: 'session-start', storeNumbers });
        }
        const session = await createAuthenticatedLifeLenzSession(email, password, options);
        browser = session.browser;
        page = session.page;
        accessibleStores = session.stores || [];

        for (const storeNumber of storeNumbers || []) {
            const store = String(storeNumber || '').trim();
            try {
                const preview = previewForecastForStore(store, options);
                if (typeof options.onProgress === 'function') {
                    options.onProgress({
                        platform: 'lifelenz',
                        type: 'store-start',
                        storeNumber: store,
                        storeName: preview.storeName,
                        dayCount: preview.plan?.length || 0,
                    });
                }
                const applied = await writeForecastPlanOnPage(page, store, preview.plan, accessibleStores, {
                    headless: options.headless,
                    onProgress: (payload) => {
                        if (typeof options.onProgress === 'function') {
                            options.onProgress({ platform: 'lifelenz', storeNumber: store, ...payload });
                        }
                    },
                });
                if (options.markPlatformComplete !== false) {
                    for (const weekStart of targetWeeks) {
                        markStoreWeekPlatformComplete(weekStart, store, 'lifelenz', {
                            completedBy: options.completedBy || null,
                        });
                    }
                }
                results.push({
                    storeNumber: store,
                    ok: true,
                    storeName: preview.storeName,
                    forecastDays: applied.length,
                    lifelenz: applied,
                });
                if (typeof options.onProgress === 'function') {
                    options.onProgress({
                        platform: 'lifelenz',
                        type: 'store-complete',
                        storeNumber: store,
                        ok: true,
                        forecastDays: applied.length,
                    });
                }
            } catch (err) {
                const error = err.message || String(err);
                results.push({ storeNumber: store, ok: false, error });
                if (typeof options.onProgress === 'function') {
                    options.onProgress({
                        platform: 'lifelenz',
                        type: 'store-error',
                        storeNumber: store,
                        error,
                    });
                }
            }
        }
    } finally {
        if (!options.keepBrowserOpen) {
            await closeBrowserQuietly(browser, 'lifelenz-forecast-batch');
        }
    }

    return results;
}

async function runCombinedForecastForStores(storeNumbers, options = {}) {
    const targetWeeks = getTargetForecastWeekStarts();
    const onProgress = options.onProgress;

    const mmxOptions = {
        ...options,
        onProgress: (payload) => onProgress?.({ platform: 'mmx', ...payload }),
    };

    const mmxPromise = runForecastForStores(storeNumbers, mmxOptions);

    let lifelenzPromise = Promise.resolve([]);
    if (options.lifelenzCredentials) {
        lifelenzPromise = runLifeLenzForecastForStores(storeNumbers, options.lifelenzCredentials, {
            ...options,
            onProgress: (payload) => onProgress?.({ platform: 'lifelenz', ...payload }),
        });
    }

    const [mmxResults, lifelenzResults] = await Promise.all([mmxPromise, lifelenzPromise]);

    const manualSaved =
        options.saveManualOnFailure !== false
            ? saveManualEntryPacksForRun(
                  storeNumbers,
                  mmxResults,
                  lifelenzResults,
                  targetWeeks,
                  (store) => previewForecastForStore(store, { force: options.force }).plan
              )
            : [];

    return {
        mmxResults,
        lifelenzResults,
        lifelenzSkipped: !options.lifelenzCredentials,
        targetWeeks,
        manualSaved,
    };
}
module.exports = {
    computeTrimmedWeekdayAverages,
    computeTrimmedWeekdayHourlyMix,
    buildDailyForecastPlan,
    buildHourlyForecastPlan,
    buildTargetForecastDates,
    loadDailyRowsForStore,
    buildForecastPreviewGrid,
    previewForecastForStore,
    previewForecastForStores,
    runForecastForStore,
    runForecastForStores,
    runLifeLenzForecastForStores,
    runCombinedForecastForStores,
};
