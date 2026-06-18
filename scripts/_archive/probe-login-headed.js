#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const puppeteer = require('puppeteer');
const fs = require('fs');

async function main() {
    const exec =
        process.env.SCRAPER_EXECUTABLE_PATH ||
        (fs.existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe')
            ? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
            : undefined);

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: exec,
        args: ['--no-sandbox', '--start-maximized'],
    });
    const page = await browser.newPage();
    await page.goto('https://tacobellau.macromatix.net/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#Login_UserName', { visible: true, timeout: 15000 });

    await page.evaluate(
        (u, p) => {
            document.querySelector('#Login_UserName').value = u;
            document.querySelector('#Login_Password').value = p;
        },
        process.env.SCRAPER_USERNAME,
        process.env.SCRAPER_PASSWORD
    );

    const btn = await page.$('input[type="submit"]');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
        btn.click(),
    ]);
    await page.waitForTimeout(4000);

    const info = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        hasLoginUser: Boolean(document.querySelector('#Login_UserName')),
        hasStoreDropdown: Boolean(document.querySelector('#ddlStoreSelection')),
        dropdownOptions: [...(document.querySelector('#ddlStoreSelection')?.options || [])]
            .slice(0, 5)
            .map((o) => o.textContent.trim()),
        loginError: (
            document.querySelector('.validation-summary-errors, #FailureText, .failureNotification')?.textContent ||
            ''
        ).trim(),
        bodyStart: (document.body?.innerText || '').slice(0, 600),
    }));

    console.log(JSON.stringify(info, null, 2));
    console.log('\nBrowser stays open 60s - inspect the window.');
    await page.waitForTimeout(60000);
    await browser.close();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
