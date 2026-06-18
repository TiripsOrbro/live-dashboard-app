#!/usr/bin/env node
/**
 * Headed forecast submit probe - one store, visible browser.
 *
 * Usage:
 *   npm run probe-forecast-submit -- 3806
 *   FORECAST_SCRAPER_HEADLESS=false npm run probe-forecast-submit -- 3806
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

process.env.FORECAST_SCRAPER_HEADLESS = 'false';

const { runForecastForStore } = require('../dashboard/src/forecast/forecastRunner');

async function main() {
    const storeNumber = process.argv[2] || '3806';
    console.log(`[probe-forecast] Submitting forecast for store ${storeNumber} (headed)...`);
    const result = await runForecastForStore(storeNumber, {
        headless: false,
        keepBrowserOpen: true,
    });
    console.log(JSON.stringify(result, null, 2));
    console.log('[probe-forecast] Browser left open - close manually when done.');
}

main().catch((err) => {
    console.error('[probe-forecast] Failed:', err.message);
    process.exit(1);
});
