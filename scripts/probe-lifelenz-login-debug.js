#!/usr/bin/env node
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');
process.env.LIFELENZ_SCRAPER_HEADLESS = 'false';

const puppeteer = require('puppeteer');
const { getLifeLenzLaunchOptions, getDevLifeLenzCredentials } = require('../lifelenz/src/lifelenzAuth');

async function main() {
    const creds = getDevLifeLenzCredentials();
    const browser = await puppeteer.launch(getLifeLenzLaunchOptions({ headless: false, skipSlowMo: false }));
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto('https://admin.lifelenz.com/au01/', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForSelector('#email');
    await page.type('#email', creds.email, { delay: 20 });
    await page.type('#password', creds.password, { delay: 20 });
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => null),
        page.click('button[type="submit"]'),
    ]);
    for (let i = 0; i < 20; i += 1) {
        await page.waitForTimeout(2000);
        const url = page.url();
        const textLen = await page.evaluate(() => (document.body?.innerText || '').length);
        console.log(`wait ${i * 2}s url=${url} textLen=${textLen}`);
        if (textLen > 100 && !url.includes('restore-session')) break;
    }
    const url = page.url();
    const title = await page.title();
    const snippet = await page.evaluate(() => document.body?.innerText?.slice(0, 2000));
    const links = await page.evaluate(() =>
        [...document.querySelectorAll('a, button')].slice(0, 40).map((el) => ({
            tag: el.tagName,
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
            test: el.getAttribute('data-test'),
            au: el.getAttribute('au-target-id'),
            href: el.getAttribute('href'),
        }))
    );
    console.log('URL:', url);
    console.log('Title:', title);
    console.log('Body snippet:\n', snippet);
    console.log('Links/buttons:', JSON.stringify(links, null, 2));
    await page.screenshot({ path: 'scripts/lifelenz-after-login.png', fullPage: true });
    console.log('Screenshot: scripts/lifelenz-after-login.png');
    await browser.close();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
