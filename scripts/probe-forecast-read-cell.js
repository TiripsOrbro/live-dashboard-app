#!/usr/bin/env node
/** Fill one manager forecast cell and log raw read-back text. */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
require('./load-project-env');
const { openMacromatixBrowser, closeBrowserQuietly, resolveMacromatixCredentialsForStore } =
    require('../mmx/src/macromatixScraper');
const { ensureSpaAuthenticated, selectStoreOnSpa } = require('../mmx/src/sssg/sssgScraper');
const {
    CHANGE_STORE_URL,
    FORECASTING_URL,
    waitForForecastGrid,
    formatHourLabel,
    setForecastPageDate,
    ensureManagerForecastDollarMode,
} = require('../mmx/src/forecast/forecastScraper');

function clickDollarMode(page) {
    return page.evaluate(() => {
        for (const btn of document.querySelectorAll('#ForecastGridHeader button.mx-panel-button')) {
            if ((btn.textContent || '').trim() !== '$') continue;
            if (!btn.classList.contains('btn-success')) btn.click();
            break;
        }
    });
}

const STORE = process.argv[2] || '3811';
const DATE = process.argv[3] || '2026-06-23';
const TEST_HOURS = [10, 11, 12, 13, 14];

(async () => {
    const cred = resolveMacromatixCredentialsForStore(STORE);
    let browser;
    try {
        ({ browser, page } = await openMacromatixBrowser({ browserOptions: { headless: true } }));
        await ensureSpaAuthenticated(page, cred);
        await page.goto(CHANGE_STORE_URL, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(800);
        await selectStoreOnSpa(page, STORE);
        await page.goto(FORECASTING_URL, { waitUntil: 'load', timeout: 60000 });
        await waitForForecastGrid(page);
        await clickDollarMode(page);
        await setForecastPageDate(page, DATE);
        await waitForForecastGrid(page);
        await page.waitForTimeout(500);

        for (const hour of TEST_HOURS) {
            const label = formatHourLabel(hour);
            const testVal = 100 + hour;
            const before = await page.evaluate((wantLabel) => {
                for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
                    const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
                    const rowLabel = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
                    if (rowLabel !== wantLabel) continue;
                    const mgr = tr.querySelector('[id*="managerforecast"]');
                    const inputTd = tr.querySelector('td.mx-grid-column-input');
                    return {
                        mgrText: (mgr?.textContent || '').replace(/\s+/g, ' ').trim(),
                        mgrHtml: mgr?.innerHTML?.slice(0, 200) || null,
                        inputTdText: (inputTd?.textContent || '').replace(/\s+/g, ' ').trim(),
                        rowText: (tr.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
                    };
                }
                return null;
            }, label);

            await page.evaluate((wantLabel) => {
                for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
                    const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
                    const rowLabel = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
                    if (rowLabel !== wantLabel) continue;
                    const cell = tr.querySelector('[id*="managerforecast"]') || tr.querySelector('td.mx-grid-column-input');
                    cell?.click();
                    return;
                }
            }, label);
            await page.waitForSelector('#overrideInput', { visible: true, timeout: 2500 }).catch(() => null);
            await page.evaluate((val) => {
                const el = document.querySelector('#overrideInput');
                if (!el) return;
                el.focus();
                el.value = String(val);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.blur();
            }, testVal);
            await page.waitForTimeout(150);

            const after = await page.evaluate((wantLabel) => {
                for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
                    const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
                    const rowLabel = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
                    if (rowLabel !== wantLabel) continue;
                    const mgr = tr.querySelector('[id*="managerforecast"]');
                    const inputTd = tr.querySelector('td.mx-grid-column-input');
                    const override = document.querySelector('#overrideInput');
                    return {
                        mgrText: (mgr?.textContent || '').replace(/\s+/g, ' ').trim(),
                        inputTdText: (inputTd?.textContent || '').replace(/\s+/g, ' ').trim(),
                        overrideVisible: Boolean(override && override.offsetParent),
                        overrideVal: override?.value || null,
                    };
                }
                return null;
            }, label);

            console.log(JSON.stringify({ label, testVal, before, after }, null, 2));
        }
    } finally {
        await closeBrowserQuietly(browser, 'read-cell');
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
