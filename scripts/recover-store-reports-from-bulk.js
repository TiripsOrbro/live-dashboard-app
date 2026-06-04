#!/usr/bin/env node
/**
 * Split existing Reports/_bulk SCM files into Reports/{store}/ for one or more stores.
 *
 * Usage:
 *   node scripts/recover-store-reports-from-bulk.js 3808
 *   node scripts/recover-store-reports-from-bulk.js 3808 3811
 */
const fs = require('fs');
const path = require('path');
const {
    loadGrid,
    splitSpreadsheetByStoreColumn,
    detectStoreColumnIndex,
    rowsMatchingStores,
} = require('../src/services/reportReader');

const REPORTS_DIR = path.join(__dirname, '..', 'Reports');
const BULK_DIR = path.join(REPORTS_DIR, '_bulk');

const BASENAMES = {
    'stock-on-hand': 'report1',
    'stock-on-order': 'report2',
};

function bulkFilesNewestFirst(basenameHint) {
    if (!fs.existsSync(BULK_DIR)) return [];
    return fs
        .readdirSync(BULK_DIR)
        .filter((f) => f.toLowerCase().includes(basenameHint))
        .map((f) => path.join(BULK_DIR, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

/** Prefer a bulk export that contains the target store(s), or a full multi-store SCM flat file. */
function pickBulkFile(basenameHint, storeNumbers) {
    const files = bulkFilesNewestFirst(basenameHint);
    for (const src of files) {
        const { grid } = loadGrid(src);
        const detected = detectStoreColumnIndex(grid, storeNumbers);
        if (detected.matchCount >= 10) return src;
        const textMatch = rowsMatchingStores(grid, storeNumbers);
        for (const store of storeNumbers) {
            if ((textMatch.get(store) || []).length >= 10) return src;
        }
        const anyStores = detectStoreColumnIndex(grid, []);
        if (anyStores.matchCount >= 50 && grid.length >= 200) return src;
    }
    return null;
}

function main() {
    const stores = process.argv.slice(2).filter((a) => /^\d{4}$/.test(a));
    if (!stores.length) {
        console.error('Usage: node scripts/recover-store-reports-from-bulk.js <storeNumber> [more...]');
        process.exit(1);
    }

    const runSlug = `recovered-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;

    for (const [basename] of Object.entries(BASENAMES)) {
        const src = pickBulkFile(basename, stores);
        if (!src) {
            console.warn(
                `No usable *${basename}* bulk export in ${BULK_DIR} (need ~800 rows with store numbers). Run: npm run download-reports -- --store ${stores[0]}`
            );
            continue;
        }
        const split = splitSpreadsheetByStoreColumn(src, {
            storeNumbers: stores,
            reportsRoot: REPORTS_DIR,
            runSlug,
            outputBasename: basename,
        });
        console.log(`${basename} ← ${path.basename(src)} (${split.totalRows} rows, col ${split.storeColumnIndex})`);
        for (const store of stores) {
            const info = split.stores[store];
            console.log(
                info
                    ? `  ${store}: ${info.kept} row(s) → ${info.path}`
                    : `  ${store}: no rows (stores in file: ${(split.storesDetected || []).join(', ') || 'none'})`
            );
        }
        if (!split.storesDetected?.length && split.sampleRows?.length) {
            console.log('  sample:', split.sampleRows[0]);
        }
    }
}

main();
