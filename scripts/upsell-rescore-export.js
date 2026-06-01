#!/usr/bin/env node
/**
 * Re-score a saved MMX Excel export (no browser).
 *
 *   node scripts/upsell-rescore-export.js 3811
 *   node scripts/upsell-rescore-export.js 3811 path/to/export.xls
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { upsellingDataDir } = require('../src/services/upselling/upsellingConfig');
const { processReportFile } = require('../src/services/upselling/upsellingScores');
const { buildLeaderboardPayload } = require('../src/services/upselling/upsellingScores');
const { loadEmployees } = require('../src/services/upselling/employeesFile');

function findLastExport(store) {
    const dir = upsellingDataDir(store);
    for (const ext of ['.xls', '.xlsx']) {
        const p = path.join(dir, `last-export${ext}`);
        if (fs.existsSync(p)) return p;
    }
    const downloads = path.join(dir, 'downloads');
    if (!fs.existsSync(downloads)) return null;
    const files = fs
        .readdirSync(downloads)
        .filter((f) => /\.xlsx?$/i.test(f))
        .map((f) => ({ f, m: fs.statSync(path.join(downloads, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
    return files.length ? path.join(downloads, files[0].f) : null;
}

function main() {
    const store = process.argv[2];
    const fileArg = process.argv[3];
    if (!store) {
        console.error('Usage: node scripts/upsell-rescore-export.js <storeNumber> [export.xls]');
        process.exit(1);
    }
    const filePath = fileArg ? path.resolve(fileArg) : findLastExport(store);
    if (!filePath || !fs.existsSync(filePath)) {
        console.error(
            `No export found. Run: npm run upsell-sync -- ${store}\n` +
                `Or pass a file: node scripts/upsell-rescore-export.js ${store} path/to/export.xls`
        );
        process.exit(1);
    }
    console.log(`[upsell-rescore] ${filePath}`);
    processReportFile(filePath, store, { source: 'rescore-export' });
    const { byDay } = loadEmployees();
    console.log(`[upsell-rescore] .Employees rows: ${byDay.length}`);
    const payload = buildLeaderboardPayload(store);
    console.log(`[upsell-rescore] Top 5 for ${store}:`);
    for (const r of payload.top5) {
        console.log(`  ${r.rank}. ${r.name} — ${r.total} (best day ${r.bestDay || '?'})`);
    }
}

main();
