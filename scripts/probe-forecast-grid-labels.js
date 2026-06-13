#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
require('./load-project-env');
const { openMacromatixBrowser, closeBrowserQuietly, resolveMacromatixCredentialsForStore } =
    require('../mmx/src/macromatixScraper');
const { ensureSpaAuthenticated, selectStoreOnSpa } = require('../mmx/src/sssg/sssgScraper');
const { CHANGE_STORE_URL, FORECASTING_URL, waitForForecastGrid } = require('../mmx/src/forecast/forecastScraper');

(async () => {
    const cred = resolveMacromatixCredentialsForStore('3806');
    let browser;
    try {
        ({ browser, page } = await openMacromatixBrowser({ browserOptions: { headless: true } }));
        await ensureSpaAuthenticated(page, cred);
        await page.goto(CHANGE_STORE_URL, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(800);
        await selectStoreOnSpa(page, '3806');
        await page.goto(FORECASTING_URL, { waitUntil: 'load', timeout: 60000 });
        await waitForForecastGrid(page);
        await page.waitForTimeout(3000);
        const info = await page.evaluate(() => {
            const hours = [...document.querySelectorAll('[id^="mx-forecast-grid-interval-directive-list-hour-"]')].map((s) =>
                (s.textContent || '').replace(/\s+/g, ' ').trim()
            );
            const rows = [...document.querySelectorAll('tr.mx-fg-hour')].length;
            const inputs = [...document.querySelectorAll('td.mx-grid-column-input')].length;
            return { hours: hours.slice(0, 40), hourCount: hours.length, rows, inputs };
        });
        console.log(JSON.stringify(info, null, 2));
    } finally {
        await closeBrowserQuietly(browser, 'grid');
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
