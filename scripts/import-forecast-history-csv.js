#!/usr/bin/env node
/**
 * Convert Macromatix "Sales by Hour Interval" CSV export into forecast history JSON
 * and optionally import into dashboard/data/forecast-history/.
 *
 * Expected layout (Area 22 export):
 * - Row after "Standard Day of Week" header: week-ending dates (Sundays), 6 per store block
 * - Column A: weekday name; column B: hour interval (e.g. 11:00-11:59)
 * - C–H = 3806, I–N = 3808, O–T = 3811, U–Z = 3901, AA–AF = 3902, AG–AL = 3903, AM–AR = 3904
 *
 * Usage:
 *   npm run import-forecast-history-csv -- "C:/path/Sales_by_Hour_Interval.csv"
 *   npm run import-forecast-history-csv -- file.csv --out dashboard/data/forecast-history/area22.json
 *   npm run import-forecast-history-csv -- file.csv --import --force
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

const { parseStoreList, resolveHours } = require('../stores/src/storeList');
const { importForecastHistory, assessHistoryReadiness } = require('../dashboard/src/forecast/forecastHistoryLedger');
const paths = require('../src/paths');

const STORE_BLOCKS = [
    { storeNumber: '3806', startCol: 2 },
    { storeNumber: '3808', startCol: 8 },
    { storeNumber: '3811', startCol: 14 },
    { storeNumber: '3901', startCol: 20 },
    { storeNumber: '3902', startCol: 26 },
    { storeNumber: '3903', startCol: 32 },
    { storeNumber: '3904', startCol: 38 },
];

const WEEKS_PER_STORE = 6;

const DAY_OFFSET_FROM_SUNDAY = {
    Monday: -6,
    Tuesday: -5,
    Wednesday: -4,
    Thursday: -3,
    Friday: -2,
    Saturday: -1,
    Sunday: 0,
};

function parseCsvLine(line) {
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (c === '"') {
            inQuotes = !inQuotes;
            continue;
        }
        if (c === ',' && !inQuotes) {
            fields.push(cur);
            cur = '';
            continue;
        }
        cur += c;
    }
    fields.push(cur);
    return fields;
}

function parseNumber(raw) {
    if (raw == null || !String(raw).trim()) return 0;
    const n = Number(String(raw).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : 0;
}

function parseHourSegment(segment) {
    const m = String(segment || '').match(/^(\d{1,2}):/);
    return m ? parseInt(m[1], 10) : null;
}

function addDaysToIso(iso, days) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function calendarDateFromWeekEnd(weekEndIso, dayName) {
    const offset = DAY_OFFSET_FROM_SUNDAY[dayName];
    if (offset === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(String(weekEndIso || ''))) return null;
    return addDaysToIso(weekEndIso, offset);
}

function loadParsedStores() {
    const storeListPath = path.join(paths.stores.root, '.storelist');
    const examplePath = path.join(paths.stores.root, '.storelist.example');
    const filePath = fs.existsSync(storeListPath) ? storeListPath : examplePath;
    if (!fs.existsSync(filePath)) return new Map();
    const parsed = parseStoreList(fs.readFileSync(filePath, 'utf8'));
    return new Map(parsed.map((s) => [s.storeNumber, s]));
}

function readWeekEndingDates(fields) {
    const byStore = {};
    for (const block of STORE_BLOCKS) {
        byStore[block.storeNumber] = [];
        for (let w = 0; w < WEEKS_PER_STORE; w += 1) {
            const raw = String(fields[block.startCol + w] || '').trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) byStore[block.storeNumber].push(raw);
        }
    }
    return byStore;
}

function parseSalesByHourIntervalCsv(text) {
    const lines = String(text || '')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '');

    let headerIdx = lines.findIndex((line) => line.startsWith('Standard Day of Week'));
    if (headerIdx < 0) {
        throw new Error('Could not find "Standard Day of Week" header row');
    }
    const datesRow = parseCsvLine(lines[headerIdx + 1] || '');
    const weekEndsByStore = readWeekEndingDates(datesRow);

    /** @type {Map<string, Map<number, number>>} date -> hour -> dollars */
    const dayHourMap = new Map();

    for (let i = headerIdx + 2; i < lines.length; i += 1) {
        const fields = parseCsvLine(lines[i]);
        const dayName = String(fields[0] || '').trim();
        if (!Object.prototype.hasOwnProperty.call(DAY_OFFSET_FROM_SUNDAY, dayName)) continue;

        const hour = parseHourSegment(fields[1]);
        if (hour == null) continue;

        for (const block of STORE_BLOCKS) {
            const weekEnds = weekEndsByStore[block.storeNumber] || [];
            for (let w = 0; w < weekEnds.length; w += 1) {
                const dateKey = calendarDateFromWeekEnd(weekEnds[w], dayName);
                if (!dateKey) continue;

                const value = Math.max(0, parseNumber(fields[block.startCol + w]));
                if (value <= 0) continue;

                const storeDayKey = `${block.storeNumber}|${dateKey}`;
                if (!dayHourMap.has(storeDayKey)) dayHourMap.set(storeDayKey, new Map());
                const hourMap = dayHourMap.get(storeDayKey);
                hourMap.set(hour, (hourMap.get(hour) || 0) + value);
            }
        }
    }

    const parsedStores = loadParsedStores();
    const days = {};

    for (const [storeDayKey, hourMap] of dayHourMap.entries()) {
        const [storeNumber, dateKey] = storeDayKey.split('|');
        const store = parsedStores.get(storeNumber);
        const date = new Date(`${dateKey}T12:00:00`);
        const { openHour, closeHour } = store
            ? resolveHours(store, date)
            : { openHour: 10, closeHour: 22 };

        const len = Math.max(0, closeHour - openHour);
        const actual = new Array(len).fill(0);
        for (const [hour, dollars] of hourMap.entries()) {
            if (hour >= openHour && hour < closeHour) {
                actual[hour - openHour] += dollars;
            }
        }

        const actualTotal = Math.round(actual.reduce((s, v) => s + v, 0) * 100) / 100;
        if (actualTotal <= 0) continue;

        if (!days[dateKey]) days[dateKey] = {};
        days[dateKey][storeNumber] = {
            openHour,
            closeHour,
            actual,
            actualTotal,
            ...(store?.timeZone ? { timeZone: store.timeZone } : {}),
        };
    }

    return {
        days,
        meta: {
            weekEndsByStore,
            storeBlocks: STORE_BLOCKS.map((b) => b.storeNumber),
            dayCount: Object.keys(days).length,
        },
    };
}

