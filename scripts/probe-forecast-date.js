#!/usr/bin/env node
/**
 * Headed probe — dump Forecasting/Edit date toolbar DOM for scraper debugging.
 *
 * Usage:
 *   npm run probe-forecast-date
 *   npm run probe-forecast-date -- 3806
 *
 * Writes:
 *   data/forecast-date-probe.json
 *   data/forecast-date-probe.png
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

process.env.FORECAST_SCRAPER_HEADLESS = 'false';

if (!process.env.SCRAPER_EXECUTABLE_PATH && process.platform === 'win32') {
    const candidates = [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (found) process.env.SCRAPER_EXECUTABLE_PATH = found;
}

const { openMacromatixBrowser, closeBrowserQuietly, resolveMacromatixCredentialsForStore } =
    require('../mmx/src/macromatixScraper');
const { ensureSpaAuthenticated, selectStoreOnSpa } = require('../mmx/src/sssg/sssgScraper');
const {
    CHANGE_STORE_URL,
    FORECASTING_URL,
    waitForForecastGrid,
    readDisplayedForecastDate,
    clickForecastDayNav,
} = require('../mmx/src/forecast/forecastScraper');

const OUT_DIR = path.join(__dirname, '../data');
const OUT_JSON = path.join(OUT_DIR, 'forecast-date-probe.json');
const OUT_PNG = path.join(OUT_DIR, 'forecast-date-probe.png');
const SPA_GOTO_OPTS = { waitUntil: 'load', timeout: 60000 };

function elementPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 8) {
        let part = node.tagName.toLowerCase();
        if (node.id) part += `#${node.id}`;
        else if (node.className && typeof node.className === 'string') {
            const cls = node.className.trim().split(/\s+/).slice(0, 2).join('.');
            if (cls) part += `.${cls}`;
        }
        parts.unshift(part);
        node = node.parentElement;
    }
    return parts.join(' > ');
}

async function dumpForecastDateUi(page) {
    return page.evaluate(() => {
        function rect(el) {
            const r = el.getBoundingClientRect();
            return {
                top: Math.round(r.top),
                left: Math.round(r.left),
                width: Math.round(r.width),
                height: Math.round(r.height),
            };
        }

        function attrs(el) {
            const out = {};
            for (const a of el.attributes || []) {
                if (/^(class|id|ng-click|role|aria-|type|name|href|ui-sref|data-)/i.test(a.name)) {
                    out[a.name] = a.value.slice(0, 200);
                }
            }
            return out;
        }

        const datePattern = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
        const dateElements = [];
        for (const el of document.querySelectorAll('span, button, a, div, label, input, td, th')) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            const value = (el.value || '').trim();
            const hit = datePattern.test(text) || datePattern.test(value);
            if (!hit) continue;
            dateElements.push({
                tag: el.tagName,
                text: text.slice(0, 80),
                value: value.slice(0, 40),
                attrs: attrs(el),
                rect: rect(el),
                path: (function path(n) {
                    const parts = [];
                    let node = n;
                    while (node && node.nodeType === 1 && parts.length < 10) {
                        let p = node.tagName.toLowerCase();
                        if (node.id) p += `#${node.id}`;
                        else if (node.className && typeof node.className === 'string') {
                            const c = node.className.trim().split(/\s+/).slice(0, 2).join('.');
                            if (c) p += `.${c}`;
                        }
                        parts.unshift(p);
                        node = node.parentElement;
                    }
                    return parts.join(' > ');
                })(el),
                outerHtml: el.outerHTML.slice(0, 500),
            });
        }

        const inputs = [...document.querySelectorAll('input, textarea, select')].map((el) => ({
            tag: el.tagName,
            attrs: attrs(el),
            value: (el.value || '').slice(0, 60),
            rect: rect(el),
            path: (function path(n) {
                const parts = [];
                let node = n;
                while (node && node.nodeType === 1 && parts.length < 8) {
                    let p = node.tagName.toLowerCase();
                    if (node.id) p += `#${node.id}`;
                    parts.unshift(p);
                    node = node.parentElement;
                }
                return parts.join(' > ');
            })(el),
        }));

        const topClickables = [];
        for (const el of document.querySelectorAll(
            'button, a, [ng-click], [role="button"], md-icon-button, .md-button, i, .glyphicon, .fa, .material-icons'
        )) {
            const r = el.getBoundingClientRect();
            if (r.top > 280 || r.width < 1 || r.height < 1) continue;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
            topClickables.push({
                tag: el.tagName,
                text,
                attrs: attrs(el),
                rect: rect(el),
                path: (function path(n) {
                    const parts = [];
                    let node = n;
                    while (node && node.nodeType === 1 && parts.length < 8) {
                        let p = node.tagName.toLowerCase();
                        if (node.id) p += `#${node.id}`;
                        parts.unshift(p);
                        node = node.parentElement;
                    }
                    return parts.join(' > ');
                })(el),
            });
        }
        topClickables.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);

        const headerSnippet = (() => {
            const host =
                document.querySelector('.mx-page-content') ||
                document.querySelector('[class*="page-content"]') ||
                document.body;
            return host ? host.innerHTML.slice(0, 12000) : '';
        })();

        return {
            url: location.href,
            hash: location.hash,
            title: document.title,
            bodyTextTop: (document.body?.innerText || '').slice(0, 2500),
            dateElements,
            inputs,
            topClickables: topClickables.slice(0, 40),
            headerHtmlSnippet: headerSnippet,
        };
    });
}

async function main() {
    const storeNumber = process.argv[2] || '3806';
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const credentials = resolveMacromatixCredentialsForStore(storeNumber);
    if (!credentials?.username) {
        throw new Error(`No MMX credentials for store ${storeNumber}`);
    }

    let browser;
    let page;
    try {
        console.log(`[probe-forecast-date] Store ${storeNumber} — opening headed browser…`);
        ({ browser, page } = await openMacromatixBrowser({
            browserOptions: { headless: false, skipSlowMo: false },
        }));

        await ensureSpaAuthenticated(page, credentials);
        await page.goto(CHANGE_STORE_URL, SPA_GOTO_OPTS);
        await page.waitForTimeout(800);
        await selectStoreOnSpa(page, storeNumber);

        await page.goto(FORECASTING_URL, SPA_GOTO_OPTS);
        await waitForForecastGrid(page);

        const displayedDate = await readDisplayedForecastDate(page);
        const beforeDump = await dumpForecastDateUi(page);
        await page.screenshot({ path: OUT_PNG, fullPage: false });

        let nextClicked = false;
        let afterNextDate = null;
        let afterNextDump = null;
        try {
            console.log('[probe-forecast-date] Trying next-day click…');
            nextClicked = await clickForecastDayNav(page, 'next');
            await page.waitForTimeout(1200);
            afterNextDate = await readDisplayedForecastDate(page);
            if (nextClicked) afterNextDump = await dumpForecastDateUi(page);
        } catch (err) {
            console.warn('[probe-forecast-date] Next-day click probe failed:', err.message);
        }

        const payload = {
            storeNumber,
            probedAt: new Date().toISOString(),
            displayedDate,
            nextDayClick: { clicked: nextClicked, dateAfter: afterNextDate },
            before: beforeDump,
            afterNext: afterNextDump,
        };

        fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
        console.log(`[probe-forecast-date] Wrote ${OUT_JSON}`);
        console.log(`[probe-forecast-date] Wrote ${OUT_PNG}`);
        console.log(`[probe-forecast-date] Displayed date: ${displayedDate}`);
        console.log(`[probe-forecast-date] Next click: ${nextClicked}, after: ${afterNextDate}`);
        console.log(`[probe-forecast-date] Date elements found: ${beforeDump.dateElements.length}`);
        console.log(`[probe-forecast-date] Top clickables: ${beforeDump.topClickables.length}`);
        console.log('[probe-forecast-date] Browser stays open 20s — inspect the window…');
        await page.waitForTimeout(20000);
    } finally {
        await closeBrowserQuietly(browser, 'probe-forecast-date');
    }
}

main().catch((err) => {
    console.error('[probe-forecast-date] Failed:', err.message);
    process.exit(1);
});
