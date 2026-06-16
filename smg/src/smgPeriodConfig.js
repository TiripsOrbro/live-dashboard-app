const fs = require('fs');
const path = require('path');

const paths = require('../../src/paths');
const CONFIG_PATH = path.join(paths.smg.config, 'periods.json');

function parseYmd(value) {
    const raw = String(value || '').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return null;
    }
    return { year, month, day, date };
}

function formatYmd(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function firstMondayOfYear(year) {
    const date = new Date(Date.UTC(year, 0, 1));
    while (date.getUTCDay() !== 1) {
        date.setUTCDate(date.getUTCDate() + 1);
    }
    return formatYmd(date);
}

function defaultConfig() {
    const year = new Date().getFullYear();
    return {
        year,
        period1StartDate: firstMondayOfYear(year),
        periodLengthDays: 28,
        updatedBy: '',
        updatedAt: '',
    };
}

function readConfigRaw() {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function normalizeConfig(raw) {
    const base = defaultConfig();
    if (!raw || typeof raw !== 'object') return base;
    const year = Number(raw.year) || base.year;
    const period1StartDate = parseYmd(raw.period1StartDate)?.year === year
        ? String(raw.period1StartDate).trim()
        : firstMondayOfYear(year);
    const periodLengthDays = Math.max(1, Number(raw.periodLengthDays) || base.periodLengthDays);
    return {
        year,
        period1StartDate,
        periodLengthDays,
        updatedBy: String(raw.updatedBy || '').trim(),
        updatedAt: String(raw.updatedAt || '').trim(),
    };
}

function computeRollingPeriods(config) {
    const normalized = normalizeConfig(config);
    const year = normalized.year;
    const start = parseYmd(normalized.period1StartDate);
    if (!start) return [];
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    const lengthDays = normalized.periodLengthDays;
    const periods = [];
    let cursor = new Date(start.date.getTime());
    let index = 1;
    while (cursor.getTime() <= yearEnd.getTime()) {
        const periodStart = new Date(cursor.getTime());
        const periodEnd = new Date(cursor.getTime());
        periodEnd.setUTCDate(periodEnd.getUTCDate() + lengthDays - 1);
        if (periodEnd.getTime() > yearEnd.getTime()) {
            periodEnd.setTime(yearEnd.getTime());
        }
        periods.push({
            periodNumber: index,
            startDate: formatYmd(periodStart),
            endDate: formatYmd(periodEnd),
        });
        index += 1;
        cursor = new Date(periodEnd.getTime());
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return periods;
}

function getSmgPeriodConfig() {
    const config = normalizeConfig(readConfigRaw());
    return {
        ...config,
        periods: computeRollingPeriods(config),
    };
}

function saveSmgPeriodConfig(payload, actor) {
    const year = Number(payload?.year);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
        return { ok: false, error: 'Valid year is required.' };
    }
    const period1StartDate = String(payload?.period1StartDate || '').trim();
    const parsed = parseYmd(period1StartDate);
    if (!parsed || parsed.year !== year) {
        return { ok: false, error: 'Period 1 start date must be YYYY-MM-DD within the selected year.' };
    }
    const periodLengthDays = Number(payload?.periodLengthDays);
    if (!Number.isFinite(periodLengthDays) || periodLengthDays < 1) {
        return { ok: false, error: 'Period length must be at least 1 day.' };
    }
    const now = new Date().toISOString();
    const actorName = String(actor || '').trim() || 'Unknown';
    const config = {
        year,
        period1StartDate,
        periodLengthDays: Math.floor(periodLengthDays),
        updatedBy: actorName,
        updatedAt: now,
    };
    try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
        return { ok: true, config: getSmgPeriodConfig() };
    } catch (error) {
        return { ok: false, error: error.message || 'Could not save SMG settings.' };
    }
}

module.exports = {
    getSmgPeriodConfig,
    saveSmgPeriodConfig,
    computeRollingPeriods,
    CONFIG_PATH,
};
