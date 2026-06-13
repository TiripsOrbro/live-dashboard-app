#!/usr/bin/env node
/**
 * Import forecast history from the Area 22 "Forecast Calculator" Excel workbook.
 *
 * Skips the first two tabs ("Forecasts at a Glance", "Store Level"). Each remaining tab
 * is one store with hourly actual sales in a Mon–Sun grid:
 * - Vertical sections: Current Week, Last Week, Two Weeks Ago, Three Weeks Ago
 * - Each weekday block (7 cols): Hour label + Sales $ in the first two columns
 *
 * Usage:
 *   npm run import-forecast-history-xlsx -- "C:/path/A) Forecast Calculator - A22.xlsx"
 *   npm run import-forecast-history-xlsx -- file.xlsx --as-of 2026-06-13 --force
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

const { parseStoreList, resolveHours } = require('../stores/src/storeList');
const { importForecastHistory, assessHistoryReadiness } = require('../dashboard/src/forecast/forecastHistoryLedger');
const paths = require('../src/paths');

const SKIP_SHEETS = 2;

const SHEET_STORE_MAP = {
    dandenong: '3806',
    berwick: '3808',
    chirnside: '3811',
    midland: '3901',
    ellenbrook: '3902',
    'canning vale': '3903',
    butler: '3904',
};

const WEEKDAY_BLOCKS = [
    { name: 'Monday', startCol: 1 },
    { name: 'Tuesday', startCol: 8 },
    { name: 'Wednesday', startCol: 15 },
    { name: 'Thursday', startCol: 22 },
    { name: 'Friday', startCol: 29 },
    { name: 'Saturday', startCol: 36 },
    { name: 'Sunday', startCol: 43 },
];

const WEEK_SECTION_LABELS = ['Current Week', 'Last Week', 'Two Weeks Ago', 'Three Weeks Ago'];

const DAY_OFFSET_FROM_SUNDAY = {
    Monday: -6,
    Tuesday: -5,
    Wednesday: -4,
    Thursday: -3,
    Friday: -2,
    Saturday: -1,
    Sunday: 0,
};

function addDaysToIso(iso, days) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function isoFromDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function weekEndingSundayOnOrAfter(asOfDate) {
    const d = new Date(asOfDate.getFullYear(), asOfDate.getMonth(), asOfDate.getDate());
    const day = d.getDay();
    const daysToSunday = (7 - day) % 7;
    d.setDate(d.getDate() + daysToSunday);
    return isoFromDate(d);
}

function calendarDateForWeekday(weekEndingSunday, weekdayName) {
    const offset = DAY_OFFSET_FROM_SUNDAY[weekdayName];
    if (offset === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(String(weekEndingSunday || ''))) return null;
    return addDaysToIso(weekEndingSunday, offset);
}

function parseSales(raw) {
    if (raw == null || !String(raw).trim()) return 0;
    const n = Number(String(raw).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function parseHourLabel(label) {
    const s = String(label || '').toLowerCase();
    const m = s.match(/(\d{1,2}):(\d{2})\s*(am|pm)/);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return h;
}

function looksLikeHourCell(value) {
    return /^\d{1,2}:\d{2}\s*(am|pm)/i.test(String(value || '').trim());
}

function storeNumberForSheet(sheetName) {
    const key = String(sheetName || '').trim().toLowerCase();
    return SHEET_STORE_MAP[key] || null;
}

function findWeekSections(rows) {
    const sections = [];
    for (let i = 0; i < rows.length; i += 1) {
        const label = String(rows[i]?.[0] || '').trim();
        const weeksAgo = WEEK_SECTION_LABELS.indexOf(label);
        if (weeksAgo >= 0) sections.push({ weeksAgo, startRow: i, label });
    }
    for (let s = 0; s < sections.length; s += 1) {
        sections[s].endRow = (sections[s + 1]?.startRow ?? rows.length) - 1;
    }
    return sections;
}

function loadParsedStores() {
    const storeListPath = path.join(paths.stores.root, '.storelist');
    const examplePath = path.join(paths.stores.root, '.storelist.example');
    const filePath = fs.existsSync(storeListPath) ? storeListPath : examplePath;
    if (!fs.existsSync(filePath)) return new Map();
    const parsed = parseStoreList(fs.readFileSync(filePath, 'utf8'));
    return new Map(parsed.map((s) => [s.storeNumber, s]));
}

function buildDayEntry(hourMap, storeNumber, dateKey, parsedStores) {
    const store = parsedStores.get(storeNumber);
    const date = new Date(`${dateKey}T12:00:00`);
    const { openHour, closeHour } = store ? resolveHours(store, date) : { openHour: 10, closeHour: 22 };

    const len = Math.max(0, closeHour - openHour);
    const actual = new Array(len).fill(0);
    for (const [hour, dollars] of hourMap.entries()) {
        if (hour >= openHour && hour < closeHour) {
            actual[hour - openHour] += dollars;
        }
    }

    const actualTotal = Math.round(actual.reduce((s, v) => s + v, 0) * 100) / 100;
    if (actualTotal <= 0) return null;

    return {
        openHour,
        closeHour,
        actual,
        actualTotal,
        ...(store?.timeZone ? { timeZone: store.timeZone } : {}),
    };
}

function parseStoreSheet(rows, storeNumber, asOfDate) {
    const currentWeekEnd = weekEndingSundayOnOrAfter(asOfDate);
    const sections = findWeekSections(rows);
    /** @type {Map<string, Map<number, number>>} */
    const dayHourMap = new Map();

    for (const section of sections) {
        const weekEnd = addDaysToIso(currentWeekEnd, -7 * section.weeksAgo);
        for (let r = section.startRow; r <= section.endRow; r += 1) {
            const row = rows[r] || [];
            for (const block of WEEKDAY_BLOCKS) {
                const hourLabel = row[block.startCol];
                if (!looksLikeHourCell(hourLabel)) continue;

                const hour = parseHourLabel(hourLabel);
                if (hour == null) continue;

                const sales = parseSales(row[block.startCol + 1]);
                if (sales <= 0) continue;

                const dateKey = calendarDateForWeekday(weekEnd, block.name);
                if (!dateKey) continue;

                const key = `${dateKey}`;
                if (!dayHourMap.has(key)) dayHourMap.set(key, new Map());
                const hourMap = dayHourMap.get(key);
                hourMap.set(hour, (hourMap.get(hour) || 0) + sales);
            }
        }
    }

    const parsedStores = loadParsedStores();
    const days = {};
    for (const [dateKey, hourMap] of dayHourMap.entries()) {
        const entry = buildDayEntry(hourMap, storeNumber, dateKey, parsedStores);
        if (!entry) continue;
        if (!days[dateKey]) days[dateKey] = {};
        days[dateKey][storeNumber] = entry;
    }

    return days;
}

