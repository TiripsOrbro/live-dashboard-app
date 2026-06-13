#!/usr/bin/env node
/**
 * Headed LifeLenz forecast entry probe — one store, visible browser.
 *
 * Usage:
 *   npm run probe-lifelenz-forecast -- 3806
 *   npm run probe-lifelenz-forecast -- 3806 2026-06-16
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

process.env.LIFELENZ_SCRAPER_HEADLESS = 'false';

const { getDevLifeLenzCredentials } = require('../lifelenz/src/lifelenzAuth');
const { createAuthenticatedLifeLenzSession } = require('../lifelenz/src/lifelenzAuth');
const { writeForecastPlanOnPage } = require('../lifelenz/src/lifelenzForecastScraper');
const { previewForecastForStore } = require('../dashboard/src/forecast/forecastRunner');
const { closeBrowserQuietly } = require('../mmx/src/macromatixScraper');

async function main() {
    const storeNumber = process.argv[2] || '3806';
    const onlyDate = process.argv[3] || null;
    const creds = getDevLifeLenzCredentials();
    if (!creds) {
        console.error('[probe-lifelenz-forecast] Set TempLifeLenzU / TempLifeLenzP in .env');
        process.exit(1);
    }

    console.log(`[probe-lifelenz-forecast] Building plan for store ${storeNumber}...`);
    const preview = await previewForecastForStore(storeNumber);
    let plan = preview.plan || [];
    if (onlyDate) {
        plan = plan.filter((day) => day.date === onlyDate);
        if (!plan.length) {
            console.error(`[probe-lifelenz-forecast] No plan day for ${onlyDate}`);
            process.exit(1);
        }
    } else if (plan.length) {
        plan = [plan[0]];
    }

    console.log(`[probe-lifelenz-forecast] Entering ${plan.length} day(s) in LifeLenz (headed)...`);
    const session = await createAuthenticatedLifeLenzSession(creds.email, creds.password, { headless: false });
    try {
        const result = await writeForecastPlanOnPage(session.page, storeNumber, plan, session.stores, {
            onProgress: (payload) => console.log('[progress]', JSON.stringify(payload)),
        });
        console.log(JSON.stringify(result, null, 2));
        console.log('[probe-lifelenz-forecast] Browser left open — close manually when done.');
    } catch (err) {
        await closeBrowserQuietly(session.browser, 'probe-error');
        throw err;
    }
}

main().catch((err) => {
    console.error('[probe-lifelenz-forecast] Failed:', err.message);
    process.exit(1);
});
