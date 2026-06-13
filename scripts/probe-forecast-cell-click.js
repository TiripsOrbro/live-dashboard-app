#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
require('./load-project-env');
const { openMacromatixBrowser, closeBrowserQuietly, resolveMacromatixCredentialsForStore } =
    require('../mmx/src/macromatixScraper');
const { ensureSpaAuthenticated, selectStoreOnSpa } = require('../mmx/src/sssg/sssgScraper');
const { CHANGE_STORE_URL, FORECASTING_URL, waitForForecastGrid } = require('../mmx/src/forecast/forecastScraper');

async function tryClick(page, label) {
    const row = await page.evaluateHandle((wantLabel) => {
        for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
            const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
            const lab = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
            if (lab === wantLabel) return tr;
        }
        return null;
    }, label);
    const rowEl = row.asElement();
    if (!rowEl) throw new Error('no row');
    await rowEl.evaluate((el) => el.scrollIntoView({ block: 'center' }));

    const targets = [
        '[id*="managerforecast"]',
        'td.mx-grid-column-input span',
        'td.mx-grid-column-input',
        'td:last-child',
    ];
    for (const sel of targets) {
        const el = await rowEl.$(sel);
        if (!el) continue;
        await el.click();
        await page.waitForTimeout(600);
        const snap = await page.evaluate(() => {
            const inp = document.querySelector('#overrideInput');
            const r = inp?.getBoundingClientRect();
            const save = [...document.querySelectorAll('button')].find((b) => /^save$/i.test((b.textContent || '').trim()));
            const sr = save?.getBoundingClientRect();
            return {
                sel: null,
                overrideW: r?.width || 0,
                saveW: sr?.width || 0,
                saveNg: save?.getAttribute('ng-click') || null,
            };
        });
        snap.sel = sel;
        console.log(snap);
        if (snap.overrideW > 0) {
            await page.type('#overrideInput', '888', { delay: 20 });
            await page.evaluate(() => document.querySelector('#overrideInput')?.blur());
            await page.waitForTimeout(500);
            const afterType = await page.evaluate(() => {
                const save = [...document.querySelectorAll('button')].find((b) => /^save$/i.test((b.textContent || '').trim()));
                const sr = save?.getBoundingClientRect();
                return { saveW: sr?.width || 0, saveNg: save?.getAttribute('ng-click') };
            });
            console.log('after type', afterType);
            return;
        }
    }
}

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
        await page.waitForTimeout(2000);
        await page.evaluate(() => {
            for (const btn of document.querySelectorAll('#ForecastGridHeader button.mx-panel-button')) {
                if ((btn.textContent || '').trim() === '$' && !btn.classList.contains('btn-success')) btn.click();
            }
        });
        await tryClick(page, '10:00 AM');
    } finally {
        await closeBrowserQuietly(browser, 'click');
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
