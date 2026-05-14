/**
 * Audit list scheduling: dismissal period + Square One rotation (two independent rules).
 * Gregorian civil dates use UTC-noon encoding per (y,m,d) for weekday math (stable, TZ-agnostic for the calendar grid).
 * "Today" for period boundaries uses `ymdInTimeZone(now, timeZone)` (e.g. Australia/Melbourne).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_RECURRENCE_PATH = path.join(__dirname, '../../data/audit-recurrence.json');

const FIXED_AUDITS = ['Pest Walk', 'RGM Cleaning Checklist', 'Period Safety Inspection'];

const SQUARE_ONE_PLACEHOLDERS = [
    'Dining Room',
    'Restrooms',
    'Production Line',
    'Walls, Floors, Drains, Shelves...',
    'External',
    'Bins, Bin Room, Office...',
    'Drink Station',
    'Prep and Washup',
];

function gregorianToJd(y, m, d) {
    const a = Math.floor((14 - m) / 12);
    const yy = y + 4800 - a;
    const mm = m + 12 * a - 3;
    return (
        d +
        Math.floor((153 * mm + 2) / 5) +
        365 * yy +
        Math.floor(yy / 4) -
        Math.floor(yy / 100) +
        Math.floor(yy / 400) -
        32045
    );
}

function jdToGregorian(jd) {
    const a = jd + 32044;
    const b = Math.floor((4 * a + 3) / 146097);
    const c = a - Math.floor((146097 * b) / 4);
    const d = Math.floor((4 * c + 3) / 1461);
    const e = c - Math.floor((1461 * d) / 4);
    const f = Math.floor((5 * e + 2) / 153);
    const day = e - Math.floor((153 * f + 2) / 5) + 1;
    const month = f + 3 - 12 * Math.floor(f / 10);
    const year = b * 100 + d - 4800 + Math.floor(f / 10);
    return { year, month, day };
}

/** ISO weekday 1 = Monday … 7 = Sunday for Gregorian civil y-m-d. */
function isoWeekdayFromYmd(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const w = t.getUTCDay();
    return w === 0 ? 7 : w;
}

function addDaysToYmd(y, m, d, deltaDays) {
    const jd = gregorianToJd(y, m, d) + deltaDays;
    return jdToGregorian(jd);
}

function formatYmd(y, m, d) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseYmd(s) {
    const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error(`Invalid date (expected YYYY-MM-DD): ${s}`);
    return { year: +m[1], month: +m[2], day: +m[3] };
}

function ymdInTimeZone(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return { year: +get('year'), month: +get('month'), day: +get('day') };
}

function mondayOfWeekContainingYmd(y, m, d) {
    const wd = isoWeekdayFromYmd(y, m, d);
    return addDaysToYmd(y, m, d, -(wd - 1));
}

function daysBetweenYmd(a, b) {
    return gregorianToJd(b.year, b.month, b.day) - gregorianToJd(a.year, a.month, a.day);
}

function clampDayOfMonth(year, month, wantedDay) {
    const last = new Date(year, month, 0).getDate();
    return Math.min(wantedDay, last);
}

function assertRule(rule, name) {
    if (!rule || typeof rule !== 'object') throw new Error(`${name} is missing or invalid`);
    if (!rule.type) throw new Error(`${name}.type is required`);
}

/** ISO weekdays 1=Mon … 7=Sun; default Monday-only for legacy parity. */
function normalizeWeekdays(weekdays) {
    if (!Array.isArray(weekdays) || weekdays.length === 0) return [1];
    const s = new Set();
    for (const x of weekdays) {
        const n = Math.floor(Number(x));
        if (n >= 1 && n <= 7) s.add(n);
    }
    if (s.size === 0) return [1];
    return [...s].sort((a, b) => a - b);
}

