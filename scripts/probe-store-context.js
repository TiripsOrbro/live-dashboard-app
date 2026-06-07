#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const {
    openMacromatixBrowser,
    closeBrowserQuietly,
    loginPage,
    selectStoreOnLoginDropdown,
    selectStoreOnPage,
} = require('../src/services/macromatixScraper');

const LABOUR_URL =
    'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249';

async function labourContext(page) {
    await page.goto(LABOUR_URL, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(2500);
    return page.evaluate(() => {
        const comboInput = document.querySelector('.RadComboBox[id] input[type="text"]');
        const row = document.querySelector('tr[data-kpi="ActualSalesKpi"]');
        const cells = row ? [...row.querySelectorAll('td')].slice(2, 8).map((c) => c.textContent.trim()) : [];
        return {
            url: location.href,
            combo: (comboInput?.value || comboInput?.textContent || '').trim(),
            salesSample: cells,
        };
    });
}

async function main() {
    const stores = process.argv.slice(2).length ? process.argv.slice(2) : ['3806', '3811'];
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({}));
        for (const storeNumber of stores) {
            await loginPage(page, process.env.SCRAPER_USERNAME, process.env.SCRAPER_PASSWORD);
            const urlAfterLogin = page.url();
            await selectStoreOnLoginDropdown(page, storeNumber);
            const urlAfterSelect = page.url();
            let ctx = await labourContext(page);
            console.log(JSON.stringify({ storeNumber, urlAfterLogin, urlAfterSelect, ...ctx }, null, 2));
            if (!new RegExp(`\\b${storeNumber}\\b`).test(ctx.combo || '')) {
                const picked = await selectStoreOnPage(page, storeNumber);
                console.log('  retried labour selectStoreOnPage:', picked);
                ctx = await labourContext(page);
                console.log('  after retry:', JSON.stringify(ctx, null, 2));
            }
            await page.goto('https://tacobellau.macromatix.net/MMS_Logon.aspx?SignOut=1', {
                waitUntil: 'domcontentloaded',
                timeout: 15000,
            }).catch(() => {});
            await page.waitForTimeout(800);
        }
    } finally {
        await closeBrowserQuietly(browser, 'probe-store-context');
    }
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
