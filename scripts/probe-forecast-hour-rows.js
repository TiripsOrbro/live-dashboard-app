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
            const rows = [...document.querySelectorAll('tr.mx-fg-hour')].map((tr) => {
                const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
                const inputCell = tr.querySelector('td.mx-grid-column-input');
                const mgr = tr.querySelector('[id*="managerforecast"]');
                return {
                    label: (labelSpan?.textContent || tr.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
                    hasInputCell: Boolean(inputCell),
                    hasMgr: Boolean(mgr),
                    cellCount: tr.querySelectorAll('td').length,
                };
            });
            return rows;
        });
        console.log(JSON.stringify(info, null, 2));
    } finally {
        await closeBrowserQuietly(browser, 'rows');
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
