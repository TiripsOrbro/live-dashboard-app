#!/usr/bin/env node
/** Dump forecast day-view DOM hints for selector discovery. */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');
process.env.LIFELENZ_SCRAPER_HEADLESS = 'false';

const { createAuthenticatedLifeLenzSession, getDevLifeLenzCredentials } = require('../lifelenz/src/lifelenzAuth');
const {
    selectStoreInLifeLenz,
    navigateToForecast,
    switchToDayView,
    setForecastDate,
    describeForecastPageState,
    fillDayPartsWithOvernightQuirk,
} = require('../lifelenz/src/lifelenzForecastScraper');

async function main() {
    const store = process.argv[2] || '3806';
    const date = process.argv[3] || '2026-06-22';
    const emailArg = process.argv[4];
    const passwordArg = process.argv[5];
    const dev = getDevLifeLenzCredentials();
    const email = emailArg || dev?.email;
    const password = passwordArg || dev?.password;
    if (!email || !password) {
        console.error(
            '[probe-lifelenz-forecast-dom] Set TempLifeLenzU / TempLifeLenzP in .env or pass email and password as args 4–5'
        );
        process.exit(1);
    }

    const logStep = (label) => console.log(`\n[step] ${label} — watch the browser…`);
    const session = await createAuthenticatedLifeLenzSession(email, password, { headless: false });
    logStep(`1/5 Select store ${store}`);
    await selectStoreInLifeLenz(session.page, store);
    await session.page.waitForTimeout(1500);
    logStep('2/5 Analytics → Forecast');
    await navigateToForecast(session.page);
    await session.page.waitForTimeout(1500);
    logStep('3/5 Switch to Day view');
    await switchToDayView(session.page);
    await session.page.waitForTimeout(1500);
    logStep(`4/6 Navigate to date ${date}`);
    await setForecastDate(session.page, date);
    await session.page.waitForTimeout(2000);
    logStep('5/6 Inspect forecast fields');
    const state = await describeForecastPageState(session.page);
    console.log(JSON.stringify(state, null, 2));
    await session.page.screenshot({ path: 'scripts/lifelenz-forecast-day.png', fullPage: true });
    console.log('Screenshot: scripts/lifelenz-forecast-day.png');

    if (state.visibleDayPartInputs >= 9) {
        logStep('6/6 Enter forecast values (one day)');
        const { previewForecastForStore } = require('../dashboard/src/forecast/forecastRunner');
        const preview = await previewForecastForStore(store, { targetScope: 'day', date });
        const planDay = preview.plan?.[0];
        if (planDay) {
            await fillDayPartsWithOvernightQuirk(session.page, require('../lifelenz/src/lifelenzDayParts').aggregateDayPartsFromHourlyPlan(planDay), {
                onProgress: (p) => console.log('[progress]', JSON.stringify(p)),
            });
            console.log('[probe-lifelenz-forecast-dom] Day-part entry complete.');
        }
    } else {
        console.warn(
            `[probe-lifelenz-forecast-dom] Only ${state.visibleDayPartInputs}/9 day-part inputs visible — not entering values.`
        );
    }
    console.log('\nBrowser left open — inspect manually, then close.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
