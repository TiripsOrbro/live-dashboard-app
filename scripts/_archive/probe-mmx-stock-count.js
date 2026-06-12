#!/usr/bin/env node
/** Probe Macromatix Stock Count / Key Item Count page structure. */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { openMacromatixBrowser, closeBrowserQuietly } = require('../src/services/macromatixScraper');

const STOCK_COUNT_URL =
    process.env.MMX_STOCK_COUNT_URL ||
    'https://tacobellau.macromatix.net/MMS_Stores_StockCount.aspx?MenuCustomItemID=156';

async function main() {
    const storeNumber = process.argv[2] || '3811';
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({ headless: false }));
        await page.goto(STOCK_COUNT_URL, { waitUntil: 'load', timeout: 45000 });
        await page.waitForTimeout(3000);

        const info = await page.evaluate(() => {
            const tabs = [...document.querySelectorAll('.rtsLink, .rtsTxt, li.rtsLI')]
                .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean);
            const locationTabs = [...document.querySelectorAll('a, span, li, button')]
                .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
                .filter((t) =>
                    /^(freezer|carry over|fridge|on floor|dry|soft drinks|count as 0)$/i.test(t)
                );

            const inputs = [...document.querySelectorAll('input[type="text"]:not([type="hidden"])')]
                .slice(0, 30)
                .map((inp) => ({
                    id: inp.id,
                    name: inp.name,
                    value: inp.value,
                    ctx: (inp.closest('tr')?.innerText || inp.parentElement?.innerText || '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, 120),
                }));

            const selects = [...document.querySelectorAll('select')]
                .slice(0, 8)
                .map((sel) => ({
                    id: sel.id,
                    opts: [...sel.options].slice(0, 5).map((o) => o.textContent.trim()),
                }));

            const saveButtons = [...document.querySelectorAll('input, button, a')]
                .map((el) => (el.value || el.textContent || '').replace(/\s+/g, ' ').trim())
                .filter((t) => /save|apply|update|submit/i.test(t))
                .slice(0, 20);

            const gridSample = [];
            for (const table of document.querySelectorAll('table')) {
                const txt = (table.innerText || '').slice(0, 200);
                if (/item|carton|bag|code|39520|40303/i.test(txt)) {
                    gridSample.push(txt.replace(/\s+/g, ' ').slice(0, 300));
                }
            }

            return {
                title: document.title,
                tabs: [...new Set(tabs)].slice(0, 20),
                locationTabs: [...new Set(locationTabs)],
                inputs,
                selects,
                saveButtons: [...new Set(saveButtons)],
                gridSample: gridSample.slice(0, 5),
                bodySnippet: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
            };
        });

        console.log(JSON.stringify(info, null, 2));
        await page.screenshot({ path: path.join(__dirname, 'probe-stock-count.png'), fullPage: true });
        console.log('Screenshot: scripts/probe-stock-count.png');
    } finally {
        await closeBrowserQuietly(browser, 'probe');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
