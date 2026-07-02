const { assessHistoryReadiness, dailyRowsFromHistory, sumHourly, formatHourLabel, WEEKDAY_LABELS } = require('./forecastHistoryLedger');
const {
    getTargetForecastWeekStarts,
    resolveForecastTarget,
    addDaysToIso,
    markStoreWeekPlatformComplete,
} = require('./forecastStatusLedger');
const { saveManualEntryPacksForRun } = require('./forecastManualPack');
const { loadAdjustmentRules } = require('./forecastAdjustmentsLedger');
const { LIFELENZ_DAY_PARTS } = require('../../../lifelenz/src/lifelenzDayParts');
const { recordForecastDayUpdate } = require('./forecastUpdateLedger');
const { getStoreConfig, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('../../../stores/src/storeList');

function wrapForecastProgress(options = {}, context = {}) {
    const weekStart = context.weekStart || getTargetForecastWeekStarts()[0];
    const storeNumber = context.storeNumber;
    const completedBy = context.completedBy || options.completedBy || null;
    const userOnProgress = options.onProgress;
    if (typeof userOnProgress !== 'function') return options.onProgress;

    return (payload) => {
        const type = String(payload?.type || '').trim();
        if ((type === 'day-done' || type === 'day-complete') && payload.date && storeNumber) {
            const platform = String(payload.platform || 'mmx').trim().toLowerCase();
            try {
                recordForecastDayUpdate(weekStart, storeNumber, payload.date, platform, { updatedBy: completedBy });
            } catch (err) {
                console.warn(`[Forecast] Could not record day update for ${storeNumber} ${payload.date}:`, err.message);
            }
        }
        userOnProgress(payload);
    };
}

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

function clonePlanDay(day) {
    return {
        ...day,
        hourly: (day.hourly || []).map((slot) => ({ ...slot })),
    };
}

function reshapeHourlyForTotal(day, newTotal) {
    const oldTotal = Number(day.forecastTotal) || 0;
    const roundedTotal = Math.round(newTotal * 100) / 100;
    if (!day.hourly?.length) {
        return { ...day, forecastTotal: roundedTotal, hourly: [] };
    }
    if (oldTotal <= 0) {
        const perHour = Math.round((roundedTotal / day.hourly.length) * 100) / 100;
        const hourly = day.hourly.map((slot) => ({ hour: slot.hour, forecast: perHour }));
        const shaped = Math.round(hourly.reduce((sum, row) => sum + row.forecast, 0) * 100) / 100;
        const remainder = Math.round((roundedTotal - shaped) * 100) / 100;
        if (hourly.length && Math.abs(remainder) >= 0.01) {
            hourly[hourly.length - 1].forecast = Math.round((hourly[hourly.length - 1].forecast + remainder) * 100) / 100;
        }
        return { ...day, forecastTotal: roundedTotal, hourly };
    }

    const hourly = day.hourly.map((slot) => ({
        hour: slot.hour,
        forecast: Math.round(roundedTotal * ((Number(slot.forecast) || 0) / oldTotal) * 100) / 100,
    }));
    const shapedTotal = Math.round(hourly.reduce((sum, row) => sum + row.forecast, 0) * 100) / 100;
    const remainder = Math.round((roundedTotal - shapedTotal) * 100) / 100;
    if (hourly.length && Math.abs(remainder) >= 0.01) {
        hourly[hourly.length - 1].forecast = Math.round((hourly[hourly.length - 1].forecast + remainder) * 100) / 100;
    }
    return { ...day, forecastTotal: roundedTotal, hourly };
}

function applyAdjustmentValue(baseValue, rule) {
    const base = Number(baseValue) || 0;
    if (rule.mode === 'percent') {
        return Math.round(base * (1 + Number(rule.value) / 100) * 100) / 100;
    }
    return Math.round((base + Number(rule.value)) * 100) / 100;
}

function lockedHourValuesFromRules(baseDay, hourRules) {
    const locked = new Map();
    for (const rule of hourRules || []) {
        const slot = (baseDay.hourly || []).find((h) => h.hour === rule.hour);
        const baseVal = slot != null ? Number(slot.forecast) || 0 : 0;
        locked.set(rule.hour, applyAdjustmentValue(baseVal, rule));
    }
    return locked;
}

function reshapeHourlyRespectingLocks(day, newTotal, baseDay, lockedHours) {
    const roundedTotal = Math.round(newTotal * 100) / 100;
    if (!day.hourly?.length) {
        return { ...day, forecastTotal: roundedTotal, hourly: [] };
    }

    const lockedSum = [...lockedHours.values()].reduce((sum, v) => sum + (Number(v) || 0), 0);
    let remainder = Math.round((roundedTotal - lockedSum) * 100) / 100;

    const unlocked = day.hourly.filter((slot) => !lockedHours.has(slot.hour));
    const baseUnlockedTotal = unlocked.reduce((sum, slot) => {
        const baseSlot = (baseDay.hourly || []).find((h) => h.hour === slot.hour);
        return sum + (Number(baseSlot?.forecast) || 0);
    }, 0);

    const hourly = day.hourly.map((slot) => {
        if (lockedHours.has(slot.hour)) {
            return { hour: slot.hour, forecast: lockedHours.get(slot.hour) };
        }
        const baseSlot = (baseDay.hourly || []).find((h) => h.hour === slot.hour);
        const baseVal = Number(baseSlot?.forecast) || 0;
        let forecast;
        if (unlocked.length <= 0) {
            forecast = 0;
        } else if (baseUnlockedTotal <= 0) {
            forecast = Math.round((remainder / unlocked.length) * 100) / 100;
        } else {
            forecast = Math.round(remainder * (baseVal / baseUnlockedTotal) * 100) / 100;
        }
        return { hour: slot.hour, forecast };
    });

    const lastUnlockedIdx = hourly.map((s, i) => (!lockedHours.has(s.hour) ? i : -1)).filter((i) => i >= 0).pop();
    const shapedTotal = Math.round(hourly.reduce((sum, row) => sum + row.forecast, 0) * 100) / 100;
    const fix = Math.round((roundedTotal - shapedTotal) * 100) / 100;
    if (lastUnlockedIdx != null && Math.abs(fix) >= 0.01) {
        hourly[lastUnlockedIdx].forecast = Math.round((hourly[lastUnlockedIdx].forecast + fix) * 100) / 100;
    }

    return { ...day, forecastTotal: roundedTotal, hourly };
}

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * Fold day-part rules into the locked-hours map by resolving each ruled bucket to
 * its target dollar total and spreading it across the bucket's unlocked hours
 * (proportional to base shape). Hour locks inside a bucket are preserved.
 */
function foldDayPartRulesIntoLocked(baseDay, dayPartRules, locked) {
    if (!dayPartRules?.length) return locked;
    const baseHourly = baseDay.hourly || [];
    for (const rule of dayPartRules) {
        const part = LIFELENZ_DAY_PARTS.find((p) => p.key === rule.dayPartKey);
        if (!part) continue;
        const inPart = baseHourly.filter((slot) => part.hours.includes(slot.hour));
        if (!inPart.length) continue;

        const basePartTotal = inPart.reduce((sum, slot) => sum + (Number(slot.forecast) || 0), 0);
        const target = applyAdjustmentValue(basePartTotal, rule);
        const unlockedInPart = inPart.filter((slot) => !locked.has(slot.hour));
        const lockedSum = inPart.reduce(
            (sum, slot) => (locked.has(slot.hour) ? sum + (Number(locked.get(slot.hour)) || 0) : sum),
            0
        );
        const remainder = round2(target - lockedSum);
        const baseUnlockedTotal = unlockedInPart.reduce((sum, slot) => sum + (Number(slot.forecast) || 0), 0);

        unlockedInPart.forEach((slot) => {
            let value;
            if (baseUnlockedTotal <= 0) value = remainder / unlockedInPart.length;
            else value = remainder * ((Number(slot.forecast) || 0) / baseUnlockedTotal);
            locked.set(slot.hour, round2(value));
        });
        if (unlockedInPart.length) {
            const shaped = round2(unlockedInPart.reduce((sum, slot) => sum + (locked.get(slot.hour) || 0), 0));
            const fix = round2(remainder - shaped);
            if (Math.abs(fix) >= 0.01) {
                const lastHour = unlockedInPart[unlockedInPart.length - 1].hour;
                locked.set(lastHour, round2((locked.get(lastHour) || 0) + fix));
            }
        }
    }
    return locked;
}

/** Apply a locked-hour map directly: locked hours take their value, others keep their current forecast. */
function applyLockedValues(day, locked) {
    const hourly = (day.hourly || []).map((slot) => ({
        hour: slot.hour,
        forecast: locked.has(slot.hour) ? round2(locked.get(slot.hour)) : Number(slot.forecast) || 0,
    }));
    const forecastTotal = round2(hourly.reduce((sum, row) => sum + row.forecast, 0));
    return { ...day, hourly, forecastTotal };
}

function applyForecastAdjustments(plan, rules) {
    if (!Array.isArray(plan) || !plan.length) return [];
    if (!Array.isArray(rules) || !rules.length) return plan.map(clonePlanDay);

    const baseDays = plan.map(clonePlanDay);
    let days = plan.map(clonePlanDay);

    const weekRules = rules.filter((r) => r.scope === 'week');
    const dayRules = rules.filter((r) => r.scope === 'day');
    const hourRules = rules.filter((r) => r.scope === 'hour');
    const daypartRules = rules.filter((r) => r.scope === 'daypart');

    for (const rule of weekRules) {
        if (rule.mode === 'percent') {
            const factor = 1 + Number(rule.value) / 100;
            days = days.map((day) => reshapeHourlyForTotal(day, day.forecastTotal * factor));
        } else if (rule.mode === 'dollar') {
            const addPer = Math.round((Number(rule.value) / days.length) * 100) / 100;
            days = days.map((day, idx) => {
                let add = addPer;
                if (idx === days.length - 1) {
                    const sumPrior = addPer * (days.length - 1);
                    add = Math.round((Number(rule.value) - sumPrior) * 100) / 100;
                }
                return reshapeHourlyForTotal(day, day.forecastTotal + add);
            });
        }
    }

    for (const day of days) {
        const baseDay = baseDays.find((d) => d.date === day.date);
        if (!baseDay) continue;

        const dayHourRules = hourRules.filter((r) => r.date === day.date);
        const dayDayRules = dayRules.filter((r) => r.date === day.date);
        const dayPartRules = daypartRules.filter((r) => r.date === day.date);
        const locked = lockedHourValuesFromRules(baseDay, dayHourRules);
        foldDayPartRulesIntoLocked(baseDay, dayPartRules, locked);

        if (dayDayRules.length) {
            let newTotal = day.forecastTotal;
            for (const rule of dayDayRules) {
                if (rule.mode === 'percent') {
                    newTotal = newTotal * (1 + Number(rule.value) / 100);
                } else {
                    newTotal = newTotal + Number(rule.value);
                }
            }
            const idx = days.findIndex((d) => d.date === day.date);
            days[idx] = reshapeHourlyRespectingLocks(day, newTotal, baseDay, locked);
        } else if (locked.size) {
            const idx = days.findIndex((d) => d.date === day.date);
            days[idx] = applyLockedValues(day, locked);
        }
    }

    return days;
}

function buildForecastPlanForStore(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    const dailyRows = loadDailyRowsForStore(store);
    const resolved = buildTargetForecastDates(options.fromDate, options);
    const { targetWeeks, dates, weekStart, scope } = resolved;
    const basePlan = buildHourlyForecastPlan(dailyRows, dates, store);
    if (!basePlan.length) return { ...resolved, basePlan: [], plan: [], rules: [] };

    const adjustmentWeek = weekStart || targetWeeks[0];
    const rules = options.adjustmentRules ?? loadAdjustmentRules(store, adjustmentWeek);
    const plan = applyForecastAdjustments(basePlan, rules);
    return { targetWeeks, dates, weekStart: adjustmentWeek, scope, basePlan, plan, rules };
}

function buildTargetForecastDates(fromDate = new Date(), options = {}) {
    return resolveForecastTarget({ fromDate, ...options });
}

function forecastRunOptions(options = {}) {
    const target = {
        targetScope: options.targetScope || options.scope,
        weekStart: options.weekStart,
        date: options.date,
        fromDate: options.fromDate,
    };
    if (!target.targetScope && !target.weekStart && !target.date) {
        target.targetScope = 'week-after';
    }
    return target;
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

function historyNotReadyMessage(store, readiness) {
    const weeks = readiness.minWeekdaySamples || 3;
    return (
        `Insufficient sales history for store ${store} (${readiness.daysRecorded} days, need ${weeks}+ weeks). ` +
        'Use Backfill data, or wait for more live capture.'
    );
}

function previewForecastForStore(storeNumber, options = {}) {
    const store = String(storeNumber || '').trim();
    if (!store) throw new Error('Store number is required.');

    const readiness = assessHistoryReadiness(store);
    if (!readiness.ready && !options.force) {
        throw new Error(historyNotReadyMessage(store, readiness));
    }

    const cfg = getStoreConfig(store) || {};
    const dailyRows = loadDailyRowsForStore(store);
    const { targetWeeks, basePlan, plan, rules, weekStart, scope, dates } = buildForecastPlanForStore(store, options);
    if (!plan.length) {
        throw new Error(`Could not build hourly forecast plan for store ${store}.`);
    }

    const baseGrid = buildForecastPreviewGrid(basePlan);
    const grid = buildForecastPreviewGrid(plan);
    const baseWeekTotal = baseGrid.weekTotal;
    const adjustedWeekTotal = grid.weekTotal;

    return {
        storeNumber: store,
        storeName: cfg.storeName || store,
        daysSampled: dailyRows.length,
        forecastDays: plan.length,
        targetWeeks,
        targetScope: scope,
        weekStart,
        targetDates: dates,
        history: readiness,
        basePlan,
        plan,
        adjustments: rules,
        baseGrid,
        grid,
        baseWeekTotal,
        adjustedWeekTotal,
        adjustmentDelta: Math.round((adjustedWeekTotal - baseWeekTotal) * 100) / 100,
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
        throw new Error(historyNotReadyMessage(store, readiness));
    }

    const cfg = getStoreConfig(store) || {};
    const dailyRows = loadDailyRowsForStore(store);
    const runTarget = forecastRunOptions(options);
    const { targetWeeks, plan } = buildForecastPlanForStore(store, { ...options, ...runTarget });
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

    const writeResult = await writeForecastPlanToMmx(store, plan, {
        ...options,
        onProgress: wrapForecastProgress(options, {
            weekStart: targetWeeks[0],
            storeNumber: store,
            completedBy: options.completedBy,
        }),
    });
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
    const runTarget = forecastRunOptions(options);
    const results = [];
    for (const storeNumber of storeNumbers || []) {
        try {
            const result = await runForecastForStore(storeNumber, { ...options, ...runTarget });
            results.push({ storeNumber, ok: true, ...result });
            if (options.markPlatformComplete !== false) {
                for (const weekStart of result.targetWeeks || []) {
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
    const runTarget = forecastRunOptions(options);
    const results = [];

    const byStore = credentials?.byStore && typeof credentials.byStore === 'object' ? credentials.byStore : null;
    const storeList = (storeNumbers || []).map(String).filter(Boolean);

    if (byStore) {
        const groups = new Map();
        for (const store of storeList) {
            const creds = byStore[store];
            if (!creds?.email || !creds?.password) {
                results.push({
                    storeNumber: store,
                    ok: false,
                    error: 'No LifeLenz login configured for this store. Use Admin → Setup Store Logins.',
                });
                continue;
            }
            const key = `${creds.email}\0${creds.password}`;
            if (!groups.has(key)) groups.set(key, { creds, stores: [] });
            groups.get(key).stores.push(store);
        }

        for (const group of groups.values()) {
            const groupResults = await runLifeLenzForecastForStores(group.stores, group.creds, {
                ...options,
                skipByStore: true,
            });
            results.push(...groupResults);
        }
        return results;
    }

    if (credentials?.skipByStore) {
        /* fall through to single-session batch below */
    }

    const email = String(credentials?.email || '').trim();
    const password = String(credentials?.password || '');
    if (!email || !password) {
        throw new Error('LifeLenz credentials are required.');
    }

    let browser;
    let page;
    let accessibleStores = [];

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
                const preview = previewForecastForStore(store, { ...options, ...runTarget });
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
                    onProgress: wrapForecastProgress(
                        {
                            ...options,
                            onProgress: (payload) => {
                                if (typeof options.onProgress === 'function') {
                                    options.onProgress({ platform: 'lifelenz', storeNumber: store, ...payload });
                                }
                            },
                        },
                        {
                            weekStart: preview.weekStart || preview.targetWeeks?.[0],
                            storeNumber: store,
                            completedBy: options.completedBy,
                        }
                    ),
                });
                if (options.markPlatformComplete !== false) {
                    for (const weekStart of preview.targetWeeks || []) {
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
                // The shared session may be left with an open picker/modal or a
                // half-committed date; dismiss overlays so the next store starts clean.
                await page.keyboard.press('Escape').catch(() => null);
                await page.keyboard.press('Escape').catch(() => null);
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
    const runTarget = forecastRunOptions(options);
    const resolved = resolveForecastTarget(runTarget);
    const onProgress = options.onProgress;

    const mmxOptions = {
        ...options,
        ...runTarget,
        onProgress: (payload) => onProgress?.({ platform: 'mmx', ...payload }),
    };

    // Run the platforms sequentially. Two simultaneous Chromium instances
    // starve each other of CPU, and the LifeLenz scraper's save/reload timing
    // is the first thing to break under contention.
    const mmxResults = await runForecastForStores(storeNumbers, mmxOptions);

    let lifelenzResults = [];
    if (options.lifelenzCredentials) {
        lifelenzResults = await runLifeLenzForecastForStores(storeNumbers, options.lifelenzCredentials, {
            ...options,
            ...runTarget,
            onProgress: (payload) => onProgress?.({ platform: 'lifelenz', ...payload }),
        });
    }

    const manualSaved =
        options.saveManualOnFailure !== false
            ? saveManualEntryPacksForRun(
                  storeNumbers,
                  mmxResults,
                  lifelenzResults,
                  resolved.targetWeeks,
                  (store) => previewForecastForStore(store, { ...runTarget, force: options.force }).plan
              )
            : [];

    return {
        mmxResults,
        lifelenzResults,
        lifelenzSkipped: !options.lifelenzCredentials,
        targetWeeks: resolved.targetWeeks,
        targetScope: resolved.scope,
        weekStart: resolved.weekStart,
        targetDates: resolved.dates,
        manualSaved,
    };
}
module.exports = {
    computeTrimmedWeekdayAverages,
    computeTrimmedWeekdayHourlyMix,
    buildDailyForecastPlan,
    buildHourlyForecastPlan,
    buildTargetForecastDates,
    forecastRunOptions,
    loadDailyRowsForStore,
    buildForecastPreviewGrid,
    applyForecastAdjustments,
    buildForecastPlanForStore,
    previewForecastForStore,
    previewForecastForStores,
    runForecastForStore,
    runForecastForStores,
    runLifeLenzForecastForStores,
    runCombinedForecastForStores,
};
