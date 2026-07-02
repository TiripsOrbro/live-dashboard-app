const puppeteer = require('puppeteer');

const { getPuppeteerLaunchOptions } = require('../../mmx/src/macromatixScraper');
const { trackBrowser, closeBrowserQuietly } = require('../../mmx/src/browserLifecycle');

const LIFELENZ_ADMIN_URL = 'https://admin.lifelenz.com/au01/';
const LIFELENZ_BUSINESS_EXPLORER_URL = /admin\.lifelenz\.com\/au\d+\/business-explorer/i;
const LOGIN_WAIT_MS = 60000;
const NAV_WAIT_MS = 60000;
const BUSINESS_PICKER_WAIT_MS = 90000;

function resolveLifeLenzHeadless(overrides = {}) {
    if (overrides.headless === false) return false;
    if (overrides.headless === true) return true;
    const raw =
        process.env.LIFELENZ_SCRAPER_HEADLESS ??
        process.env.FORECAST_SCRAPER_HEADLESS ??
        process.env.SCRAPER_HEADLESS;
    if (raw === undefined || raw === '') return true;
    return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function getLifeLenzLaunchOptions(overrides = {}) {
    const headless = resolveLifeLenzHeadless(overrides);
    return getPuppeteerLaunchOptions({ ...overrides, headless, skipSlowMo: overrides.skipSlowMo !== false });
}

function cleanStoreDisplayName(storeNumber, rawName) {
    let name = String(rawName || '').replace(/\s+/g, ' ').trim();
    // LifeLenz glues schedule tokens onto the name, e.g. "South3806Schedule4".
    name = name.replace(new RegExp(`${storeNumber}\\s*schedule\\w*`, 'gi'), '').trim();
    // Trailing trading hours are cosmetic in the picker, e.g. "8:00am - 4:00pm (8hrs)".
    name = name.replace(
        /\s+\d{1,2}(:\d{2})?\s*(am|pm)?\s*-\s*\d{1,2}(:\d{2})?\s*(am|pm)?(\s*\([^)]*\))?/gi,
        ''
    ).trim();
    name = name.replace(new RegExp(`\\b${storeNumber}\\b\\s*$`), '').trim();
    return name.replace(/\s{2,}/g, ' ').trim();
}

function parseStoreLabel(label) {
    const text = String(label || '').replace(/\s+/g, ' ').trim();
    const match = text.match(/^(\d{4})\s*-\s*(.+)$/);
    if (!match) return null;
    const storeNumber = match[1];
    const displayName = cleanStoreDisplayName(storeNumber, match[2]);
    if (!displayName) return null;
    return {
        storeNumber,
        label: `${storeNumber} - ${displayName}`,
        rawLabel: text,
    };
}

