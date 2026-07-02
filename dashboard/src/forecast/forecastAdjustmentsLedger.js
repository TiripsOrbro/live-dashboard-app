const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
const { addDaysToIso } = require('./forecastHistoryLedger');
const { LIFELENZ_DAY_PARTS } = require('../../../lifelenz/src/lifelenzDayParts');

const ADJUSTMENTS_DIR = path.join(paths.dashboard.data, 'forecast-adjustments');
const MAX_PERCENT = 100;
const MAX_DOLLAR = 50000;
const DAY_PART_KEYS = new Set(LIFELENZ_DAY_PARTS.map((part) => part.key));

function adjustmentsFilePath(weekStart, storeNumber) {
    const week = String(weekStart || '').replace(/[^0-9-]/g, '');
    const store = String(storeNumber || '').replace(/[^0-9a-z]/gi, '');
    return path.join(ADJUSTMENTS_DIR, week || 'unknown', `${store || 'unknown'}.json`);
}

function emptyAdjustmentsDoc(storeNumber, weekStart) {
    return {
        storeNumber: String(storeNumber || '').trim(),
        weekStart: String(weekStart || '').trim(),
        updatedAt: null,
        updatedBy: null,
        rules: [],
    };
}

function readAdjustments(storeNumber, weekStart) {
    const filePath = adjustmentsFilePath(weekStart, storeNumber);
    if (!fs.existsSync(filePath)) return emptyAdjustmentsDoc(storeNumber, weekStart);
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const base = emptyAdjustmentsDoc(storeNumber, weekStart);
        return {
            ...base,
            ...raw,
            storeNumber: String(raw.storeNumber || storeNumber).trim(),
            weekStart: String(raw.weekStart || weekStart).trim(),
            rules: Array.isArray(raw.rules) ? raw.rules : [],
        };
    } catch {
        return emptyAdjustmentsDoc(storeNumber, weekStart);
    }
}

function validateRule(rule, weekStart) {
    if (!rule || typeof rule !== 'object') throw new Error('Invalid adjustment rule.');
    const scope = String(rule.scope || '').trim();
    if (scope !== 'week' && scope !== 'day' && scope !== 'hour' && scope !== 'daypart') {
        throw new Error('Adjustment scope must be week, day, hour, or daypart.');
    }
    const mode = String(rule.mode || '').trim();
    if (mode !== 'percent' && mode !== 'dollar') throw new Error('Adjustment mode must be percent or dollar.');
    const value = Number(rule.value);
    if (!Number.isFinite(value)) throw new Error('Adjustment value must be a number.');

    if (mode === 'percent' && (value < -MAX_PERCENT || value > MAX_PERCENT)) {
        throw new Error(`Percent adjustment must be between -${MAX_PERCENT} and ${MAX_PERCENT}.`);
    }
    if (mode === 'dollar' && (value < -MAX_DOLLAR || value > MAX_DOLLAR)) {
        throw new Error(`Dollar adjustment must be between -$${MAX_DOLLAR} and $${MAX_DOLLAR}.`);
    }

    if (scope === 'day' || scope === 'hour' || scope === 'daypart') {
        const date = String(rule.date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Day/hour adjustment requires a valid date.');
        const weekEnd = addDaysToIso(weekStart, 6);
        if (date < weekStart || date > weekEnd) {
            throw new Error(`Day date must fall within target week (${weekStart} to ${weekEnd}).`);
        }
        if (scope === 'hour') {
            const hour = Number(rule.hour);
            if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
                throw new Error('Hour adjustment requires hour 0–23.');
            }
            return {
                scope: 'hour',
                date,
                hour: Math.floor(hour),
                mode,
                value: Math.round(value * 100) / 100,
            };
        }
        if (scope === 'daypart') {
            const dayPartKey = String(rule.dayPartKey || '').trim();
            if (!DAY_PART_KEYS.has(dayPartKey)) {
                throw new Error('Day-part adjustment requires a valid dayPartKey.');
            }
            return { scope: 'daypart', date, dayPartKey, mode, value: Math.round(value * 100) / 100 };
        }
        return { scope: 'day', date, mode, value: Math.round(value * 100) / 100 };
    }

    return { scope: 'week', mode, value: Math.round(value * 100) / 100 };
}

function validateRules(rules, weekStart) {
    if (!Array.isArray(rules)) throw new Error('rules must be an array.');
    return rules.map((rule) => validateRule(rule, weekStart));
}

function writeAdjustments(storeNumber, weekStart, rules, updatedBy) {
    const store = String(storeNumber || '').trim();
    const week = String(weekStart || '').trim();
    if (!store || !week) throw new Error('storeNumber and weekStart are required.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error('weekStart must be YYYY-MM-DD.');

    const validated = validateRules(rules, week);
    const filePath = adjustmentsFilePath(week, store);

    if (!validated.length) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return emptyAdjustmentsDoc(store, week);
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const doc = {
        storeNumber: store,
        weekStart: week,
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy ? String(updatedBy).trim() : null,
        rules: validated,
    };
    fs.writeFileSync(filePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    return doc;
}

function deleteAdjustments(storeNumber, weekStart) {
    const filePath = adjustmentsFilePath(weekStart, storeNumber);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { storeNumber: String(storeNumber), weekStart: String(weekStart), removed: true };
}

function loadAdjustmentRules(storeNumber, weekStart) {
    return readAdjustments(storeNumber, weekStart).rules || [];
}

module.exports = {
    ADJUSTMENTS_DIR,
    readAdjustments,
    writeAdjustments,
    deleteAdjustments,
    loadAdjustmentRules,
    validateRules,
};