function weeklyPeriodStartYmd(now, timeZone, rule) {
    assertRule(rule, 'dismissalPeriod');
    const intervalWeeks = Math.max(1, Math.floor(Number(rule.intervalWeeks) || 1));
    const anchor = parseYmd(rule.anchor);
    const anchorMon = mondayOfWeekContainingYmd(anchor.year, anchor.month, anchor.day);
    const today = ymdInTimeZone(now, timeZone);
    const thisMon = mondayOfWeekContainingYmd(today.year, today.month, today.day);
    const weeksSince = Math.floor(daysBetweenYmd(anchorMon, thisMon) / 7);
    if (weeksSince < 0) {
        return anchorMon;
    }
    const block = Math.floor(weeksSince / intervalWeeks);
    return addDaysToYmd(anchorMon.year, anchorMon.month, anchorMon.day, block * intervalWeeks * 7);
}

/**
 * Latest calendar day in the current `intervalWeeks` block (anchored like `weeklyPeriodStartYmd`)
 * on or before `today` whose ISO weekday is in `rule.weekdays`. Each such day starts a new dismissal
 * period; `periodKey` is that day's YYYY-MM-DD (Melbourne).
 */
function weeklyDismissalPeriodStartYmd(now, timeZone, rule) {
    assertRule(rule, 'dismissalPeriod');
    const intervalWeeks = Math.max(1, Math.floor(Number(rule.intervalWeeks) || 1));
    const weekdays = normalizeWeekdays(rule.weekdays);
    const blockStartMon = weeklyPeriodStartYmd(now, timeZone, rule);
    const blockEnd = addDaysToYmd(blockStartMon.year, blockStartMon.month, blockStartMon.day, intervalWeeks * 7 - 1);
    const today = ymdInTimeZone(now, timeZone);
    const todayJd = gregorianToJd(today.year, today.month, today.day);
    const startJd = gregorianToJd(blockStartMon.year, blockStartMon.month, blockStartMon.day);
    const endJd = gregorianToJd(blockEnd.year, blockEnd.month, blockEnd.day);
    for (let j = todayJd; j >= startJd; j -= 1) {
        const ymd = jdToGregorian(j);
        if (weekdays.includes(isoWeekdayFromYmd(ymd.year, ymd.month, ymd.day))) {
            return ymd;
        }
    }
    for (let j = startJd; j <= endJd; j += 1) {
        const ymd = jdToGregorian(j);
        if (weekdays.includes(isoWeekdayFromYmd(ymd.year, ymd.month, ymd.day))) {
            return ymd;
        }
    }
    return blockStartMon;
}

function weeklySlotIndex(now, timeZone, rule, slotModulo) {
    assertRule(rule, 'squareOnePeriod');
    const intervalWeeks = Math.max(1, Math.floor(Number(rule.intervalWeeks) || 1));
    const anchor = parseYmd(rule.anchor);
    const anchorMon = mondayOfWeekContainingYmd(anchor.year, anchor.month, anchor.day);
    const today = ymdInTimeZone(now, timeZone);
    const thisMon = mondayOfWeekContainingYmd(today.year, today.month, today.day);
    const weeksSince = Math.floor(daysBetweenYmd(anchorMon, thisMon) / 7);
    const idx = weeksSince < 0 ? 0 : Math.floor(weeksSince / intervalWeeks);
    const mod = Math.max(2, Math.floor(Number(slotModulo) || 4));
    return ((idx % mod) + mod) % mod;
}

function intervalDaysPeriodKey(now, timeZone, rule) {
    assertRule(rule, 'dismissalPeriod');
    const intervalDays = Math.max(1, Math.floor(Number(rule.intervalDays) || 1));
    const anchor = parseYmd(rule.anchor);
    const today = ymdInTimeZone(now, timeZone);
    const d0 = gregorianToJd(anchor.year, anchor.month, anchor.day);
    const d1 = gregorianToJd(today.year, today.month, today.day);
    const diff = d1 - d0;
    const periodIndex = diff < 0 ? 0 : Math.floor(diff / intervalDays);
    const start = jdToGregorian(d0 + periodIndex * intervalDays);
    return `intervalDays:${formatYmd(start.year, start.month, start.day)}`;
}

function intervalDaysSlotIndex(now, timeZone, rule, slotModulo) {
    assertRule(rule, 'squareOnePeriod');
    const intervalDays = Math.max(1, Math.floor(Number(rule.intervalDays) || 1));
    const anchor = parseYmd(rule.anchor);
    const today = ymdInTimeZone(now, timeZone);
    const d0 = gregorianToJd(anchor.year, anchor.month, anchor.day);
    const d1 = gregorianToJd(today.year, today.month, today.day);
    const diff = d1 - d0;
    const periodIndex = diff < 0 ? 0 : Math.floor(diff / intervalDays);
    const mod = Math.max(2, Math.floor(Number(slotModulo) || 4));
    return ((periodIndex % mod) + mod) % mod;
}