function dedupeStores(stores) {
    const seen = new Set();
    const out = [];
    for (const row of stores || []) {
        const key = String(row.storeNumber || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(row);
    }
    out.sort((a, b) => Number(a.storeNumber) - Number(b.storeNumber));
    return out;
}

async function prepareLifeLenzPage(page) {
    await page.setViewport({ width: 1400, height: 900 });
    // LifeLenz admin is an Aurelia SPA - do not use Macromatix resource blocking here.
}

async function waitForSelectorSafe(page, selector, timeout = LOGIN_WAIT_MS) {
    try {
        await page.waitForSelector(selector, { timeout, visible: true });
        return true;
    } catch {
        return false;
    }
}

async function safeEvaluate(page, fn, ...args) {
    try {
        return await page.evaluate(fn, ...args);
    } catch (err) {
        if (/context was destroyed|Execution context|Cannot find context/i.test(err.message || '')) {
            return null;
        }
        throw err;
    }
}

async function isLifeLenzShell(page) {
    const result = await safeEvaluate(page, () =>
        Boolean(document.querySelector('[data-testid="lz-dropdown-trigger-analytics"]'))
    );
    return result === true;
}

async function isOnBusinessExplorer(page) {
    const result = await safeEvaluate(page, () => /business-explorer/i.test(location.href || ''));
    return result === true;
}

async function waitForBusinessExplorerUrl(page, timeoutMs = BUSINESS_PICKER_WAIT_MS) {
    await page.waitForFunction(
        () => /business-explorer/i.test(location.href || ''),
        { timeout: timeoutMs, polling: 500 }
    );
}

/** After login submit - Business Explorer picker or store shell (remembered session). */
async function waitForPostLoginLanding(page, timeoutMs = BUSINESS_PICKER_WAIT_MS) {
    await page.waitForFunction(
        () => {
            const href = location.href || '';
            if (/business-explorer/i.test(href)) return true;
            if (document.querySelector('[data-testid="lz-dropdown-trigger-analytics"]')) return true;
            if (document.querySelector('[data-test="view-business-taco-bell-col"]')) return true;
            return false;
        },
        { timeout: timeoutMs, polling: 500 }
    );
}

async function resolvePostLoginState(page) {
    if (await isLifeLenzShell(page)) return 'shell';
    if (await isOnBusinessExplorer(page)) return 'picker';
    return 'unknown';
}

async function waitForBusinessExplorerTile(page, timeoutMs = BUSINESS_PICKER_WAIT_MS) {
    await page.waitForFunction(
        () => {
            if (document.querySelector('[data-test="view-business-taco-bell-col"]')) return true;
            if (document.querySelector('a[au-target-id="320"]')) return true;
            const bodyText = document.body?.innerText || '';
            return /taco bell\s*-\s*col/i.test(bodyText) && /view/i.test(bodyText);
        },
        { timeout: timeoutMs, polling: 500 }
    );
}

/** Click Taco Bell - COL on /business-explorer (Aurelia click.delegate needs a real click). */
async function selectBusinessOnExplorerPage(page) {
    if (await isLifeLenzShell(page)) return true;

    await waitForBusinessExplorerUrl(page);
    if (await isLifeLenzShell(page)) return true;

    const onExplorer = await isOnBusinessExplorer(page);
    if (!onExplorer) {
        throw new Error('Expected LifeLenz Business Explorer page after login but URL was: ' + (await page.url()));
    }

    await waitForBusinessExplorerTile(page);

    const viewSelectors = [
        '[data-test="view-business-taco-bell-col"]',
        'a[au-target-id="320"]',
    ];

    for (const selector of viewSelectors) {
        const handle = await page.$(selector);
        if (!handle) continue;

        await page.evaluate((sel) => {
            const link = document.querySelector(sel);
            if (!link) return;
            link.scrollIntoView({ block: 'center', inline: 'center' });
            link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            link.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        }, selector);

        try {
            await page.waitForFunction(
                () => Boolean(document.querySelector('[data-testid="lz-dropdown-trigger-analytics"]')),
                { timeout: NAV_WAIT_MS, polling: 500 }
            );
            await page.waitForTimeout(1500);
            return true;
        } catch {
            /* try next selector */
        }
    }

    const clicked = await page.evaluate(() => {
        for (const link of document.querySelectorAll('a.au-target, a.btn, a')) {
            const text = (link.textContent || '').replace(/\s+/g, ' ').trim();
            const test = link.getAttribute('data-test') || '';
            const tileText = link.closest('div, li, section, article')?.innerText || '';
            if (test === 'view-business-taco-bell-col') {
                link.scrollIntoView({ block: 'center', inline: 'center' });
                link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return true;
            }
            if (/^view$/i.test(text) && /taco bell\s*-\s*col/i.test(tileText)) {
                link.scrollIntoView({ block: 'center', inline: 'center' });
                link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return true;
            }
        }
        return false;
    });

    if (!clicked) {
        throw new Error(
            'Could not click Taco Bell - COL on Business Explorer (https://admin.lifelenz.com/au02/business-explorer).'
        );
    }

    await waitForLifeLenzShell(page);
    return true;
}

async function fillLifeLenzLogin(page, email, password) {
    // networkidle2 is unreliable on the Aurelia SPA (background polling can
    // keep the network busy forever); wait for a concrete landing state instead.
    await page.goto(LIFELENZ_ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: LOGIN_WAIT_MS });
    await page
        .waitForFunction(
            () =>
                Boolean(document.querySelector('#email')) ||
                Boolean(document.querySelector('[data-testid="lz-dropdown-trigger-analytics"]')) ||
                /business-explorer/i.test(location.href || ''),
            { timeout: LOGIN_WAIT_MS, polling: 500 }
        )
        .catch(() => null);
    const hasEmail = await waitForSelectorSafe(page, '#email', 8000);
    if (!hasEmail) {
        if (await isLifeLenzShell(page)) return;
        if (await isOnBusinessExplorer(page)) return;
        throw new Error('LifeLenz login page did not load.');
    }
    await page.click('#email', { clickCount: 3 });
    await page.type('#email', String(email || '').trim(), { delay: 20 });
    await page.click('#password', { clickCount: 3 });
    await page.type('#password', String(password || ''), { delay: 20 });
    await page.click('button[type="submit"]');
    await waitForPostLoginLanding(page, LOGIN_WAIT_MS);
}

