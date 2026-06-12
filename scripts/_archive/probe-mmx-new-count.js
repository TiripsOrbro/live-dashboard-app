#!/usr/bin/env node
/** Probe New Count → Key Item Count creation flow. */
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
        ({ browser, page } = await openMacromatixBrowser({ headless: true }));
        await page.goto(STOCK_COUNT_URL, { waitUntil: 'load', timeout: 45000 });
        await page.waitForTimeout(2000);

        // Select store via combo
        const comboId = await page.evaluate(() => {
            for (const input of document.querySelectorAll('input[id*="RadComboBoxEntity"]')) {
                if (input.id.endsWith('_Input')) return input.id.replace(/_Input$/, '');
            }
            return null;
        });
        console.log('comboId', comboId);

        if (comboId) {
            await page.click(`#${comboId}_Input`);
            await page.waitForTimeout(500);
            const picked = await page.evaluate(
                ({ id, w }) => {
                    const dd = document.getElementById(`${id}_DropDown`) || document;
                    for (const li of dd.querySelectorAll('li.rcbItem')) {
                        const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
                        if (new RegExp(`(^|\\D)${w}(\\D|$)`).test(t)) {
                            li.click();
                            return t;
                        }
                    }
                    return null;
                },
                { id: comboId, w: storeNumber }
            );
            console.log('store picked', picked);
            await page.waitForTimeout(3000);
        }

        const newCountInfo = await page.evaluate(() => {
            const countType = document.getElementById('ctl00_ph_DropDownListCount');
            const opts = countType
                ? [...countType.options].map((o) => ({ v: o.value, t: o.textContent.trim() }))
                : [];
            const buttons = [...document.querySelectorAll('input, button, a')]
                .map((el) => ({
                    tag: el.tagName,
                    type: el.type,
                    id: el.id,
                    text: (el.value || el.textContent || '').replace(/\s+/g, ' ').trim(),
                }))
                .filter((b) => /create|new|start|apply|save/i.test(b.text))
                .slice(0, 15);
            return { countTypeOpts: opts, buttons };
        });
        console.log(JSON.stringify(newCountInfo, null, 2));
    } finally {
        await closeBrowserQuietly(browser, 'probe-new');
    }
}

main().catch(console.error);
