#!/usr/bin/env node
/**
 * Diagnose labour scheduler week dropdown (ddlSchedules) — DOM vs Telerik client API.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

const scraper = require('../mmx/src/macromatixScraper');

const LABOUR_URL =
    'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249';

async function readScheduleComboDebug(page) {
    const comboId = await scraper.findLabourSchedulerComboId?.(page, 'ddlSchedules');
    if (!comboId) {
        const comboId2 = await page.evaluate(() => {
            const input = document.querySelector('input[id*="ddlSchedules"]');
            if (!input) return '';
            const combo = input.closest('.RadComboBox[id]');
            return combo ? combo.id : input.id.replace(/_Input$/, '');
        });
        return readScheduleComboDebugWithId(page, comboId2);
    }
    return readScheduleComboDebugWithId(page, comboId);
}

async function readScheduleComboDebugWithId(page, comboId) {
    if (!comboId) return { comboId: '', error: 'combo not found' };

    const context = await scraper.readLabourSchedulerDayContext(page);

    await page.evaluate((id) => {
        const arrow = document.querySelector(`#${id} .rcbArrowCell, #${id} .rcbArrowCellRight`);
        if (arrow) arrow.click();
    }, comboId);
    await page.waitForTimeout(800);

    const debug = await page.evaluate((id) => {
        const c = typeof window.$find === 'function' ? window.$find(id) : null;
        const clientItems = [];
        if (c && typeof c.get_items === 'function') {
            const list = c.get_items();
            for (let i = 0; i < list.get_count(); i++) {
                clientItems.push((list.getItem(i).get_text() || '').trim());
            }
        }
        const dd = document.getElementById(`${id}_DropDown`) || document;
        const domItems = [];
        dd.querySelectorAll('li.rcbItem').forEach((li) => {
            const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) domItems.push(t);
        });
        const input = document.getElementById(`${id}_Input`);
        return {
            clientCount: clientItems.length,
            clientFirst: clientItems.slice(0, 3),
            clientLast: clientItems.slice(-3),
            domCount: domItems.length,
            domFirst: domItems.slice(0, 3),
            domLast: domItems.slice(-3),
            inputValue: input ? input.value : '',
            hasRequestItems: Boolean(c && typeof c.requestItems === 'function'),
        };
    }, comboId);

    return { comboId, context, ...debug };
}

(async () => {
    const store = process.argv[2] || '3806';
    const credentials = scraper.resolveMacromatixCredentialsForStore(store);
    if (!credentials?.username) throw new Error(`No MMX credentials for store ${store}`);

    let browser;
    try {
        const opened = await scraper.openMacromatixBrowser({
            storeNumber: store,
            mmxUsername: credentials.username,
            mmxPassword: credentials.password,
            launchOptions: { headless: true },
        });
        browser = opened.browser;
        const { page } = opened;
        await page.goto(LABOUR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await scraper.selectStoreOnPage(page, store);
        await scraper.openDayViewAndReadSales(page, false);

        console.log('[probe-weeks] After day view open:');
        console.log(JSON.stringify(await readScheduleComboDebug(page), null, 2));

        console.log('[probe-weeks] Step back 7 days via arrows:');
        for (let i = 0; i < 7; i += 1) {
            const ctx = await scraper.stepLabourSchedulerDay(page, -1);
            const sales = await scraper.readDayViewSalesOnly(page, false);
            const sum = (sales.actual || []).reduce((a, b) => a + (Number(b) || 0), 0);
            console.log(`  step ${i + 1}:`, ctx, 'actualSum', Math.round(sum * 100) / 100);
        }
        console.log('[probe-weeks] OK');
    } finally {
        await scraper.closeBrowserQuietly(browser, 'probe schedule weeks');
    }
})().catch((err) => {
    console.error('[probe-weeks] FAIL', err.message);
    process.exit(1);
});
