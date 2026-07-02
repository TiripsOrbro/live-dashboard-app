const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
const { writeJsonAtomic } = require('./atomicJson');
const STATE_FILE = path.join(paths.dashboard.data, 'forecast-schedule-state.json');
const LOG_DIR = path.join(paths.dashboard.data, 'forecast-schedule-log');

const TIME_ZONE = process.env.FORECAST_SCHEDULE_TIME_ZONE || process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

function melbourneDateKey(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(date);
}

function localHourMinute(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        hour: 'numeric',
        minute: 'numeric',
        weekday: 'short',
        hour12: false,
    }).formatToParts(date);
    const map = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    return {
        hour: parseInt(map.hour, 10),
        minute: parseInt(map.minute, 10),
        weekday: map.weekday,
    };
}

function scheduleHour() {
    const h = Number(process.env.FORECAST_SCHEDULE_HOUR ?? 7);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? Math.floor(h) : 7;
}

function scheduleWindowMinutes() {
    const m = Number(process.env.FORECAST_SCHEDULE_WINDOW_MIN ?? 30);
    return Number.isFinite(m) && m > 0 ? Math.floor(m) : 30;
}

function isScheduleEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.FORECAST_SCHEDULE_ENABLED ?? '').trim());
}

function isWithinScheduleWindow(date = new Date()) {
    const { hour, minute } = localHourMinute(date);
    const start = scheduleHour();
    return hour === start && minute < scheduleWindowMinutes();
}

function nextScheduleRunDate(date = new Date()) {
    const start = scheduleHour();
    const { hour, minute } = localHourMinute(date);
    const minuteOfDay = hour * 60 + minute;
    const targetMinute = start * 60;
    const run = new Date(date.getTime());
    if (minuteOfDay < targetMinute) {
        run.setMinutes(0, 0, 0);
        run.setHours(start, 0, 0, 0);
        return run;
    }
    run.setDate(run.getDate() + 1);
    run.setHours(start, 0, 0, 0);
    run.setMinutes(0, 0, 0);
    return run;
}

function msUntilNextScheduleRun(date = new Date()) {
    const next = nextScheduleRunDate(date);
    return Math.max(60000, next.getTime() - date.getTime());
}

function readState() {
    if (!fs.existsSync(STATE_FILE)) return { runs: {} };
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return { runs: {} };
    }
}

function writeState(state) {
    writeJsonAtomic(STATE_FILE, state);
}

function hasScheduledRunForDate(runDateKey) {
    const state = readState();
    return Boolean(state.runs?.[String(runDateKey || '').trim()]);
}

/** @deprecated Use hasScheduledRunForDate */
function hasScheduledRunForWeek(runDateKey, weekStart) {
    const state = readState();
    const key = `${runDateKey}:${weekStart}`;
    return Boolean(state.runs?.[key] || state.runs?.[String(runDateKey || '').trim()]);
}

function getLatestScheduledRunDate() {
    const state = readState();
    const keys = Object.keys(state.runs || {})
        .filter(Boolean)
        .sort()
        .reverse();
    return keys[0] || null;
}

function markScheduledRun(runDateKey, weekStart, meta = {}) {
    const state = readState();
    state.runs = state.runs || {};
    const dateKey = String(runDateKey || '').trim();
    state.runs[dateKey] = {
        runDateKey: dateKey,
        weekStart: weekStart || meta.weekStart || null,
        completedAt: new Date().toISOString(),
        ...meta,
    };
    writeState(state);
}

function appendScheduleLog(runDateKey, entry) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${runDateKey}.json`);
    let log = { runDateKey, entries: [] };
    if (fs.existsSync(file)) {
        try {
            log = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            /* reset */
        }
    }
    log.entries = log.entries || [];
    log.entries.push({ ...entry, at: new Date().toISOString() });
    fs.writeFileSync(file, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
}

module.exports = {
    TIME_ZONE,
    STATE_FILE,
    LOG_DIR,
    melbourneDateKey,
    scheduleHour,
    scheduleWindowMinutes,
    isScheduleEnabled,
    isWithinScheduleWindow,
    msUntilNextScheduleRun,
    nextScheduleRunDate,
    hasScheduledRunForDate,
    hasScheduledRunForWeek,
    getLatestScheduledRunDate,
    markScheduledRun,
    appendScheduleLog,
};
