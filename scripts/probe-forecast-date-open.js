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
    isoToMmxDate,
} = require('../mmx/src/forecast/forecastScraper');

async function main() {
    const store = process.argv[2] || '3806';
    const target = process.argv[3] || '2026-06-22';
    const display = isoToMmxDate(target);
    const cred = resolveMacromatixCredentialsForStore(store);
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({ browserOptions: { headless: true } }));
        await ensureSpaAuthenticated(page, cred);
        await page.goto(CHANGE_STORE_URL, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(800);
        await selectStoreOnSpa(page, store);
        await page.goto(FORECASTING_URL, { waitUntil: 'load', timeout: 60000 });
        await waitForForecastGrid(page);

        const before = await readDisplayedForecastDate(page);
        await page.click('#mx-forecast-dateselection-dropdown-edit .mx-date-picker-selected-date');
        await page.waitForTimeout(800);

        const afterOpen = await page.evaluate(() => {
            const visibleInputs = [...document.querySelectorAll('input')]
                .filter((i) => {
                    const r = i.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                })
                .map((i) => ({ id: i.id, type: i.type, value: i.value, className: i.className.slice(0, 80) }));
            const menus = [...document.querySelectorAll('.dropdown-menu, .uib-datepicker-popup, [class*="datepicker"]')]
                .filter((el) => el.getBoundingClientRect().width > 0)
                .map((el) => ({ className: el.className.slice(0, 100), text: el.innerText.slice(0, 200) }));
            return {
                active: `${document.activeElement?.tagName}#${document.activeElement?.id || ''}`,
                visibleInputs,
                menus,
            };
        });
        console.log('before', before);
        console.log('afterOpen', JSON.stringify(afterOpen, null, 2));

        const day = Number(target.split('-')[2]);
        const month = Number(target.split('-')[1]);
        const year = Number(target.split('-')[0]);

        const calInfo = await page.evaluate(() => {
            const popup = document.querySelector('.uib-datepicker-popup');
            if (!popup) return null;
            const title = popup.querySelector('strong, .uib-title, th button')?.textContent?.trim();
            const buttons = [...popup.querySelectorAll('button, td button, td span, td a, td')].slice(0, 40).map((el) => ({
                tag: el.tagName,
                text: (el.textContent || '').trim(),
                className: el.className?.slice?.(0, 60) || '',
            }));
            return { title, buttons };
        });
        console.log('calInfo', JSON.stringify(calInfo, null, 2));

        const picked = await page.evaluate(({ dayNum, monthNum, yearNum }) => {
            const popup = document.querySelector('.uib-datepicker-popup');
            if (!popup) return { ok: false, reason: 'no popup' };
            const want = String(dayNum);
            for (const btn of popup.querySelectorAll('td button, td span.btn, td .btn')) {
                const t = (btn.textContent || '').trim();
                if (t !== want) continue;
                const td = btn.closest('td');
                if (td && (td.classList.contains('text-muted') || td.classList.contains('uib-day') === false)) {
                    /* still try */
                }
                btn.click();
                return { ok: true, clicked: t };
            }
            for (const td of popup.querySelectorAll('td')) {
                const t = (td.textContent || '').trim();
                if (t === want) {
                    const btn = td.querySelector('button, span, a') || td;
                    btn.click();
                    return { ok: true, clicked: t, via: 'td' };
                }
            }
            return { ok: false, reason: 'day not found' };
        }, { dayNum: day, monthNum: month, yearNum: year });
        console.log('picked', picked);
        await page.waitForTimeout(1500);
        const afterPick = await readDisplayedForecastDate(page);
        console.log('afterPick', afterPick, 'wanted', display);
    } finally {
        await closeBrowserQuietly(browser, 'probe-open');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
