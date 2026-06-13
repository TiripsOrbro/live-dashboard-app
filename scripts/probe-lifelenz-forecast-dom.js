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
} = require('../lifelenz/src/lifelenzForecastScraper');

async function main() {
    const store = process.argv[2] || '3806';
    const date = process.argv[3] || '2026-06-22';
    const creds = getDevLifeLenzCredentials();
    const session = await createAuthenticatedLifeLenzSession(creds.email, creds.password, { headless: false });
    await selectStoreInLifeLenz(session.page, store);
    await navigateToForecast(session.page);
    await switchToDayView(session.page);
    await setForecastDate(session.page, date);
    await session.page.waitForTimeout(3000);

    const info = await session.page.evaluate(() => {
        const inputs = [...document.querySelectorAll('input')].map((el, i) => ({
            i,
            type: el.type,
            id: el.id,
            name: el.name,
            placeholder: el.placeholder,
            value: el.value,
            className: el.className?.slice?.(0, 80),
            parentText: (el.closest('tr, li, div')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            visible: el.getBoundingClientRect().width > 0,
        }));
        const text = (document.body?.innerText || '').slice(0, 3000);
        return { url: location.href, inputCount: inputs.length, inputs, textSnippet: text };
    });
    console.log(JSON.stringify(info, null, 2));
    await session.page.screenshot({ path: 'scripts/lifelenz-forecast-day.png', fullPage: true });
    console.log('Screenshot: scripts/lifelenz-forecast-day.png');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