async function selectTacoBellColBusiness(page) {
    return selectBusinessOnExplorerPage(page);
}

async function waitForLifeLenzShell(page) {
    await page.waitForFunction(
        () => Boolean(document.querySelector('[data-testid="lz-dropdown-trigger-analytics"]')),
        { timeout: NAV_WAIT_MS, polling: 500 }
    );
    await page.waitForTimeout(800);
}

async function readStoreLabelsFromBodyText(page) {
    return page.evaluate(() => {
        const text = document.body?.innerText || '';
        const matches = text.match(/\d{4}\s*-\s*[^\n\r]+/g) || [];
        return [...new Set(matches.map((row) => row.replace(/\s+/g, ' ').trim()))];
    });
}

async function readVisibleStoreOptionLabels(page) {
    return page.evaluate(() => {
        const found = [];
        for (const el of document.querySelectorAll('[role="option"], [role="menuitem"]')) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^\d{4}\s*-\s*\S/.test(text)) found.push(text);
        }
        return found;
    });
}

async function collectStoreLabelsFromOpenDropdown(page) {
    const labels = new Set();

    const addLabels = async () => {
        for (const label of await readVisibleStoreOptionLabels(page)) {
            labels.add(label);
        }
        for (const label of await readStoreLabelsFromBodyText(page)) {
            labels.add(label);
        }
    };

    await addLabels();

    for (let pass = 0; pass < 24; pass += 1) {
        const atEnd = await page.evaluate(() => {
            const container =
                document.querySelector('[role="listbox"]') ||
                document.querySelector('[role="menu"]') ||
                document.querySelector('[data-radix-popper-content-wrapper]') ||
                document.querySelector('[role="option"]')?.closest('ul, div');
            if (!container) return true;
            const before = container.scrollTop;
            container.scrollTop += 320;
            return (
                container.scrollTop === before ||
                container.scrollTop + container.clientHeight >= container.scrollHeight - 2
            );
        });
        await page.waitForTimeout(120);
        await addLabels();
        if (atEnd) break;
    }

    return [...labels];
}

async function extractStoreLabelsFromPage(page) {
    const labels = await page.evaluate(() => {
        const found = [];
        const push = (text) => {
            const t = String(text || '').replace(/\s+/g, ' ').trim();
            if (/^\d{4}\s*-\s*\S/.test(t) && t.length < 120) found.push(t);
        };

        for (const el of document.querySelectorAll('[role="option"], [role="menuitem"]')) {
            push(el.textContent);
        }

        for (const el of document.querySelectorAll('div.max-w-60, div.truncate')) {
            push(el.textContent);
        }

        return [...new Set(found)];
    });

    return dedupeStores(labels.map(parseStoreLabel).filter(Boolean));
}

async function openStoreDropdown(page) {
    const triggers = [
        'button[aria-haspopup="listbox"]',
        'button[aria-haspopup="menu"]',
        '[data-slot="trigger"]',
        'div.max-w-60.min-w-20',
        'div.max-w-60',
    ];
    let bestLabels = [];

    for (const selector of triggers) {
        await page.keyboard.press('Escape').catch(() => null);
        await page.waitForTimeout(200);
        const el = await page.$(selector);
        if (!el) continue;
        await el.click().catch(() => null);
        await page.waitForTimeout(600);
        const labels = await collectStoreLabelsFromOpenDropdown(page);
        if (labels.length > bestLabels.length) bestLabels = labels;
    }

    return bestLabels;
}

async function listAccessibleStores(page) {
    await waitForLifeLenzShell(page);
    const dropdownLabels = await openStoreDropdown(page);
    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(200);

    const fromDropdown = dedupeStores(dropdownLabels.map(parseStoreLabel).filter(Boolean));
    const fromPage = await extractStoreLabelsFromPage(page);
    return dedupeStores([...fromDropdown, ...fromPage]);
}

