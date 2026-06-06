#!/usr/bin/env node
/**
 * Import Mon–Fri (or any) daily actual + LY totals into the SSSG weekly ledger.
 *
 * Usage:
 *   node scripts/import-sssg-weekly.js data/sssg-weekly/import-template.json
 *   node scripts/import-sssg-weekly.js data/sssg-weekly/import-template.json --force
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

const { importWeeklyDays } = require('../src/services/sssg/sssgWeeklyLedger');

function main() {
    const args = process.argv.slice(2).filter((a) => a !== '--force');
    const force = process.argv.includes('--force');
    const filePath = path.resolve(args[0] || path.join(__dirname, '../data/sssg-weekly/import-template.json'));

    if (!fs.existsSync(filePath)) {
        console.error(`[import-sssg-weekly] File not found: ${filePath}`);
        process.exit(1);
    }

    let payload;
    try {
        payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error(`[import-sssg-weekly] Invalid JSON: ${err.message}`);
        process.exit(1);
    }

    const result = importWeeklyDays(payload, { force });
    console.log(
        `[import-sssg-weekly] Imported ${result.imported} store-day row(s) into week ${result.weekStart}` +
            (force ? ' (forced overwrite)' : '')
    );
}

main();
