#!/usr/bin/env node
/**
 * Headed UI walkthrough: login → Settings → Forecast tool → WA-1 → store 3901 → next week submit.
 *
 * Usage:
 *   node scripts/probe-forecast-ui-wa3901.js
 *   TEST_BASE_URL=http://localhost:3001 node scripts/probe-forecast-ui-wa3901.js
 *
 * Requires dashboard login in .env:
 *   TempDashboardU=AshOwens          (your .Users username — NOT the MMX tba… login)
 *   TempDashboardP=your-password
 * Optional fallback: TempMMXU / TempMMXP (usually MMX-only — login will fail for the app UI)
 * For visible MMX/LifeLenz browsers during submit, restart the app with
 * FORECAST_SCRAPER_HEADLESS=false and LIFELENZ_SCRAPER_HEADLESS=false in .env.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const USERNAME = String(
    process.env.TempDashboardU || process.argv[4] || process.env.TempMMXU || 'AshOwens'
).trim();
const PASSWORD = String(process.env.TempDashboardP || process.argv[5] || process.env.TempMMXP || '');
const STORE = process.argv[2] || '3901';
const AREA = process.argv[3] || 'WA-1';

function browserExecutable() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean);
    return candidates.find((p) => fs.existsSync(p));
}

function httpLogin(username, password) {
    const url = new URL('/login', BASE);
    const body = JSON.stringify({ username, password, remember: false, mode: 'mic' });
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = lib.request(
            {
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        body: data,
                        cookies: res.headers['set-cookie'] || [],
                    });
                });
            }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function parseCookies(setCookieHeaders, baseUrl) {
    return (setCookieHeaders || []).map((raw) => {
        const [pair, ...attrs] = raw.split(';');
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const cookie = { name, value, url: baseUrl };
        for (const attr of attrs) {
            const [k, v] = attr.trim().split('=');
            if (k.toLowerCase() === 'httponly') cookie.httpOnly = true;
            if (k.toLowerCase() === 'secure') cookie.secure = true;
        }
        return cookie;
    });
}

async function waitForEnabled(page, selector, timeoutMs = 120000) {
    await page.waitForFunction(
        (sel) => {
            const el = document.querySelector(sel);
            return el && !el.disabled && !el.hidden;
        },
        { timeout: timeoutMs },
        selector
    );
}

async function readUiErrors(page) {
    return page.evaluate(() => {
        const pick = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
        return {
            forecastError: pick('#admin-forecast-error'),
            overrideError: pick('#admin-forecast-override-error'),
            previewError: pick('#admin-forecast-preview-error'),
            progressError: pick('#admin-forecast-progress-error'),
            progressTitle: pick('#admin-forecast-progress-title'),
            progressMeta: pick('#admin-forecast-progress-meta'),
        };
    });
}

async function main() {
    if (!USERNAME || !PASSWORD) {
        console.error(
            '[probe-forecast-ui] Set TempDashboardU / TempDashboardP in .env (dashboard .Users login), or pass username password as args 4–5'
        );
        process.exit(1);
    }
    if (/^tba\d/i.test(USERNAME)) {
        console.warn(
            '[probe-forecast-ui] Warning: username looks like a Macromatix store login (tba…), not a dashboard account. Use your .Users username (e.g. AshOwens).'
        );
    }

    const execPath = browserExecutable();
    if (!execPath) {
        console.error('[probe-forecast-ui] No Chrome/Edge found for Puppeteer.');
        process.exit(1);
    }

    console.log(`[probe-forecast-ui] Logging in as ${USERNAME} at ${BASE}…`);

    const { execSync } = require('child_process');
    console.log(`[probe-forecast-ui] Configuring store ${STORE} MMX + LifeLenz logins from .env…`);
    execSync(`node "${path.join(__dirname, 'configure-dev-store-logins.js')}" ${STORE} ${USERNAME}`, {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..'),
    });

    const login = await httpLogin(USERNAME, PASSWORD);
    let loginData = {};
    try {
        loginData = JSON.parse(login.body || '{}');
    } catch {
        /* ignore */
    }
    console.log('[probe-forecast-ui] Login status:', login.status, loginData.error || loginData.success || '');
    if (login.status !== 200 || !loginData.success) {
        console.error(
            '[probe-forecast-ui] Dashboard login failed. TempMMXU/TempMMXP are Macromatix store logins — add TempDashboardU/TempDashboardP with your .Users username and password.'
        );
        process.exit(1);
    }

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: execPath,
        slowMo: 80,
        defaultViewport: { width: 1440, height: 900 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
    });

    const page = await browser.newPage();
    page.on('console', (msg) => {
        const text = msg.text();
        if (/forecast|lifelenz|error|fail/i.test(text)) {
            console.log('[browser]', msg.type(), text.slice(0, 300));
        }
    });
    page.on('pageerror', (err) => console.error('[pageerror]', err.message));

    await page.setCookie(...parseCookies(login.cookies, BASE));

    console.log('[probe-forecast-ui] Opening Settings → Forecast tool…');
    await page.goto(`${BASE}/admin/settings#forecast`, { waitUntil: 'networkidle2', timeout: 120000 });

    await page.waitForSelector('#admin-forecast-area-tabs', { visible: true, timeout: 120000 });
    console.log(`[probe-forecast-ui] Selecting area ${AREA}…`);
    await page.click(`[data-forecast-area="${AREA}"]`);
    await page.waitForTimeout(1500);

    console.log('[probe-forecast-ui] Setting forecast target → Next week…');
    await page.waitForSelector('#admin-forecast-target-scope', { visible: true });
    await page.select('#admin-forecast-target-scope', 'next-week');
    await page.waitForTimeout(800);

    console.log(`[probe-forecast-ui] Opening Submit for store ${STORE}…`);
    const submitSel = `[data-submit-store="${STORE}"]`;
    await page.waitForSelector(submitSel, { visible: true, timeout: 60000 });
    const submitDisabled = await page.$eval(submitSel, (el) => el.disabled);
    if (submitDisabled) {
        const err = await readUiErrors(page);
        console.error('[probe-forecast-ui] Submit button disabled (history not ready?).', err);
        await page.screenshot({ path: 'scripts/probe-forecast-ui-blocked.png', fullPage: true });
        console.log('Screenshot: scripts/probe-forecast-ui-blocked.png');
        console.log('[probe-forecast-ui] Browser left open.');
        return;
    }

    await page.click(submitSel);
    await page.waitForSelector('#admin-forecast-override-submit', { visible: true, timeout: 60000 });
    console.log('[probe-forecast-ui] Override modal open — waiting for Submit forecast…');
    await waitForEnabled(page, '#admin-forecast-override-submit', 120000);
    await page.click('#admin-forecast-override-submit');

    console.log('[probe-forecast-ui] Submit started — watching progress modal…');
    await page.waitForSelector('#admin-forecast-progress-title', { visible: true, timeout: 60000 }).catch(() => null);

    const deadline = Date.now() + 20 * 60 * 1000;
    while (Date.now() < deadline) {
        const state = await page.evaluate(() => {
            const working = document.querySelector('#admin-forecast-progress-working');
            const done = document.querySelector('#admin-forecast-progress-done');
            const closeBtn = document.querySelector('#admin-forecast-progress-close');
            return {
                workingHidden: working?.hidden !== false,
                doneHidden: done?.hidden !== false,
                closeEnabled: closeBtn ? !closeBtn.disabled : false,
                closeLabel: closeBtn?.textContent?.trim() || '',
            };
        });
        const errors = await readUiErrors(page);
        if (errors.progressError || errors.previewError || errors.overrideError) {
            console.error('[probe-forecast-ui] Error surfaced:', errors);
            break;
        }
        if (state.doneHidden === false || (state.workingHidden && state.closeEnabled)) {
            console.log('[probe-forecast-ui] Run finished:', state.closeLabel, errors);
            break;
        }
        if (errors.progressMeta) {
            console.log('[probe-forecast-ui]', errors.progressTitle, '—', errors.progressMeta);
        }
        await page.waitForTimeout(3000);
    }

    await page.screenshot({ path: 'scripts/probe-forecast-ui-final.png', fullPage: true });
    console.log('Screenshot: scripts/probe-forecast-ui-final.png');
    console.log('[probe-forecast-ui] Browser left open — inspect progress/errors, then close manually.');
}

main().catch((err) => {
    console.error('[probe-forecast-ui] Failed:', err.message);
    process.exit(1);
});
