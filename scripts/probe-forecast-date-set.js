#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
require('./load-project-env');

const { openMacromatixBrowser, closeBrowserQuietly, resolveMacromatixCredentialsForStore } =
    require('../mmx/src/macromatixScraper');
const { ensureSpaAuthenticated, selectStoreOnSpa } = require('../mmx/src/sssg/sssgScraper');
const {
    CHANGE_STORE_URL,
    FORECASTING_URL,
    waitForForecastGrid,
    readDisplayedForecastDate,
    setForecastPageDate,
    isoToMmxDate,
} = require('../mmx/src/forecast/forecastScraper');

async function main() {
    const store = process.argv[2] || '3806';
    const target = process.argv[3] || '2026-06-22';
    const cred = resolveMacromatixCredentialsForStore(store);
    let browser;
    try {
        ({ browser, page } = await openMacromatixBrowser({ browserOptions: { headless: true } }));
        await ensureSpaAuthenticated(page, cred);
        await page.goto(CHANGE_STORE_URL, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(800);
        await selectStoreOnSpa(page, store);
        await page.goto(FORECASTING_URL, { waitUntil: 'load', timeout: 60000 });
        await waitForForecastGrid(page);

        console.log('before', await readDisplayedForecastDate(page));
        const result = await setForecastPageDate(page, target);
        console.log('result', result);
        console.log('after', await readDisplayedForecastDate(page), 'wanted', isoToMmxDate(target));
    } finally {
        await closeBrowserQuietly(browser, 'probe-set');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
