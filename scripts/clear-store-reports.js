#!/usr/bin/env node
/**
 * Delete all report files under Reports/{storeNumber}/ (ISE, SOH, SOO, manifest).
 *
 * Usage:
 *   npm run clear-store-reports -- 3808
 *   npm run clear-store-reports -- 3808 3811
 */
const path = require('path');
const { clearStoreReportFiles } = require('../src/services/reportReader');
const { REPORTS_DIR } = require('../src/services/buildToCalculator');

function parseStores(argv) {
    const args = argv.slice(2);
    const stores = [];
    for (const arg of args) {
        if (arg === '--store' && args[args.indexOf(arg) + 1]) continue;
        if (/^\d{4}$/.test(String(arg).trim())) stores.push(String(arg).trim());
    }
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--store' && args[i + 1] && /^\d{4}$/.test(args[i + 1])) {
            stores.push(String(args[i + 1]).trim());
        }
    }
    return [...new Set(stores)];
}

function main() {
    const stores = parseStores(process.argv);
    if (!stores.length) {
        console.error('Usage: npm run clear-store-reports -- <storeNumber> [more stores...]');
        process.exit(1);
    }

    for (const storeNumber of stores) {
        const { storeDir, removed } = clearStoreReportFiles(storeNumber, REPORTS_DIR);
        if (!removed.length) {
            console.log(`[clear] Store ${storeNumber}: no files in ${storeDir}`);
            continue;
        }
        console.log(`[clear] Store ${storeNumber}: removed ${removed.length} file(s) from ${storeDir}`);
        for (const name of removed) console.log(`  - ${name}`);
    }
}

main();