async function performLifeLenzLogin(page, email, password) {
    await fillLifeLenzLogin(page, email, password);

    const stillOnLogin = await page.$('#email');
    if (stillOnLogin) {
        const loginError = await page
            .evaluate(() => {
                const el = document.querySelector('[role="alert"], .text-danger, .error, p.text-red');
                return el ? String(el.textContent || '').trim() : '';
            })
            .catch(() => '');
        throw new Error(loginError || 'LifeLenz login failed. Check email and password.');
    }

    const postLoginState = await resolvePostLoginState(page);

    if (postLoginState === 'picker') {
        await selectBusinessOnExplorerPage(page);
    } else if (postLoginState === 'unknown' && (await isOnBusinessExplorer(page))) {
        await selectBusinessOnExplorerPage(page);
    } else if (postLoginState !== 'shell' && !(await isLifeLenzShell(page))) {
        throw new Error('LifeLenz login did not reach Business Explorer or store shell.');
    }

    await waitForLifeLenzShell(page);
    return listAccessibleStores(page);
}

async function createAuthenticatedLifeLenzSession(email, password, options = {}) {
    const lifelenzEmail = String(email || '').trim();
    const lifelenzPassword = String(password || '');
    if (!lifelenzEmail || !lifelenzPassword) {
        throw new Error('LifeLenz email and password are required.');
    }

    const browser = await puppeteer.launch(getLifeLenzLaunchOptions(options));
    trackBrowser(browser, 'lifelenz-session');
    const page = await browser.newPage();
    await prepareLifeLenzPage(page);

    // One retry: transient slow renders of the login form or Business Explorer
    // tile are the most common cold-start failure, and login restarts cleanly.
    let stores;
    try {
        stores = await performLifeLenzLogin(page, lifelenzEmail, lifelenzPassword);
    } catch (firstErr) {
        if (/login failed|check email and password/i.test(firstErr.message || '')) {
            await closeBrowserQuietly(browser, 'lifelenz-session');
            throw firstErr;
        }
        console.warn(`[LifeLenz] Login attempt failed (${firstErr.message}); retrying once…`);
        try {
            stores = await performLifeLenzLogin(page, lifelenzEmail, lifelenzPassword);
        } catch (secondErr) {
            await closeBrowserQuietly(browser, 'lifelenz-session');
            throw secondErr;
        }
    }
    return { browser, page, stores };
}

async function verifyLifeLenzLogin(email, password, options = {}) {
    const lifelenzEmail = String(email || '').trim();
    const lifelenzPassword = String(password || '');
    if (!lifelenzEmail || !lifelenzPassword) {
        return { ok: false, error: 'LifeLenz email and password are required.' };
    }

    let browser;
    try {
        browser = await puppeteer.launch(
            getLifeLenzLaunchOptions({ headless: true, skipSlowMo: true, ...options })
        );
        trackBrowser(browser, 'lifelenz-login-verify');
        const page = await browser.newPage();
        await prepareLifeLenzPage(page);
        const stores = await performLifeLenzLogin(page, lifelenzEmail, lifelenzPassword);
        if (!stores.length) {
            return { ok: false, error: 'Login succeeded but no stores were found in LifeLenz.' };
        }
        return { ok: true, stores };
    } catch (err) {
        return { ok: false, error: err.message || 'Could not reach LifeLenz.' };
    } finally {
        if (!options.keepBrowserOpen) {
            await closeBrowserQuietly(browser, 'lifelenz-login-verify');
        }
    }
}

function getDevLifeLenzCredentials() {
    const email = String(process.env.TempLifeLenzU || '').trim();
    const password = String(process.env.TempLifeLenzP || '');
    if (!email || !password) return null;
    return { email, password };
}

module.exports = {
    LIFELENZ_ADMIN_URL,
    parseStoreLabel,
    cleanStoreDisplayName,
    dedupeStores,
    getLifeLenzLaunchOptions,
    verifyLifeLenzLogin,
    createAuthenticatedLifeLenzSession,
    performLifeLenzLogin,
    listAccessibleStores,
    selectTacoBellColBusiness,
    selectBusinessOnExplorerPage,
    waitForBusinessExplorerUrl,
    getDevLifeLenzCredentials,
};