function parseForecastCalculatorWorkbook(filePath, options = {}) {
    const asOf = options.asOfDate || new Date();
    const wb = XLSX.readFile(filePath, { cellDates: true });
    const sheetNames = wb.SheetNames.slice(SKIP_SHEETS);
    const days = {};
    const meta = { sheets: [], asOf: isoFromDate(asOf), weekEnding: weekEndingSundayOnOrAfter(asOf) };

    for (const sheetName of sheetNames) {
        const storeNumber = storeNumberForSheet(sheetName);
        if (!storeNumber) {
            meta.sheets.push({ sheetName, skipped: true, reason: 'unknown store tab name' });
            continue;
        }

        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: false });
        const sheetDays = parseStoreSheet(rows, storeNumber, asOf);
        let dayCount = 0;
        for (const [dateKey, storesMap] of Object.entries(sheetDays)) {
            if (!days[dateKey]) days[dateKey] = {};
            days[dateKey][storeNumber] = storesMap[storeNumber];
            dayCount += 1;
        }
        meta.sheets.push({ sheetName, storeNumber, dayCount });
    }

    meta.dayCount = Object.keys(days).length;
    return { days, meta };
}

function parseAsOfArg(raw) {
    if (!raw) return new Date();
    const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error(`Invalid --as-of date "${raw}" (use YYYY-MM-DD)`);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function main() {
    const argv = process.argv.slice(2);
    const force = argv.includes('--force');
    const jsonOnly = argv.includes('--json-only');
    const doImport = argv.includes('--import') || !jsonOnly;
    const asOfIdx = argv.indexOf('--as-of');
    const outIdx = argv.indexOf('--out');
    const outPath = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : null;
    const asOfDate = parseAsOfArg(asOfIdx >= 0 ? argv[asOfIdx + 1] : null);
    const fileArg = argv.find(
        (a, i) =>
            !a.startsWith('--') &&
            (outIdx < 0 || i !== outIdx + 1) &&
            (asOfIdx < 0 || i !== asOfIdx + 1)
    );
    const filePath = path.resolve(fileArg || '');

    if (!filePath || !fs.existsSync(filePath)) {
        console.error(
            '[import-forecast-history-xlsx] Usage: npm run import-forecast-history-xlsx -- <file.xlsx> [--as-of YYYY-MM-DD] [--out path.json] [--force]'
        );
        process.exit(1);
    }

    const payload = parseForecastCalculatorWorkbook(filePath, { asOfDate });
    const storeDays = Object.values(payload.days).reduce((n, m) => n + Object.keys(m).length, 0);
    console.log(
        `[import-forecast-history-xlsx] Parsed ${storeDays} store-day row(s) across ${payload.meta.dayCount} calendar day(s)` +
            ` (as-of ${payload.meta.asOf}, week ending ${payload.meta.weekEnding})`
    );
    for (const sheet of payload.meta.sheets) {
        if (sheet.skipped) console.log(`  ${sheet.sheetName}: skipped (${sheet.reason})`);
        else console.log(`  ${sheet.sheetName} → ${sheet.storeNumber}: ${sheet.dayCount} days`);
    }

    if (outPath) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${JSON.stringify({ days: payload.days }, null, 2)}\n`, 'utf8');
        console.log(`[import-forecast-history-xlsx] Wrote ${outPath}`);
    }

    if (doImport) {
        const result = importForecastHistory({ days: payload.days }, { force, source: 'xlsx-import' });
        console.log(
            `[import-forecast-history-xlsx] Imported ${result.imported} store-day row(s) across ${result.stores.length} store(s)` +
                (force ? ' (forced overwrite)' : '')
        );
        for (const storeNumber of result.stores) {
            const readiness = assessHistoryReadiness(storeNumber);
            const status = readiness.ready ? 'ready' : `needs more (${readiness.weekdayGaps.join(', ') || 'days'})`;
            console.log(`  ${storeNumber}: ${readiness.daysRecorded} days (${readiness.oldestDate} → ${readiness.newestDate}) — ${status}`);
        }
    }
}

module.exports = {
    parseForecastCalculatorWorkbook,
    storeNumberForSheet,
    weekEndingSundayOnOrAfter,
    SHEET_STORE_MAP,
};

if (require.main === module) main();