function main() {
    const argv = process.argv.slice(2);
    const force = argv.includes('--force');
    const doImport = argv.includes('--import') || !argv.includes('--json-only');
    const outIdx = argv.indexOf('--out');
    const outPath = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : null;
    const fileArg = argv.find((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
    const filePath = path.resolve(fileArg || '');

    if (!filePath || !fs.existsSync(filePath)) {
        console.error('[import-forecast-history-csv] Usage: npm run import-forecast-history-csv -- <csv-file> [--out path.json] [--import] [--force]');
        process.exit(1);
    }

    const payload = parseSalesByHourIntervalCsv(fs.readFileSync(filePath, 'utf8'));
    const storeDays = Object.values(payload.days).reduce((n, m) => n + Object.keys(m).length, 0);
    console.log(
        `[import-forecast-history-csv] Parsed ${storeDays} store-day row(s) across ${payload.meta.dayCount} calendar day(s)`
    );

    if (outPath) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, `${JSON.stringify({ days: payload.days }, null, 2)}\n`, 'utf8');
        console.log(`[import-forecast-history-csv] Wrote ${outPath}`);
    }

    if (doImport) {
        const result = importForecastHistory({ days: payload.days }, { force, source: 'csv-import' });
        console.log(
            `[import-forecast-history-csv] Imported ${result.imported} store-day row(s) across ${result.stores.length} store(s)` +
                (force ? ' (forced overwrite)' : '')
        );
        for (const storeNumber of result.stores) {
            const readiness = assessHistoryReadiness(storeNumber);
            const status = readiness.ready ? 'ready' : `needs more (${readiness.weekdayGaps.join(', ') || 'days'})`;
            console.log(`  ${storeNumber}: ${readiness.daysRecorded} days (${readiness.oldestDate} → ${readiness.newestDate}) — ${status}`);
        }
    }
}

module.exports = { parseSalesByHourIntervalCsv, STORE_BLOCKS, calendarDateFromWeekEnd };

if (require.main === module) main();
