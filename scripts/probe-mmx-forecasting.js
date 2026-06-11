/* Probe m-tacobellau Forecasting/Edit page for Sales LY row structure. */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

if (!process.env.SCRAPER_EXECUTABLE_PATH && process.platform === 'win32') {
    const candidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) process.env.SCRAPER_EXECUTABLE_PATH = found;
}

const { openMacromatixBrowser, closeBrowserQuietly } = require('../src/services/macromatixScraper');

const MOBILE_BASE = 'https://m-tacobellau.macromatix.net/';
const CHANGE_STORE_URL = `${MOBILE_BASE}#/Administration/ChangeStore?metric=sales`;
const FORECASTING_URL = `${MOBILE_BASE}#/Forecasting/Edit?metric=sales`;

function storeRowButtonSelector(nthChild) {
    return `body > div.fill-height.ng-scope > div > div.app-level-container > div > div > div > div > div.mx-page-content > div > div.mx-grid-body-container.touch-scrollable > table > tbody > tr:nth-child(${nthChild}) > td.mx-grid-column.mx-grid-actions-column.mx-grid-column-min-width.min-50 > button`;
}

async function waitForAngular(page, ms = 4000) {
    await page.waitForTimeout(ms);
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
}

async function selectStoreByIndex(page, index) {
    await page.goto(CHANGE_STORE_URL, { waitUntil: 'load', timeout: 45000 });
    await waitForAngular(page, 4000);
    const sel = storeRowButtonSelector(index);
    await page.waitForSelector(sel, { timeout: 15000 });
    await page.click(sel);
    await waitForAngular(page, 2500);
}

async function readForecastingTable(page) {
    return page.evaluate(() => {
        const table = document.querySelector('table');
        if (!table) return { error: 'no table' };
        const rows = [...table.querySelectorAll('tbody tr, tr')];
        const parsed = [];
        for (const tr of rows) {
            const cells = [...tr.querySelectorAll('td, th')].map((c) =>
                (c.textContent || '').replace(/\s+/g, ' ').trim()
            );
            if (!cells.length) continue;
            const joined = cells.join(' | ');
            if (
                /day total|actual|forecast|last year|sales ly|ly/i.test(joined) ||
                /^\d{1,2}:\d{2}\s*(AM|PM)/i.test(cells[0] || '')
            ) {
                parsed.push({ cells, joined: joined.slice(0, 200) });
            }
        }
        const headerish = parsed.slice(0, 20);
        const dayTotals = parsed.filter((r) => /day total/i.test(r.joined));
        const timeRows = parsed.filter((r) => /^\d{1,2}:\d{2}/i.test(r.cells[0] || ''));
        const sampleTimes = timeRows.slice(0, 6).map((r) => r.cells);
        const labels = [...new Set(parsed.map((r) => r.cells[0]).filter(Boolean))].slice(0, 30);
        return {
            rowCount: rows.length,
            headerish,
            dayTotals,
            sampleTimes,
            labels,
            bodySnippet: (document.body.innerText || '').slice(0, 1500),
        };
    });
}

(async () => {
    let browser;
    try {
        const { browser: b, page } = await openMacromatixBrowser({ launchOptions: { headless: true } });
        browser = b;

        // Store index 4 = 3811 per ChangeStore list
        const storeIndex = Number(process.argv[2] || 4);
        console.log(`Selecting store row ${storeIndex}...`);
        await selectStoreByIndex(page, storeIndex);

        console.log('Opening Forecasting/Edit...');
        await page.goto(FORECASTING_URL, { waitUntil: 'load', timeout: 45000 });
        await waitForAngular(page, 6000);

        const data = await readForecastingTable(page);
        console.log(JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('PROBE FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        await closeBrowserQuietly(browser, 'probe done');
    }
})();
