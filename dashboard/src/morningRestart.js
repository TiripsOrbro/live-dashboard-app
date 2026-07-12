/**
 * Once-per-day morning recycle of PM2 apps before daily reports.
 * State is Melbourne-calendar keyed (same TZ as daily reports).
 */
const fs = require('fs');
const path = require('path');

const paths = require('../../src/paths');
const { writeJsonAtomic } = require('./forecast/atomicJson');

const STATE_FILE = path.join(paths.dashboard.data, 'morning-restart-state.json');
const TIME_ZONE = String(process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne').trim();

const DEFAULT_TARGETS = ['dashboard', 'report-download-scheduler', 'forecast-scheduler'];

function melbourneDateKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(
        date instanceof Date ? date : new Date(date)
    );
}

function localHourInTimeZone(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: TIME_ZONE,
        hour: 'numeric',
        hour12: false,
    }).formatToParts(now instanceof Date ? now : new Date(now));
    return Number(parts.find((p) => p.type === 'hour')?.value || 0);
}

function reportsHour() {
    const h = Number(process.env.FIVE_AM_REPORTS_HOUR ?? process.env.FORECAST_SCHEDULE_HOUR ?? 7);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? Math.floor(h) : 7;
}

function restartHour() {
    const raw = process.env.MORNING_RESTART_HOUR;
    if (raw !== undefined && String(raw).trim() !== '') {
        const h = Number(raw);
        if (Number.isFinite(h) && h >= 0 && h <= 23) return Math.floor(h);
    }
    // Default: one hour before daily reports (e.g. 6 AM when reports are at 7).
    return Math.max(0, reportsHour() - 1);
}

function isMorningRestartEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.MORNING_RESTART_ENABLED ?? '1').trim());
}

function restartTargets() {
    const raw = String(process.env.MORNING_RESTART_TARGETS || '').trim();
    if (!raw) return [...DEFAULT_TARGETS];
    return raw
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function readState() {
    if (!fs.existsSync(STATE_FILE)) return { restarts: {} };
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return raw && typeof raw === 'object' ? raw : { restarts: {} };
    } catch {
        return { restarts: {} };
    }
}

function hasMorningRestartForDate(dateKey = melbourneDateKey()) {
    const key = String(dateKey || '').trim();
    if (!key) return false;
    return Boolean(readState().restarts?.[key]?.completedAt);
}

function markMorningRestartComplete(dateKey = melbourneDateKey(), meta = {}) {
    const key = String(dateKey || melbourneDateKey()).trim();
    const state = readState();
    state.restarts = state.restarts || {};
    state.restarts[key] = {
        dateKey: key,
        completedAt: new Date().toISOString(),
        ...meta,
    };
    writeJsonAtomic(STATE_FILE, state);
    return state.restarts[key];
}

/**
 * True when we are in the pre-reports window and have not recycled yet today.
 * Missed windows (after reports hour) are skipped so we do not disrupt a live morning run.
 */
function shouldMorningRestart(now = new Date()) {
    if (!isMorningRestartEnabled()) return false;
    const dateKey = melbourneDateKey(now);
    if (hasMorningRestartForDate(dateKey)) return false;
    const hour = localHourInTimeZone(now);
    const start = restartHour();
    const end = reportsHour();
    if (start < end) {
        return hour >= start && hour < end;
    }
    // Unusual: restart hour >= reports hour — only fire exactly at restart hour.
    return hour === start;
}

module.exports = {
    STATE_FILE,
    TIME_ZONE,
    DEFAULT_TARGETS,
    melbourneDateKey,
    localHourInTimeZone,
    reportsHour,
    restartHour,
    isMorningRestartEnabled,
    restartTargets,
    hasMorningRestartForDate,
    markMorningRestartComplete,
    shouldMorningRestart,
};
