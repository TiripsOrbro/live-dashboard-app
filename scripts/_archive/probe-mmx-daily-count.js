#!/usr/bin/env node
/** Probe Count in Progress panel for Delete button and open count options. */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { openMacromatixBrowser, closeBrowserQuietly } = require('../src/services/macromatixScraper');

const STOCK_COUNT_URL =
    'https://tacobellau.macromatix.net/MMS_Stores_StockCount.aspx?MenuCustomItemID=156';

async function main() {
    const storeNumber = process.argv[2] || '3811';
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({ headless: true, storeNumber }));
        await page.goto(STOCK_COUNT_URL, { waitUntil: 'load', timeout: 45000 });
        await page.waitForTimeout(2000);

        await page.evaluate(() => {
            for (const el of document.querySelectorAll('a, span, li')) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (t === 'count in progress' || t.includes('count in progress')) {
                    el.click();
                    return true;
                }
            }
            return false;
        });
        await page.waitForTimeout(3000);

        const info = await page.evaluate(() => {
            const sel = document.getElementById('ctl00_ph_DropDownListCounts');
            const options = sel
                ? [...sel.options].map((o) => ({
                      v: o.value,
                      t: (o.textContent || '').replace(/\s+/g, ' ').trim(),
                  }))
                : [];
            const buttons = [...document.querySelectorAll('input, button, a')]
                .map((el) => ({
                    tag: el.tagName,
                    type: el.type || '',
                    id: el.id,
                    text: (el.value || el.textContent || '').replace(/\s+/g, ' ').trim(),
                    disabled: el.disabled,
                    visible: el.offsetParent !== null,
                }))
                .filter((b) => b.visible && (/delete|remove/i.test(b.text) || /delete/i.test(b.id)));
            return { options, deleteButtons: buttons };
        });

        console.log(JSON.stringify(info, null, 2));
    } finally {
        await closeBrowserQuietly(browser, 'probe-daily');
    }
}

main().catch(console.error);
