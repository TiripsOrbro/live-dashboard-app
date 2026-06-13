const fs = require('fs');
const path = require('path');

const paths = require('../../../src/paths');
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
    const h = Number(process.env.FORECAST_SCHEDULE_HOUR ?? 2);
    return Number.isFinite(h) && h >= 0 && h <= 23 ? Math.floor(h) : 2;
}

function scheduleWindowMinutes() {
    const m = Number(process.env.FORECAST_SCHEDULE_WINDOW_MIN ?? 30);
    return Number.isFinite(m) && m > 0 ? Math.floor(m) : 30;
}

function scheduleWeekday() {
    return String(process.env.FORECAST_SCHEDULE_WEEKDAY || 'Mon').trim();
}

function isScheduleEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.FORECAST_SCHEDULE_ENABLED ?? '').trim());
}

function isScheduleWeekday(date = new Date()) {
    const want = scheduleWeekday();
    const { weekday } = localHourMinute(date);
    return String(weekday || '').toLowerCase().startsWith(String(want).slice(0, 3).toLowerCase());
}

function isWithinScheduleWindow(date = new Date()) {
    if (!isScheduleWeekday(date)) return false;
    const { hour, minute } = localHourMinute(date);
    const start = scheduleHour();
    return hour === start && minute < scheduleWindowMinutes();
}

function msUntilNextScheduleRun(date = new Date()) {
    return 10 * 60 * 1000;
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
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function hasScheduledRunForWeek(runDateKey, weekStart) {
    const state = readState();
    const key = `${runDateKey}:${weekStart}`;
    return Boolean(state.runs?.[key]);
}

function markScheduledRun(runDateKey, weekStart, meta = {}) {
    const state = readState();
    state.runs = state.runs || {};
    const key = `${runDateKey}:${weekStart}`;
    state.runs[key] = {
        runDateKey,
        weekStart,
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
    scheduleWeekday,
    isScheduleEnabled,
    isScheduleWeekday,
    isWithinScheduleWindow,
    msUntilNextScheduleRun,
    hasScheduledRunForWeek,
    markScheduledRun,
    appendScheduleLog,
};
