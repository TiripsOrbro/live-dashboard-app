#!/usr/bin/env node
/**
 * Re-score a saved MMX Excel export (no browser).
 *
 *   node scripts/upsell-rescore-export.js 3811
 *   node scripts/upsell-rescore-export.js 3811 path/to/export.xls
 *   node scripts/upsell-rescore-export.js --all-stores path/to/regional-export.csv
 *   node scripts/upsell-rescore-export.js --all-stores --all-days path/to/regional-export.csv
 *   node scripts/upsell-rescore-export.js --all-stores --day 2026-06-01 path/to/export.csv
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
    upsellingRootDir,
    upsellingLastExportPath,
} = require('../src/services/upselling/upsellingConfig');
const { processMultiStoreReportFile, buildLeaderboardPayload } = require('../src/services/upselling/upsellingScores');
const { loadScores } = require('../src/services/upselling/leaderboardStore');
const { runUpsellFromFile } = require('../src/services/upselling/upsellMmxPipeline');

function findLastExport() {
    const dir = upsellingRootDir();
    for (const ext of ['.csv', '.xls', '.xlsx']) {
        const p = upsellingLastExportPath(ext);
        if (fs.existsSync(p)) return p;
    }
    const sample = path.join(dir, 'sample-multi-store.csv');
    if (fs.existsSync(sample)) return sample;
    const files = fs
        .readdirSync(dir)
        .filter((f) => /-upsell-by-cashier\.(csv|xls|xlsx)$/i.test(f))
        .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
    return files.length ? path.join(dir, files[0].f) : null;
}

function main() {
    const args = process.argv.slice(2).filter((a) => a !== '--');
    const allStores = args.includes('--all-stores');
    const allDays = args.includes('--all-days') || args.includes('--backfill');
    const dayIdx = args.indexOf('--day');
    const syncDay = allDays ? null : dayIdx >= 0 ? args[dayIdx + 1] : undefined;
    const positional = args.filter((a, i) => {
        if (a.startsWith('--')) return false;
        if (dayIdx >= 0 && i === dayIdx + 1) return false;
        return true;
    });
    const store = allStores ? null : positional[0];
    const fileArg = allStores ? positional[0] : positional[1];

    if (!allStores && !store) {
        console.error(
            'Usage: node scripts/upsell-rescore-export.js <storeNumber> [export.xls] [--day YYYY-MM-DD]\n' +
                '       node scripts/upsell-rescore-export.js --all-stores [export.csv] [--all-days] [--day YYYY-MM-DD]'
        );
        process.exit(1);
    }

    const filePath = fileArg ? path.resolve(fileArg) : findLastExport();
    if (!filePath || !fs.existsSync(filePath)) {
        console.error(
            `No export found. Run: npm run upsell-sync -- ${allStores ? '--all-stores' : store}\n` +
                `Or pass a file explicitly.`
        );
        process.exit(1);
    }
    console.log(`[upsell-rescore] ${filePath}`);

    if (allStores) {
        const multi = runUpsellFromFile(null, filePath, {
            allStores: true,
            allDays,
            syncDay,
            source: 'rescore-export',
        });
        console.log(`[upsell-rescore] Updated stores: ${multi.storeNumbers.join(', ') || '(none)'}`);
        for (const storeNumber of multi.storeNumbers) {
            const payload = buildLeaderboardPayload(storeNumber);
            const period =
                (payload.leaderboardPeriod === 'weekBestDay' || payload.leaderboardPeriod === 'week') &&
                    payload.weekStart
                    ? `best day ${payload.weekStart} – ${payload.weekEnd}`
                    : `day ${payload.leaderboardDay || '?'}`;
            console.log(`\n[upsell-rescore] Top 7 for ${storeNumber} (${period}):`);
            for (const r of payload.top7 || payload.top5 || payload.top3 || []) {
                console.log(`  ${r.rank}. ${r.name} - ${r.total} pts`);
            }
        }
        return;
    }

    const { processReportFile } = require('../src/services/upselling/upsellingScores');
    processReportFile(filePath, store, {
        source: 'rescore-export',
        syncDay,
        allDays,
    });
    const { rows } = loadScores(store);
    console.log(`[upsell-rescore] ${store}_leaderboard.json rows: ${rows.length}`);
    const payload = buildLeaderboardPayload(store);
    const period =
        (payload.leaderboardPeriod === 'weekBestDay' || payload.leaderboardPeriod === 'week') &&
            payload.weekStart
            ? `best day ${payload.weekStart} – ${payload.weekEnd}`
            : `day ${payload.leaderboardDay || '?'}`;
    console.log(`[upsell-rescore] Top 7 for ${store} (${period}):`);
    for (const r of payload.top7 || payload.top5 || []) {
        console.log(`  ${r.rank}. ${r.name} - ${r.total} pts`);
    }
}

main();
