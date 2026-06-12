const { getStoreConfig } = require('../../../stores/src/storeList');
const { buildDaySummary, storeDateKey } = require('../../audits/Daily Food Safety Check/dfscStore');
const { getCurrentOperationalWeek } = require('../auditRecurrence');

const AFTERNOON_CUTOFF_HOUR = 16;

function parseYmd(ymd) {
    return String(ymd || '').trim().slice(0, 10);
}

function addDaysYmd(ymd, days) {
    const [y, m, d] = parseYmd(ymd).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
}

function listYmdRange(startYmd, endYmd) {
    const start = parseYmd(startYmd);
    const end = parseYmd(endYmd);
    if (!start || !end || start > end) return [];
    const days = [];
    let cur = start;
    while (cur <= end) {
        days.push(cur);
        cur = addDaysYmd(cur, 1);
    }
    return days;
}

function storeLocalTimeParts(timeZone, now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value);
    return {
        hour: Number.isFinite(hour) ? hour : 0,
        minute: Number.isFinite(minute) ? minute : 0,
    };
}

function isAfternoonSlotDue(timeZone, now = new Date()) {
    const { hour, minute } = storeLocalTimeParts(timeZone, now);
    return hour > AFTERNOON_CUTOFF_HOUR || (hour === AFTERNOON_CUTOFF_HOUR && minute >= 0);
}

function expectedSlotsForDay(dateKey, storeToday, afternoonDue) {
    if (dateKey > storeToday) return 0;
    if (dateKey < storeToday) return 2;
    return afternoonDue ? 2 : 1;
}

function completedSlotsForDay(storeNumber, dateKey) {
    const day = buildDaySummary(storeNumber, dateKey);
    return (day.amCompleted ? 1 : 0) + (day.pmCompleted ? 1 : 0);
}

function buildDfscWeekCompliance(storeNumber, options = {}) {
    const now = options.now instanceof Date ? options.now : options.now ? new Date(options.now) : new Date();
    const week =
        options.weekStartYmd && options.weekEndYmd
            ? { weekStartYmd: parseYmd(options.weekStartYmd), weekEndYmd: parseYmd(options.weekEndYmd) }
            : getCurrentOperationalWeek(now);
    if (!week?.weekStartYmd || !week?.weekEndYmd) {
        return { completed: 0, expected: 0, meetsTarget: false };
    }

    const cfg = getStoreConfig(storeNumber) || {};
    const timeZone = cfg.timeZone || 'Australia/Melbourne';
    const storeToday = storeDateKey(storeNumber, now);
    const historicalWeek = Boolean(options.historicalWeek);
    const afternoonDue = historicalWeek ? true : isAfternoonSlotDue(timeZone, now);
    const rangeEnd = historicalWeek
        ? week.weekEndYmd
        : storeToday < week.weekEndYmd
          ? storeToday
          : week.weekEndYmd;

    let expected = 0;
    let completed = 0;
    for (const dateKey of listYmdRange(week.weekStartYmd, rangeEnd)) {
        expected += expectedSlotsForDay(dateKey, storeToday, afternoonDue);
        completed += completedSlotsForDay(storeNumber, dateKey);
    }

    return {
        completed,
        expected,
        meetsTarget: completed >= expected,
    };
}

function cellFromDfscWeekCount(summary) {
    const completed = Math.max(0, Number(summary?.completed) || 0);
    const expected = Math.max(0, Number(summary?.expected) || 0);
    const ratio = `${completed}/${expected}`;
    if (summary?.meetsTarget) {
        return {
            status: 'complete',
            display: ratio,
            tone: 'green',
            clickable: false,
            kind: 'dfsc-count',
        };
    }
    return { status: 'count', display: ratio, tone: 'red', clickable: false, kind: 'dfsc-count' };
}

module.exports = {
    buildDfscWeekCompliance,
    cellFromDfscWeekCount,
    isAfternoonSlotDue,
};
