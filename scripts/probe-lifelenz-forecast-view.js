#!/usr/bin/env node
/** Dump Day/Week controls and input counts on LifeLenz forecast page. */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');
process.env.LIFELENZ_SCRAPER_HEADLESS = 'false';

const { createAuthenticatedLifeLenzSession, getDevLifeLenzCredentials } = require('../lifelenz/src/lifelenzAuth');
const { selectStoreInLifeLenz, navigateToForecast } = require('../lifelenz/src/lifelenzForecastScraper');

async function dumpViewState(page, label) {
    const info = await page.evaluate(() => {
        const pick = (sel) =>
            [...document.querySelectorAll(sel)].map((el) => ({
                tag: el.tagName,
                text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
                className: (el.className || '').toString().slice(0, 80),
                aria: el.getAttribute('aria-label') || '',
                href: el.getAttribute('href') || '',
                active: el.classList?.contains('active') || el.classList?.contains('is-active'),
            }));
        const inputs = [...document.querySelectorAll('input')].filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        });
        return {
            url: location.href,
            dayLinks: pick('a.calendar-unit-link.day, a[aria-label="Day View"], [aria-label*="Day"]'),
            weekLinks: pick('a.calendar-unit-link.week, a[aria-label="Week View"], [aria-label*="Week"]'),
            calendarUnits: pick('a.calendar-unit-link, button.calendar-unit-link'),
            forecastInputs: inputs
                .filter((el) => /forecast|adjustment/i.test(el.className || '') || /forecast|adjustment/i.test(el.name || ''))
                .map((el) => ({
                    className: (el.className || '').slice(0, 80),
                    name: el.name,
                    value: el.value,
                })),
            visibleInputCount: inputs.length,
            bodySnippet: (document.body?.innerText || '').slice(0, 1200),
        };
    });
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(info, null, 2));
}

async function main() {
    const store = process.argv[2] || '3901';
    const creds = getDevLifeLenzCredentials();
    if (!creds) {
        console.error('Set TempLifeLenzU / TempLifeLenzP in .env');
        process.exit(1);
    }
    const session = await createAuthenticatedLifeLenzSession(creds.email, creds.password, { headless: false });
    await selectStoreInLifeLenz(session.page, store);
    await navigateToForecast(session.page);
    await session.page.waitForTimeout(2000);
    await dumpViewState(session.page, 'After Forecast open (default view)');

    const clicked = await session.page.evaluate(() => {
        for (const el of document.querySelectorAll(
            'a.calendar-unit-link.day, a[aria-label="Day View"], button, a, span'
        )) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!/^day$|^d$/i.test(text) && el.getAttribute('aria-label') !== 'Day View') continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0) continue;
            (el.closest('a, button') || el).click();
            return text || el.getAttribute('aria-label');
        }
        return null;
    });
    console.log('\nClicked Day control:', clicked);
    await session.page.waitForTimeout(3000);
    await dumpViewState(session.page, 'After clicking Day');
    console.log('\nBrowser left open — inspect manually, then close.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
