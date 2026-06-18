const { aggregateDayPartsFromHourlyPlan } = require('../../../lifelenz/src/lifelenzDayParts');

const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
const MANUAL_DIR = path.join(paths.dashboard.data, 'forecast-manual');

function manualPackPath(weekStart, storeNumber) {
    const week = String(weekStart || '').replace(/[^0-9-]/g, '');
    const store = String(storeNumber || '').trim();
    return path.join(MANUAL_DIR, week, `${store}.json`);
}

function buildManualEntryPack(storeNumber, plan, failures = {}) {
    const store = String(storeNumber || '').trim();
    const days = (plan || []).map((day) => ({
        date: day.date,
        weekday: day.weekday,
        forecastTotal: day.forecastTotal,
        hourly: (day.hourly || []).map((slot) => ({
            hour: slot.hour,
            forecast: slot.forecast,
        })),
        dayParts: aggregateDayPartsFromHourlyPlan(day),
    }));

    return {
        storeNumber: store,
        generatedAt: new Date().toISOString(),
        weekTotal: Math.round(days.reduce((sum, d) => sum + (Number(d.forecastTotal) || 0), 0) * 100) / 100,
        failures: {
            mmx: failures.mmx || null,
            lifelenz: failures.lifelenz || null,
        },
        days,
    };
}

function saveManualEntryPack(weekStart, storeNumber, pack) {
    const filePath = manualPackPath(weekStart, storeNumber);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
        filePath,
        `${JSON.stringify({ weekStart, ...pack }, null, 2)}\n`,
        'utf8'
    );
    return filePath;
}

function readManualEntryPack(weekStart, storeNumber) {
    const filePath = manualPackPath(weekStart, storeNumber);
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function buildManualEntryPlainText(pack) {
    const lines = [];
    lines.push(`Forecast manual entry - store ${pack.storeNumber}`);
    lines.push(`Generated: ${pack.generatedAt}`);
    if (pack.failures?.mmx) lines.push(`MMX error: ${pack.failures.mmx}`);
    if (pack.failures?.lifelenz) lines.push(`LifeLenz error: ${pack.failures.lifelenz}`);
    lines.push('');

    for (const day of pack.days || []) {
        lines.push(`=== ${day.date} (total $${Math.round(day.forecastTotal || 0)}) ===`);
        lines.push('Macromatix hourly:');
        for (const slot of day.hourly || []) {
            const h = Number(slot.hour);
            const label = h < 12 ? `${h === 0 ? 12 : h}:00 AM` : `${h === 12 ? 12 : h - 12}:00 PM`;
            lines.push(`  ${label}: $${Math.round(Number(slot.forecast) || 0)}`);
        }
        lines.push('LifeLenz day parts (adjusted):');
        for (const part of day.dayParts || []) {
            lines.push(`  ${part.label}: $${part.adjusted ?? 0}`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

function saveManualEntryPacksForRun(storeNumbers, mmxResults, lifelenzResults, targetWeeks, buildPlanForStore) {
    const weekStart = targetWeeks?.[0];
    if (!weekStart || typeof buildPlanForStore !== 'function') return [];

    const mmxByStore = new Map((mmxResults || []).map((row) => [String(row.storeNumber), row]));
    const llByStore = new Map((lifelenzResults || []).map((row) => [String(row.storeNumber), row]));
    const saved = [];

    for (const storeNumber of storeNumbers || []) {
        const store = String(storeNumber).trim();
        const mmxRow = mmxByStore.get(store);
        const llRow = llByStore.get(store);
        const mmxFailed = mmxRow && !mmxRow.ok;
        const llFailed = llRow && !llRow.ok;
        const llSkipped = !llRow;

        if (!mmxFailed && !llFailed) continue;
        if (llSkipped && !mmxFailed) continue;

        try {
            const plan = buildPlanForStore(store);
            const pack = buildManualEntryPack(store, plan, {
                mmx: mmxFailed ? mmxRow.error : null,
                lifelenz: llFailed ? llRow.error : llSkipped ? 'LifeLenz not configured' : null,
            });
            saveManualEntryPack(weekStart, store, pack);
            saved.push({ storeNumber: store, weekStart });
        } catch (err) {
            console.warn(`[forecastManualPack] Could not save pack for ${store}:`, err.message);
        }
    }
    return saved;
}

module.exports = {
    MANUAL_DIR,
    buildManualEntryPack,
    saveManualEntryPack,
    readManualEntryPack,
    buildManualEntryPlainText,
    saveManualEntryPacksForRun,
};
