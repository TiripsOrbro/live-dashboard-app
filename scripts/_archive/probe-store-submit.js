#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const puppeteer = require('puppeteer');
const fs = require('fs');
const { loginPage, closeBrowserQuietly } = require('../src/services/macromatixScraper');

async function main() {
    const exec = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    const browser = await puppeteer.launch({ headless: true, executablePath: exec, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await loginPage(page, process.env.SCRAPER_USERNAME, process.env.SCRAPER_PASSWORD);

    const controls = await page.evaluate(() => {
        const sel = document.querySelector('#ddlStoreSelection');
        return {
            url: location.href,
            formAction: document.querySelector('form')?.action,
            selectOnChange: sel?.getAttribute('onchange') || '',
            inputs: [...document.querySelectorAll('input, button, a, select')].map((el) => ({
                tag: el.tagName,
                type: el.type || '',
                id: el.id || '',
                name: el.name || '',
                value: (el.value || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
            })),
        };
    });
    console.log(JSON.stringify(controls, null, 2));

    // Try selecting 3806 and __doPostBack
    await page.select('#ddlStoreSelection', '1097'); // 3806 Dandenong South value from user HTML
    await page.evaluate(() => {
        const sel = document.querySelector('#ddlStoreSelection');
        if (sel) {
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
    await page.waitForTimeout(500);

    const postChange = await page.evaluate(() => ({
        url: location.href,
        selected: document.querySelector('#ddlStoreSelection')?.selectedOptions?.[0]?.textContent?.trim(),
    }));
    console.log('after change', postChange);

    // Try __doPostBack
    await page.evaluate(() => {
        if (typeof __doPostBack === 'function') {
            __doPostBack('ddlStoreSelection', '');
        }
    });
    await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        page.waitForTimeout(5000),
    ]);
    console.log('after postback', page.url());

    await closeBrowserQuietly(browser, 'probe');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