function monthlyDayPeriodKey(now, timeZone, rule) {
    assertRule(rule, 'dismissalPeriod');
    const want = Math.max(1, Math.min(31, Math.floor(Number(rule.day) || 1)));
    const today = ymdInTimeZone(now, timeZone);
    const thisOcc = {
        year: today.year,
        month: today.month,
        day: clampDayOfMonth(today.year, today.month, want),
    };
    if (daysBetweenYmd(thisOcc, today) >= 0) {
        return `monthlyDay:${formatYmd(thisOcc.year, thisOcc.month, thisOcc.day)}`;
    }
    const pm = today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
    const prevOcc = {
        year: pm.year,
        month: pm.month,
        day: clampDayOfMonth(pm.year, pm.month, want),
    };
    return `monthlyDay:${formatYmd(prevOcc.year, prevOcc.month, prevOcc.day)}`;
}

function ymdForNthWeekdayOfMonth(year, month, ordinal, isoWeekday) {
    if (ordinal === -1) {
        let cur = { year, month, day: new Date(year, month, 0).getDate() };
        while (isoWeekdayFromYmd(cur.year, cur.month, cur.day) !== isoWeekday) {
            cur = addDaysToYmd(cur.year, cur.month, cur.day, -1);
        }
        return cur;
    }
    let cur = { year, month, day: 1 };
    let seen = 0;
    const last = new Date(year, month, 0).getDate();
    while (cur.day <= last) {
        if (isoWeekdayFromYmd(cur.year, cur.month, cur.day) === isoWeekday) {
            seen += 1;
            if (seen === ordinal) {
                return { ...cur };
            }
        }
        cur = addDaysToYmd(cur.year, cur.month, cur.day, 1);
    }
    throw new Error(`No ${ordinal} weekday ${isoWeekday} in ${year}-${String(month).padStart(2, '0')}`);
}

function monthlyWeekdayPeriodKey(now, timeZone, rule) {
    assertRule(rule, 'dismissalPeriod');
    const ordinal = Number(rule.ordinal);
    const weekday = Math.max(1, Math.min(7, Math.floor(Number(rule.weekday) || 1)));
    if (![-1, 1, 2, 3, 4].includes(ordinal)) {
        throw new Error('monthlyWeekday.ordinal must be 1–4 or -1 (last)');
    }
    const today = ymdInTimeZone(now, timeZone);
    let occ = ymdForNthWeekdayOfMonth(today.year, today.month, ordinal, weekday);
    if (daysBetweenYmd(occ, today) < 0) {
        const pm = today.month === 1 ? { year: today.year - 1, month: 12 } : { year: today.year, month: today.month - 1 };
        occ = ymdForNthWeekdayOfMonth(pm.year, pm.month, ordinal, weekday);
    }
    return `monthlyWeekday:${formatYmd(occ.year, occ.month, occ.day)}`;
}

function dismissalPeriodKey(now, timeZone, rule) {
    assertRule(rule, 'dismissalPeriod');
    switch (rule.type) {
        case 'weekly': {
            const start = weeklyDismissalPeriodStartYmd(now, timeZone, rule);
            return formatYmd(start.year, start.month, start.day);
        }
        case 'intervalDays':
            return intervalDaysPeriodKey(now, timeZone, rule);
        case 'monthlyDay':
            return monthlyDayPeriodKey(now, timeZone, rule);
        case 'monthlyWeekday':
            return monthlyWeekdayPeriodKey(now, timeZone, rule);
        default:
            throw new Error(`Unknown dismissalPeriod.type: ${rule.type}`);
    }
}

