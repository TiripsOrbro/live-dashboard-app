#!/usr/bin/env node
/**
 * Import hourly sales history for forecast shaping (Area 22 backfill, etc.).
 *
 * Usage:
 *   npm run import-forecast-history -- dashboard/data/forecast-history/your-file.json
 *   npm run import-forecast-history -- dashboard/data/forecast-history/your-file.json --force
 *
 * See dashboard/data/forecast-history/import-template.json for format.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

const { importForecastHistory, assessHistoryReadiness } = require('../dashboard/src/forecast/forecastHistoryLedger');

function main() {
    const args = process.argv.slice(2).filter((a) => a !== '--force');
    const force = process.argv.includes('--force');
    const filePath = path.resolve(
        args[0] || path.join(__dirname, '../dashboard/data/forecast-history/import-template.json')
    );

    if (!fs.existsSync(filePath)) {
        console.error(`[import-forecast-history] File not found: ${filePath}`);
        process.exit(1);
    }

    let payload;
    try {
        payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error(`[import-forecast-history] Invalid JSON: ${err.message}`);
        process.exit(1);
    }

    const result = importForecastHistory(payload, { force, source: 'import-cli' });
    console.log(
        `[import-forecast-history] Imported ${result.imported} store-day row(s) across ${result.stores.length} store(s)` +
            (force ? ' (forced overwrite)' : '')
    );

    for (const storeNumber of result.stores) {
        const readiness = assessHistoryReadiness(storeNumber);
        const status = readiness.ready ? 'ready' : `needs more (${readiness.weekdayGaps.join(', ') || 'days'})`;
        console.log(`  ${storeNumber}: ${readiness.daysRecorded} days — ${status}`);
    }
}

main();
