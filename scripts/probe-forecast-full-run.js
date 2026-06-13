#!/usr/bin/env node
/**
 * Headed full forecast run — Macromatix + LifeLenz in parallel for one target week.
 *
 * Usage:
 *   npm run probe-forecast-full-run -- 3806 3811
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

process.env.FORECAST_SCRAPER_HEADLESS = 'false';
process.env.LIFELENZ_SCRAPER_HEADLESS = 'false';

const { runCombinedForecastForStores, buildTargetForecastDates } = require('../dashboard/src/forecast/forecastRunner');
const { getDevLifeLenzCredentials } = require('../lifelenz/src/lifelenzAuth');

async function main() {
    const storeNumbers = process.argv.slice(2).filter(Boolean);
    if (!storeNumbers.length) {
        console.error('Usage: npm run probe-forecast-full-run -- 3806 3811');
        process.exit(1);
    }

    const { targetWeeks, dates } = buildTargetForecastDates();
    console.log('[probe-forecast-full-run] Stores:', storeNumbers.join(', '));
    console.log('[probe-forecast-full-run] Target week(s):', targetWeeks.join(', '));
    console.log('[probe-forecast-full-run] Dates:', dates.join(', '));
    console.log('[probe-forecast-full-run] Running MMX + LifeLenz in parallel (headed)...');

    const creds = getDevLifeLenzCredentials();
    const combined = await runCombinedForecastForStores(storeNumbers, {
        headless: false,
        keepBrowserOpen: true,
        lifelenzCredentials: creds,
        completedBy: 'probe',
        onProgress: (payload) =>
            console.log(`[${payload.platform || 'run'}]`, JSON.stringify(payload)),
    });

    console.log('\n[probe-forecast-full-run] Macromatix results:');
    for (const row of combined.mmxResults) {
        console.log(`  ${row.storeNumber}: ${row.ok ? 'ok' : 'FAILED'}${row.error ? ' — ' + row.error : ''}`);
    }
    console.log('\n[probe-forecast-full-run] LifeLenz results:');
    for (const row of combined.lifelenzResults) {
        console.log(`  ${row.storeNumber}: ${row.ok ? 'ok' : 'FAILED'}${row.error ? ' — ' + row.error : ''}`);
    }

    console.log('\n[probe-forecast-full-run] Complete.');
    console.log(JSON.stringify(combined, null, 2));
    console.log('[probe-forecast-full-run] Browser left open — close manually when done.');
}

main().catch((err) => {
    console.error('[probe-forecast-full-run] Failed:', err.message);
    process.exit(1);
});
