#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '../.env.production'), override: true });

const { openMacromatixBrowser, closeBrowserQuietly } = require('../src/services/macromatixScraper');

async function main() {
    const reportsUrl =
        'https://tacobellau.macromatix.net/MMS_System_Reports.aspx?MenuCustomItemID=12';
    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({}));
        await page.goto(reportsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000);
        const url = page.url();
        const onLogin = Boolean(await page.$('#Login_UserName'));
        console.log(JSON.stringify({ ok: !onLogin && !/MMS_Logon/i.test(url), url, onLogin }, null, 2));
        process.exit(onLogin || /MMS_Logon/i.test(url) ? 1 : 0);
    } finally {
        await closeBrowserQuietly(browser, 'verify-mmx-session');
    }
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
