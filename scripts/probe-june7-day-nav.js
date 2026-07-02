#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

const scraper = require('../mmx/src/macromatixScraper');

const LABOUR_URL =
    'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249';

(async () => {
    const store = process.argv[2] || '3806';
    const creds = scraper.resolveMacromatixCredentialsForStore(store);
    if (!creds?.username) throw new Error(`No MMX credentials for store ${store}`);

    const { browser, page } = await scraper.openMacromatixBrowser({
        storeNumber: store,
        mmxUsername: creds.username,
        mmxPassword: creds.password,
        launchOptions: { headless: true },
    });
    try {
        await page.goto(LABOUR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await scraper.selectStoreOnPage(page, store);

        // Start from June 9 and backfill June 8 + June 7 (week boundary)
        await scraper.openDayViewAndReadSales(page, false);
        await scraper.selectLabourSchedulerWeek(page, '2026-06-09');
        await scraper.selectLabourSchedulerDay(page, '2026-06-09');
        console.log('[probe] Starting from', (await scraper.readLabourSchedulerDayContext(page)).dayText);

        const logs = [];
        const results = await scraper.scrapeMissingHistoricalDays(page, ['2026-06-08', '2026-06-07'], {
            onProgress: (e) => {
                logs.push(e.message);
                console.log('[probe]', e.message);
            },
        });

        for (const row of results) {
            const total = (row.actual || []).reduce((a, b) => a + b, 0);
            console.log('[probe] Got', row.dateIso, '$' + total.toFixed(2));
        }
        const bad = logs.some((m) => /stepping did not align/i.test(m));
        if (bad) throw new Error('Still emitting stepping did not align message');
        if (results.length !== 2) throw new Error(`Expected 2 results, got ${results.length}`);
        if (!results.every((r) => r.dateIso)) throw new Error('Missing dateIso on result');
        console.log('[probe] OK');
    } finally {
        await scraper.closeBrowserQuietly(browser, 'june7 probe');
    }
})().catch((err) => {
    console.error('[probe] FAIL', err.message);
    process.exit(1);
});
