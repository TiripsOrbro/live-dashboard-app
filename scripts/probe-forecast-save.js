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
    fillForecastHourlyInputs,
    clickForecastSave,
} = require('../mmx/src/forecast/forecastScraper');

function listButtons(page) {
    return page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]')) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            out.push({
                tag: el.tagName,
                id: el.id || null,
                text: (el.textContent || el.value || '').replace(/\s+/g, ' ').trim(),
                className: (el.className || '').slice(0, 80),
                ngClick: el.getAttribute('ng-click') || null,
            });
        }
        return out;
    });
}

async function main() {
    const store = process.argv[2] || '3806';
    const confirm = process.argv.includes('--confirm');
    if (!confirm && !/^(1|true|yes)$/i.test(String(process.env.PROBE_FORECAST_SAVE_CONFIRM || '').trim())) {
        console.error(
            '[probe-forecast-save] Refusing to write test forecast ($8888/hr) to Macromatix without confirmation.'
        );
        console.error('Re-run with --confirm or set PROBE_FORECAST_SAVE_CONFIRM=1 if you really mean it.');
        process.exit(1);
    }
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
        await page.waitForTimeout(2000);

        const hourly = [];
        for (let h = 10; h <= 22; h += 1) hourly.push({ hour: h, forecast: 8888 });
        const t0 = Date.now();
        const fill = await fillForecastHourlyInputs(page, hourly);
        const fillMs = Date.now() - t0;
        console.log('fill', fill, `(${fillMs}ms)`);
        const buttons = await listButtons(page);
        console.log('buttons after fill', buttons.filter((b) => /save|cancel/i.test(b.text)).slice(0, 5));
        const t1 = Date.now();
        const savedAs = await clickForecastSave(page);
        console.log('savedAs', savedAs, `(${(Date.now() - t1)}ms)`);
    } finally {
        await closeBrowserQuietly(browser, 'probe-save');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