function monthlySlotIndexFromAnchorMonth(now, timeZone, rule, slotModulo) {
    const anchor = parseYmd(rule.anchor);
    const today = ymdInTimeZone(now, timeZone);
    const dayNum = Math.max(1, Math.min(31, Math.floor(Number(rule.day) || 15)));
    let monthIndex = (today.year - anchor.year) * 12 + (today.month - anchor.month);
    const occThis = clampDayOfMonth(today.year, today.month, dayNum);
    if (today.day < occThis) {
        monthIndex -= 1;
    }
    if (monthIndex < 0) monthIndex = 0;
    const mod = Math.max(2, Math.floor(Number(slotModulo) || 4));
    return ((monthIndex % mod) + mod) % mod;
}

function monthlyWeekdaySlotIndex(now, timeZone, rule, slotModulo) {
    const anchor = parseYmd(rule.anchor);
    const ordinal = Number(rule.ordinal);
    const weekday = Math.max(1, Math.min(7, Math.floor(Number(rule.weekday) || 1)));
    const today = ymdInTimeZone(now, timeZone);
    let monthIndex = (today.year - anchor.year) * 12 + (today.month - anchor.month);
    const occThis = ymdForNthWeekdayOfMonth(today.year, today.month, ordinal, weekday);
    if (daysBetweenYmd(occThis, today) < 0) {
        monthIndex -= 1;
    }
    if (monthIndex < 0) monthIndex = 0;
    const mod = Math.max(2, Math.floor(Number(slotModulo) || 4));
    return ((monthIndex % mod) + mod) % mod;
}

function squareOneSlot(now, timeZone, rule) {
    assertRule(rule, 'squareOnePeriod');
    const mod = Math.max(2, Math.floor(Number(rule.slotModulo) || 4));
    switch (rule.type) {
        case 'weekly':
            return weeklySlotIndex(now, timeZone, rule, mod);
        case 'intervalDays':
            return intervalDaysSlotIndex(now, timeZone, rule, mod);
        case 'monthlyDay':
            return monthlySlotIndexFromAnchorMonth(now, timeZone, rule, mod);
        case 'monthlyWeekday':
            return monthlyWeekdaySlotIndex(now, timeZone, rule, mod);
        default:
            throw new Error(`Unknown squareOnePeriod.type: ${rule.type}`);
    }
}

function buildAuditListItems(slot) {
    const i = slot * 2;
    const pair = [SQUARE_ONE_PLACEHOLDERS[i], SQUARE_ONE_PLACEHOLDERS[i + 1]];
    return [...FIXED_AUDITS, ...pair];
}

function defaultConfig() {
    return {
        timeZone: 'Australia/Melbourne',
        dismissalPeriod: {
            type: 'weekly',
            weekdays: [1],
            intervalWeeks: 1,
            anchor: '2026-05-04',
        },
        squareOnePeriod: {
            type: 'weekly',
            intervalWeeks: 1,
            anchor: '2026-05-04',
            slotModulo: 4,
        },
    };
}

function loadAuditRecurrenceConfigSync(explicitPath) {
    const configPath = explicitPath || process.env.AUDIT_RECURRENCE_FILE || DEFAULT_RECURRENCE_PATH;
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        if (e.code === 'ENOENT') {
            return defaultConfig();
        }
        throw e;
    }
}

function getAuditSchedule(now = new Date(), explicitPath) {
    const cfg = loadAuditRecurrenceConfigSync(explicitPath);
    const timeZone = cfg.timeZone || 'Australia/Melbourne';
    const periodKey = dismissalPeriodKey(now, timeZone, cfg.dismissalPeriod);
    const squareSlot = squareOneSlot(now, timeZone, cfg.squareOnePeriod);
    const auditListItems = buildAuditListItems(squareSlot);
    return {
        timeZone,
        periodKey,
        weekKey: periodKey,
        squareSlot,
        auditListItems,
    };
}

function getDismissalPeriodKey(now = new Date(), explicitPath) {
    const cfg = loadAuditRecurrenceConfigSync(explicitPath);
    const timeZone = cfg.timeZone || 'Australia/Melbourne';
    return dismissalPeriodKey(now, timeZone, cfg.dismissalPeriod);
}

module.exports = {
    getAuditSchedule,
    getDismissalPeriodKey,
    loadAuditRecurrenceConfigSync,
    defaultConfig,
    FIXED_AUDITS,
    SQUARE_ONE_PLACEHOLDERS,
};
