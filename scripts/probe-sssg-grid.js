#!/usr/bin/env node
/**
 * Probe Macromatix SPA Forecasting grid — dump Last Year row indices, labels, and parsed slots.
 *
 * Usage:
 *   npm run probe-sssg-grid
 *   npm run probe-sssg-grid -- 3806
 *
 * Run headed: SCRAPER_HEADLESS=false npm run probe-sssg-grid
 */
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
const {
    ensureSpaAuthenticated,
    selectStoreOnSpa,
    readLastYearForecastGrid,
    listStoresOnChangeStorePage,
} = require('../src/services/sssg/sssgScraper');
const { parseLastYearGridRows, classifyGridRow } = require('../src/services/sssg/sssgGridParser');

const OUT_DIR = path.join(__dirname, '../data/sssg');
const OUT_FILE = path.join(OUT_DIR, 'grid-debug.json');

async function main() {
    const storeNumber = process.argv[2] || '3806';
    let browser;
    let page;

    try {
        ({ browser, page } = await openMacromatixBrowser({ browserOptions: { headless: false } }));
        await ensureSpaAuthenticated(page, {});

        const listed = await listStoresOnChangeStorePage(page);
        console.log('[probe-sssg] Stores on Change Store page:', listed.map((s) => s.storeNumber).join(', '));

        await selectStoreOnSpa(page, storeNumber);
        const rawRows = await readLastYearForecastGrid(page);
        const slots = parseLastYearGridRows(rawRows);

        const sorted = [...rawRows].sort((a, b) => a.rowIndex - b.rowIndex);
        const classified = sorted.map((row, i) => ({
            ...row,
            classification: classifyGridRow(row, sorted[i + 1], sorted[i - 1]),
        }));

        const payload = {
            storeNumber,
            probedAt: new Date().toISOString(),
            rawRowCount: rawRows.length,
            slotCount: slots.length,
            rawRows: classified,
            slots,
        };

        fs.mkdirSync(OUT_DIR, { recursive: true });
        fs.writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

        console.log(`[probe-sssg] Wrote ${OUT_FILE}`);
        console.log(`[probe-sssg] ${rawRows.length} raw rows → ${slots.length} quarter-hour slots`);
        if (slots.length) {
            console.log('[probe-sssg] First slot:', slots[0]);
            console.log('[probe-sssg] Last slot:', slots[slots.length - 1]);
        }
    } finally {
        await closeBrowserQuietly(browser, 'probe-sssg-grid');
    }
}

main().catch((err) => {
    console.error('[probe-sssg] Failed:', err.message);
    process.exit(1);
});
