#!/usr/bin/env node
/**
 * Probe MMX labour scheduler week/day navigation (ddlSchedules, ddlDayList, arrow buttons).
 *
 * Usage:
 *   node scripts/probe-labour-scheduler-day-nav.js [storeNumber]
 *   FORECAST_SCRAPER_HEADLESS=false node scripts/probe-labour-scheduler-day-nav.js 3811
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

const scraper = require('../mmx/src/macromatixScraper');

const LABOUR_URL =
    'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249';

function addDaysToIso(iso, days) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function melbourneTodayIso() {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
    }).format(new Date());
}

async function screenshot(page, label) {
    const dir = path.join(__dirname, '../data/probe-screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `labour-nav-${label}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: false });
    console.log('[probe] screenshot', file);
}

(async () => {
    const store = process.argv[2] || '3811';
    const credentials = scraper.resolveMacromatixCredentialsForStore(store);
    if (!credentials?.username) throw new Error(`No MMX credentials for store ${store}`);

    const headless = !/^(0|false|no)$/i.test(String(process.env.FORECAST_SCRAPER_HEADLESS ?? 'true'));
    let browser;
    try {
        const opened = await scraper.openMacromatixBrowser({
            storeNumber: store,
            mmxUsername: credentials.username,
            mmxPassword: credentials.password,
            launchOptions: { headless },
        });
        browser = opened.browser;
        const { page } = opened;
        await page.goto(LABOUR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await scraper.selectStoreOnPage(page, store);

        console.log('[probe] --- Default day view (today, no week/day change) ---');
        const todaySales = await scraper.openDayViewAndReadSales(page, false);
        const todayCtx = await scraper.readLabourSchedulerDayContext(page);
        console.log('[probe] context', todayCtx);
        console.log('[probe] actual sum', (todaySales.actual || []).reduce((a, b) => a + b, 0));
        await screenshot(page, '01-default-today');

        const today = melbourneTodayIso();
        const fiveWeeksAgo = addDaysToIso(today, -35);
        console.log('[probe] --- Select week ~5 weeks ago', fiveWeeksAgo, '---');
        const weekPicked = await scraper.selectLabourSchedulerWeek(page, fiveWeeksAgo);
        console.log('[probe] week selected', weekPicked);
        await screenshot(page, '02-week-selected');

        console.log('[probe] --- Select specific day', fiveWeeksAgo, '---');
        const dayPicked = await scraper.selectLabourSchedulerDay(page, fiveWeeksAgo);
        console.log('[probe] day selected', dayPicked);
        const histSales = await scraper.readDayViewSalesOnly(page, false);
        console.log('[probe] historical actual sum', (histSales.actual || []).reduce((a, b) => a + b, 0));
        await screenshot(page, '03-day-selected');

        console.log('[probe] --- Step forward one day ---');
        const stepped = await scraper.stepLabourSchedulerDay(page, 1);
        console.log('[probe] after step', stepped);
        const stepSales = await scraper.readDayViewSalesOnly(page, false);
        console.log('[probe] stepped actual sum', (stepSales.actual || []).reduce((a, b) => a + b, 0));
        await screenshot(page, '04-step-forward');

        console.log('[probe] --- scrapeHistoricalDaySales wrapper ---');
        const wrapped = await scraper.scrapeHistoricalDaySales(page, addDaysToIso(today, -7));
        console.log('[probe] wrapped context', wrapped.context);
        console.log('[probe] wrapped actual sum', (wrapped.actual || []).reduce((a, b) => a + b, 0));

        console.log('[probe] OK');
    } finally {
        await scraper.closeBrowserQuietly(browser, 'labour scheduler probe');
    }
})().catch((err) => {
    console.error('[probe] FAIL', err.message);
    process.exit(1);
});
