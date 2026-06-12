#!/usr/bin/env node
require('../src/loadEnv').loadEnv();
const puppeteer = require('puppeteer');

async function main() {
    const exec = process.env.SCRAPER_EXECUTABLE_PATH || '/usr/bin/chromium';
    const browser = await puppeteer.launch({
        executablePath: exec,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    const url = 'https://tacobellau.macromatix.net/MMS_Logon.aspx?mode=SelectStore';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#Login_UserName', { timeout: 15000 });
    await page.type('#Login_UserName', process.env.SCRAPER_USERNAME, { delay: 0 });
    await page.type('#Login_Password', process.env.SCRAPER_PASSWORD, { delay: 0 });
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
        page.click('input[type="submit"]'),
    ]);
    await page.waitForTimeout(4000);
    const opts = await page.evaluate(() =>
        [...document.querySelectorAll('#ddlStoreSelection option')]
            .map((o) => o.textContent.replace(/\s+/g, ' ').trim())
            .filter((t) => t && !/^select store$/i.test(t) && /\d/.test(t))
    );
    console.log('user:', process.env.SCRAPER_USERNAME);
    console.log('store_count:', opts.length);
    console.log('stores:', opts.join(' | '));
    console.log('has_3756:', opts.some((t) => /\b3756\b/.test(t)));
    await browser.close();
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
