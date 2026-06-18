const crypto = require('crypto');
const fs = require('fs');
const puppeteer = require('puppeteer');
const {
    throwIfSalesScrapeAborted,
    isSalesScrapeAbortRequested,
    MmxWorkAbortedError,
} = require('../../src/services/salesScrapeAbort');
const { getStoreList, getStoreConfig, DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR } = require('../../stores/src/storeList');
const { getStoreScrapePhase, formatScrapeWindow } = require('../../src/services/scrapeSchedule');

const BASE_URL = 'https://tacobellau.macromatix.net/';
const LABOUR_URL = 'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249';
const SCHEDULED_ORDERS_URL = 'https://tacobellau.macromatix.net/mms_stores_scheduledorders.aspx';

/** `networkidle2` often never resolves on Macromatix (long-polling / beacons). */
const GOTO_OPTS = { waitUntil: 'load', timeout: 45000 };
const DASHBOARD_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const CONFIRMED_EMPTY_ORDER_CHECKS = Number(process.env.CONFIRMED_EMPTY_ORDER_CHECKS || 2);

/* Per-store state keyed by store number (e.g. "3811"). A multi-store account scrapes each store in turn. */
const forecastCacheByStore = new Map();
const scheduledOrdersCompleteByStore = new Map();
const scheduledOrdersEmptyCheckByStore = new Map();
const lastKnownPendingVendorsByStore = new Map();

const DEFAULT_STORE_KEY = '__default__';

/** Thrown when the Macromatix login cannot access a store - scrape should skip, not error. */
class StoreInaccessibleError extends Error {
    constructor(storeNumber, detail) {
        super(`Store ${storeNumber} not accessible with this Macromatix login${detail ? `: ${detail}` : ''}`);
        this.name = 'StoreInaccessibleError';
        this.storeNumber = String(storeNumber || '').trim();
        this.skippable = true;
    }
}

function isStoreInaccessibleError(err) {
    return Boolean(err && (err instanceof StoreInaccessibleError || err.skippable === true));
}

function summarizeInaccessibleStores(stores, results) {
    const skipped = [];
    for (let i = 0; i < stores.length; i++) {
        if (results[i] === null) {
            skipped.push(String(stores[i].storeNumber || '').trim() || '(default)');
        }
    }
    if (!skipped.length) return;
    skipped.sort();
    console.log(
        `[Macromatix] Skipped ${skipped.length} store(s) not on this Macromatix login: ${skipped.join(', ')}`
    );
}

function dashboardDateKey(d = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: DASHBOARD_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(d);
    const get = (type) => parts.find((part) => part.type === type)?.value;
    const yyyy = get('year');
    const mm = get('month');
    const dd = get('day');
    return `${yyyy}-${mm}-${dd}`;
}

function storeStateKey(storeNumber) {
    const s = String(storeNumber || '').trim();
    return s || DEFAULT_STORE_KEY;
}

function getCachedForecastForToday(storeNumber, dateKey) {
    const entry = forecastCacheByStore.get(storeStateKey(storeNumber));
    return entry && entry.dateKey === dateKey && Array.isArray(entry.values) ? entry.values : null;
}

function setCachedForecast(storeNumber, dateKey, values) {
    forecastCacheByStore.set(storeStateKey(storeNumber), { dateKey, values });
}

function warnIfSuspiciousForecast(storeNumber, forecast) {
    const values = (Array.isArray(forecast) ? forecast : [])
        .map((v) => Number(v) || 0)
        .filter((v) => v > 0);
    if (values.length < 3) return;
    const first = values[0];
    if (first >= 5000 && values.every((v) => v === first)) {
        console.warn(
            `[Macromatix] Store ${storeNumber}: uniform forecast $${first}/hr on ${values.length} hours - likely test data in Macromatix (check Forecasting/Edit for today)`
        );
    }
}

/** Per scrape batch: store numbers each Macromatix login can reach (login picker ∪ labour ∪ SPA). */
const accessibleStoresByCredential = new Map();
const accessibleStoresDiscoveryInFlight = new Map();

function credentialCacheKey(credentials) {
    return `${String(credentials?.username || '').trim()}\0${String(credentials?.password || '')}`;
}

function normalizeStoreNumberKey(storeNumber) {
    return String(storeNumber || '').trim().replace(/\D/g, '');
}

function clearAccessibleStoresDiscoveryCache() {
    accessibleStoresByCredential.clear();
    accessibleStoresDiscoveryInFlight.clear();
}

function addAccessibleStoreNumber(set, storeNumber) {
    const key = normalizeStoreNumberKey(storeNumber);
    if (key) set.add(key);
}

async function collectAccessibleStoreNumbersFromSession(page, credentials) {
    const nums = new Set();

    if (await isLoginStorePickerPresent(page)) {
        await waitForLoginStoreDropdownStable(page);
        for (const row of await listStoresOnLoginDropdown(page)) {
            addAccessibleStoreNumber(nums, row.storeNumber);
        }
    }

    try {
        if (!/LabourScheduler/i.test(page.url() || '')) {
            await page.goto(LABOUR_URL, GOTO_OPTS);
            await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(800);
        }
        await assertMacromatixAuthenticated(page, 'Store discovery');
        for (const row of await enumerateStores(page)) {
            addAccessibleStoreNumber(nums, row.storeNumber);
        }
    } catch {
        /* ignore */
    }

    try {
        const {
            CHANGE_STORE_URL,
            ensureSpaAuthenticated,
            listStoresOnChangeStorePage,
        } = require('./sssg/sssgScraper');
        await page.goto(CHANGE_STORE_URL, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(800);
        await ensureSpaAuthenticated(page, credentials);
        for (const row of await listStoresOnChangeStorePage(page)) {
            addAccessibleStoreNumber(nums, row.storeNumber);
        }
    } catch {
        /* ignore */
    }

    return nums.size ? nums : null;
}

async function discoverAccessibleStoreNumbersForCredentials(browser, credentials) {
    let context;
    let page;
    try {
        context = await createIsolatedContext(browser);
        page = await context.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await applyResourceBlocking(page);
        await loginPage(page, credentials.username, credentials.password);
        return await collectAccessibleStoreNumbersFromSession(page, credentials);
    } finally {
        if (page) {
            try {
                await logoutPage(page);
            } catch {
                /* ignore */
            }
        }
        if (context) {
            try {
                await context.close();
            } catch {
                /* ignore */
            }
        }
    }
}

async function getAccessibleStoreNumbersForCredentials(browser, credentials) {
    const key = credentialCacheKey(credentials);
    if (accessibleStoresByCredential.has(key)) {
        return accessibleStoresByCredential.get(key);
    }
    if (accessibleStoresDiscoveryInFlight.has(key)) {
        return accessibleStoresDiscoveryInFlight.get(key);
    }
    const promise = discoverAccessibleStoreNumbersForCredentials(browser, credentials)
        .then((nums) => {
            accessibleStoresByCredential.set(key, nums);
            return nums;
        })
        .catch((err) => {
            console.warn('[Macromatix] Could not enumerate accessible stores:', err.message);
            accessibleStoresByCredential.set(key, null);
            return null;
        })
        .finally(() => {
            accessibleStoresDiscoveryInFlight.delete(key);
        });
    accessibleStoresDiscoveryInFlight.set(key, promise);
    return promise;
}

function buildStoreInaccessibleMessage(storeNumber, accessibleNums) {
    const nums = accessibleNums ? [...accessibleNums].sort() : [];
    return nums.length
        ? `Store ${storeNumber} not accessible with this Macromatix login (accessible: ${nums.join(', ')})`
        : `Store ${storeNumber} not accessible with this Macromatix login`;
}

function getConfirmedEmptyOrderChecks() {
    return Number.isFinite(CONFIRMED_EMPTY_ORDER_CHECKS) && CONFIRMED_EMPTY_ORDER_CHECKS > 0
        ? Math.floor(CONFIRMED_EMPTY_ORDER_CHECKS)
        : 2;
}

function getLastKnownPendingVendors(storeNumber, dateKey) {
    const entry = lastKnownPendingVendorsByStore.get(storeStateKey(storeNumber));
    return entry && entry.dateKey === dateKey ? entry.values : [];
}

function isScheduledOrdersCompleteToday(storeNumber, dateKey) {
    return scheduledOrdersCompleteByStore.get(storeStateKey(storeNumber)) === dateKey;
}

function recordScheduledOrdersResult(storeNumber, dateKey, vendors) {
    const key = storeStateKey(storeNumber);
    lastKnownPendingVendorsByStore.set(key, { dateKey, values: vendors });

    if (vendors.length > 0) {
        scheduledOrdersEmptyCheckByStore.set(key, { dateKey, count: 0 });
        scheduledOrdersCompleteByStore.delete(key);
        return;
    }

    const prev = scheduledOrdersEmptyCheckByStore.get(key);
    const nextCount = prev && prev.dateKey === dateKey ? prev.count + 1 : 1;
    scheduledOrdersEmptyCheckByStore.set(key, { dateKey, count: nextCount });

    if (nextCount >= getConfirmedEmptyOrderChecks()) {
        const alreadyComplete = scheduledOrdersCompleteByStore.get(key) === dateKey;
        scheduledOrdersCompleteByStore.set(key, dateKey);
        if (!alreadyComplete) {
            notifyStoreOrdersComplete(storeNumber, dateKey);
        }
    }
}

function clearStoreOrderCaches(storeNumber, dateKey) {
    const key = storeStateKey(storeNumber);
    lastKnownPendingVendorsByStore.set(key, { dateKey, values: [] });
    scheduledOrdersEmptyCheckByStore.delete(key);
}

function clearStoreScrapeCaches(storeNumber) {
    const key = storeStateKey(storeNumber);
    forecastCacheByStore.delete(key);
    lastKnownPendingVendorsByStore.delete(key);
    scheduledOrdersEmptyCheckByStore.delete(key);
    scheduledOrdersCompleteByStore.delete(key);
    try {
        require('../../dashboard/src/sssg/sssgCache').clearSssgLyCache(storeNumber);
    } catch {
        /* ignore */
    }
}

function resetScheduledOrdersForNewDay(storeNumber) {
    const key = storeStateKey(storeNumber);
    scheduledOrdersCompleteByStore.delete(key);
    scheduledOrdersEmptyCheckByStore.delete(key);
    lastKnownPendingVendorsByStore.delete(key);
}

let storeOrdersCompleteListener = null;

function onStoreOrdersComplete(listener) {
    storeOrdersCompleteListener = typeof listener === 'function' ? listener : null;
}

function notifyStoreOrdersComplete(storeNumber, dateKey) {
    clearStoreOrderCaches(storeNumber, dateKey);
    const { runStoreOrdersCompleteCleanup } = require('../../vendors/src/storeOrdersCompleteCleanup');
    runStoreOrdersCompleteCleanup(storeNumber, dateKey)
        .then((summary) => {
            if (storeOrdersCompleteListener) {
                try {
                    storeOrdersCompleteListener(storeNumber, dateKey, summary);
                } catch (err) {
                    console.warn('[Macromatix] storeOrdersComplete listener failed:', err.message);
                }
            }
        })
        .catch((err) => {
            console.warn(`[Macromatix] Store ${storeNumber} orders-complete cleanup failed:`, err.message);
        });
}

async function closeBrowserQuietly(browser, label) {
    if (!browser) return;
    try {
        await browser.close();
    } catch (error) {
        console.warn(`[Macromatix] Browser close failed during ${label}:`, error.message);
    }
}

/*
 * Scheduled-orders date picker: advance N days from today (default was 2) via RadCalendar + postback.
 * Disabled - Macromatix default date on the page is enough for now.
 * To re-test / re-enable: uncomment the constant and the `withPageContextRetry(... setScheduledOrdersDateOffset ...)`
 * block in `scrapePendingVendors`. Optional env: SCRAPER_SCHEDULED_ORDERS_DAY_OFFSET (0 = today).
 * For arbitrary calendar dates, the dashboard calls `/api/sales?testScheduledOrdersDate=YYYY-MM-DD` when the
 * request is dashboard-authenticated (cookie) or `DASHBOARD_ENABLE_ORDER_DATE_TEST=1` is set (uses `setScheduledOrdersToYmd`).
 */
// const SCHEDULED_ORDERS_DAY_OFFSET = Number(process.env.SCRAPER_SCHEDULED_ORDERS_DAY_OFFSET ?? 2);

const MONTH_LONG_EN = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];

/** Parse "May 2026" from RadCalendar `.rcTitle` text */
function parseRadCalendarTitle(title) {
    const m = String(title || '').match(
        /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i
    );
    if (!m) return null;
    const idx = MONTH_LONG_EN.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
    if (idx < 0) return null;
    return { monthIndex: idx, year: parseInt(m[2], 10) };
}

/** After changing date, trigger ASP.NET postback so the grid reloads (set 0/false if it hangs). */
const SCHEDULED_DATE_POSTBACK = !/^(0|false|no|off)$/i.test(
    String(process.env.SCRAPER_SCHEDULED_DATE_POSTBACK ?? 'true').trim()
);

/** Visible RadDatePicker: click calendar icon, step months, click day (typing the box often does nothing). */
async function pickDateViaRadCalendarUI(page, year, monthIndex, day) {
    const triggerSelectors = [
        '[id$="_DatePicker_wrapper"] a.rcCalPopup',
        '[id$="_DatePicker_wrapper"] a[class*="CalPopup"]',
        '[id$="_DatePicker_wrapper"] .rcCalPopup',
        '[id$="_DatePicker_wrapper"] input.rcCalPopup',
    ];
    let trigger = null;
    for (const sel of triggerSelectors) {
        trigger = await page.$(sel);
        if (trigger) break;
    }
    if (!trigger) {
        console.warn('[Macromatix] Date picker calendar trigger not found (rcCalPopup / CalPopup)');
        return false;
    }
    await trigger.click();
    await page.waitForTimeout(280);
    await page
        .waitForSelector('div.RadCalendarPopup table.RadCalendar, body > table.RadCalendar', {
            visible: true,
            timeout: 12000,
        })
        .catch(() => null);
    await page.waitForTimeout(120);

    const titleSel = 'div.RadCalendarPopup .rcTitle, div.RadCalendarPopup td.rcTitle, table.RadCalendar .rcTitle';
    const nextSel =
        'div.RadCalendarPopup a.rcFastNext, div.RadCalendarPopup a.rcNext, table.RadCalendar a.rcFastNext, table.RadCalendar a.rcNext';
    const prevSel =
        'div.RadCalendarPopup a.rcFastPrev, div.RadCalendarPopup a.rcPrev, table.RadCalendar a.rcFastPrev, table.RadCalendar a.rcPrev';

    for (let step = 0; step < 30; step++) {
        const curTitle = await page
            .evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? el.textContent.trim() : '';
            }, titleSel)
            .catch(() => '');
        const parsed = parseRadCalendarTitle(curTitle);
        if (parsed && parsed.year === year && parsed.monthIndex === monthIndex) break;
        if (!parsed) {
            console.warn('[Macromatix] RadCalendar title not parsed:', JSON.stringify(curTitle));
            break;
        }
        const targetKey = year * 12 + monthIndex;
        const curKey = parsed.year * 12 + parsed.monthIndex;
        const navSel = curKey < targetKey ? nextSel : prevSel;
        const nav = await page.$(navSel);
        if (!nav) break;
        await nav.click();
        await page.waitForTimeout(220);
    }

    const picked = await page.evaluate((dayNum) => {
        const root = document.querySelector('div.RadCalendarPopup') || document.body;
        const cal = root.querySelector('table.RadCalendar');
        if (!cal) return false;
        const want = String(dayNum);
        for (const td of cal.querySelectorAll('td')) {
            if (td.classList.contains('rcOtherMonth')) continue;
            const a = td.querySelector(':scope > a');
            if (a && a.textContent.trim() === want) {
                a.click();
                return true;
            }
        }
        return false;
    }, day);

    if (!picked) {
        console.warn('[Macromatix] Could not click RadCalendar day', day, 'for', year, MONTH_LONG_EN[monthIndex]);
        await page.keyboard.press('Escape').catch(() => {});
        return false;
    }
    /* Day click often fires a full postback - wait for load before any further CDP ops or context is destroyed. */
    await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
        page.waitForTimeout(1200),
    ]);
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(80);
    return true;
}

/**
 * Sys.WebForms `__doPostBack` uses patterns that break under Puppeteer's strict `evaluate` wrapper.
 * Run it from a dynamically inserted classic &lt;script&gt; (sloppy global execution).
 */
async function triggerDoPostBackSloppy(page, eventTarget) {
    if (typeof eventTarget !== 'string' || !eventTarget) return;
    await page.evaluate((t) => {
        const s = document.createElement('script');
        s.textContent = '__doPostBack(' + JSON.stringify(t) + ', "");';
        const root = document.body || document.documentElement;
        root.appendChild(s);
        s.remove();
    }, eventTarget);
}

/** Enter on the date box + click elsewhere to blur - same cues Macromatix often needs before the grid reloads. */
async function commitScheduledOrdersDateUi(page) {
    const run = async () => {
        const inp = await page.$('[id$="_DatePicker_dateInput"]');
        if (inp) {
            await inp.focus();
            await page.waitForTimeout(80);
            await inp.click();
            await page.waitForTimeout(100);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(250);
        }
        const form = await page.$('form#aspnetForm, form[name="aspnetForm"]');
        if (form) {
            const box = await form.boundingBox();
            if (box && box.width > 0 && box.height > 0) {
                await page.mouse.click(
                    Math.min(box.x + Math.max(24, box.width * 0.08), box.x + box.width - 2),
                    Math.min(box.y + Math.max(32, box.height * 0.06), box.y + box.height - 2)
                );
            }
        } else {
            await page.mouse.click(100, 140);
        }
        await page.waitForTimeout(220);
        console.log('[Macromatix] Date field: Enter + blur');
    };
    try {
        await run();
    } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        if (!/Execution context was destroyed|detached frame|Target closed/i.test(msg)) throw e;
        console.warn('[Macromatix] Date field Enter/blur hit navigation; waiting for page then retry');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(450);
        await run();
    }
}

async function clickFirstToolbarAction(page) {
    return page.evaluate(() => {
        const want = /^(go|view|search|refresh|apply|submit)$/i;
        for (const btn of document.querySelectorAll('input[type="submit"], input[type="button"], button')) {
            const v = (btn.value || btn.textContent || '').trim();
            if (want.test(v)) {
                btn.click();
                return v;
            }
        }
        return null;
    });
}

/** Prefer system Chromium on Pi; README paths vary by OS (`chromium` vs `chromium-browser`). */
function resolveChromiumExecutablePath() {
    const fromEnv = String(process.env.SCRAPER_EXECUTABLE_PATH || '').trim();
    if (fromEnv) {
        if (fs.existsSync(fromEnv)) {
            return fromEnv;
        }
        console.warn(`[Macromatix] SCRAPER_EXECUTABLE_PATH not found (${fromEnv}), scanning common paths`);
    }
    const candidates = [
        // Windows local/dev defaults.
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        // Linux / Raspberry Pi defaults.
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/lib/chromium/chromium',
        '/usr/lib/chromium-browser/chromium-browser',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return undefined;
}

/** Does this Puppeteer install have a usable bundled Chromium? (We skip the download on Pi via .npmrc.) */
function hasBundledChromium() {
    try {
        const p = typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : '';
        return Boolean(p) && fs.existsSync(p);
    } catch {
        return false;
    }
}

/** Visible window: set SCRAPER_HEADLESS to 0, false, no, or off. Optional SCRAPER_SLOW_MO_MS (ms), SCRAPER_DEVTOOLS=1 */
function getPuppeteerLaunchOptions(overrides = {}) {
    const raw = process.env.SCRAPER_HEADLESS;
    let headless =
        raw === undefined || raw === ''
            ? true
            : !/^(0|false|no|off)$/i.test(String(raw).trim());
    if (overrides.headless === false) headless = false;
    if (overrides.headless === true) headless = true;
    const opts = {
        headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            ...(headless ? ['--disable-gpu'] : ['--start-maximized']),
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-extensions',
            '--mute-audio',
            '--no-first-run',
        ],
    };
    const chromiumPath = resolveChromiumExecutablePath();
    if (chromiumPath) {
        opts.executablePath = chromiumPath;
        console.log('[Macromatix] Using Chromium executable:', chromiumPath);
    } else if (!hasBundledChromium()) {
        throw new Error(
            'No Chromium found. On a Raspberry Pi run "sudo apt install -y chromium" (or chromium-browser), ' +
                'then set SCRAPER_EXECUTABLE_PATH in .env (e.g. /usr/bin/chromium). ' +
                'On Windows, set it to Edge/Chrome path (e.g. C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe). ' +
                'Puppeteer\'s bundled Chromium download is skipped via .npmrc, so a system browser is required.'
        );
    }
    const skipSlowMo = overrides.skipSlowMo === true;
    if (!skipSlowMo) {
        if (Number.isFinite(overrides.slowMo) && overrides.slowMo > 0) {
            opts.slowMo = overrides.slowMo;
        } else {
            const slowMo = Number(process.env.SCRAPER_SLOW_MO_MS);
            if (Number.isFinite(slowMo) && slowMo > 0) {
                opts.slowMo = slowMo;
            } else if (!headless) {
                opts.slowMo = 200;
            }
        }
    }
    if (/^(1|true|yes|on)$/i.test(String(process.env.SCRAPER_DEVTOOLS ?? '').trim())) {
        opts.devtools = true;
    }
    return opts;
}

/**
 * Set RadDatePicker hidden fields + visible text (runs in page). Returns `{ ok, postBackTarget }` for postback path.
 */
async function telerikApplyScheduledOrdersYmdFields(page, yyyy, month1, dayNum) {
    const monthIndex = month1 - 1;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const displayStr = `${dayNum}-${months[monthIndex]}-${yyyy}`;
    const pad = (n) => String(n).padStart(2, '0');
    const valueAsString = `${yyyy}-${pad(month1)}-${pad(dayNum)}-00-00-00`;

    return page.evaluate(
        ({ displayStr, valueAsString, y, m1, day }) => {
            const dateInput = document.querySelector('[id$="_DatePicker_dateInput"]');
            if (!dateInput || !dateInput.id) return { ok: false };

            const baseId = dateInput.id.replace(/_dateInput$/i, '');
            const hiddenMain = document.getElementById(baseId);
            const diClient = document.getElementById(`${baseId}_dateInput_ClientState`);
            const calSd = document.getElementById(`${baseId}_calendar_SD`);

            try {
                if (typeof $find === 'function') {
                    const picker = $find(baseId);
                    if (picker && typeof picker.set_selectedDate === 'function') {
                        picker.set_selectedDate(new Date(y, m1 - 1, day));
                    }
                }
            } catch (e) {
                /* ignore */
            }

            if (dateInput) {
                dateInput.removeAttribute('readonly');
                dateInput.removeAttribute('disabled');
                dateInput.value = displayStr;
                dateInput.dispatchEvent(new Event('input', { bubbles: true }));
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                dateInput.dispatchEvent(new Event('blur', { bubbles: true }));
            }
            if (hiddenMain) {
                hiddenMain.value = valueAsString;
            }
            if (diClient) {
                let o = {};
                try {
                    o = JSON.parse(diClient.value || '{}');
                } catch (e) {
                    o = {};
                }
                o.enabled = true;
                o.validationText = valueAsString;
                o.valueAsString = valueAsString;
                o.lastSetTextBoxValue = displayStr;
                if (!o.minDateStr) o.minDateStr = '1753-01-01-00-00-00';
                if (!o.maxDateStr) o.maxDateStr = '3000-12-31-00-00-00';
                diClient.value = JSON.stringify(o);
            }
            if (calSd) {
                calSd.value = `[[${y},${m1},${day}]]`;
            }

            return { ok: true, baseId, postBackTarget: dateInput.id.replace(/_/g, '$') };
        },
        { displayStr, valueAsString, y: yyyy, m1: month1, day: dayNum }
    );
}

/**
 * Scheduled orders: Telerik RadDatePicker - calendar pick + Enter/blur, then `__doPostBack` via injected
 * &lt;script&gt;. Afterward: race navigation vs settle (SCRAPER_SCHEDULED_ORDERS_SETTLE_MS), then `readyState` check.
 * Vendor parsing uses `withPageContextRetry` if a full reload replaces the document mid-scrape.
 * With postback on, toolbar Go/Refresh is skipped. Set SCRAPER_SCHEDULED_DATE_POSTBACK=false to use toolbar only.
 */
async function setScheduledOrdersToYmd(page, yyyy, month1, dayNum) {
    const monthIndex = month1 - 1;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const displayStr = `${dayNum}-${months[monthIndex]}-${yyyy}`;
    const pad = (n) => String(n).padStart(2, '0');
    const valueAsString = `${yyyy}-${pad(month1)}-${pad(dayNum)}-00-00-00`;
    const settleMs = Math.max(3500, Number(process.env.SCRAPER_SCHEDULED_ORDERS_SETTLE_MS ?? 6500) || 6500);

    await page
        .waitForSelector('[id$="_DatePicker_wrapper"], [id$="_DatePicker_dateInput"]', { timeout: 25000 })
        .catch(() => null);
    await page.waitForTimeout(600);

    /** RadCalendar first: day click often reloads the page; avoid a second __doPostBack from stale control ids. */
    const pickedCalendar = await pickDateViaRadCalendarUI(page, yyyy, monthIndex, dayNum);
    if (pickedCalendar) {
        console.log(`[Macromatix] Scheduled-orders date via RadCalendar → ${displayStr} (${valueAsString})`);
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(settleMs);
        try {
            await commitScheduledOrdersDateUi(page);
        } catch (e) {
            console.warn('[Macromatix] commitScheduledOrdersDateUi after RadCalendar:', e.message);
        }
        await page.waitForTimeout(700);
        return;
    }

    console.warn('[Macromatix] RadCalendar pick failed; using Telerik field sync + postback / toolbar');

    const applied = await telerikApplyScheduledOrdersYmdFields(page, yyyy, month1, dayNum);
    if (applied.ok) {
        console.log(`[Macromatix] Telerik scheduled-orders date fields → ${displayStr} (${valueAsString})`);
    } else {
        console.warn('[Macromatix] Scheduled-orders date input `[id$="_DatePicker_dateInput"]` not found');
        return;
    }

    const pickedUi = await pickDateViaRadCalendarUI(page, yyyy, monthIndex, dayNum);
    if (pickedUi) {
        console.log('[Macromatix] RadCalendar UI (fallback path): day selected');
    }

    await page.waitForTimeout(250);

    await commitScheduledOrdersDateUi(page);

    /** Date change is usually a partial postback - no document navigation, so `waitForNavigation` would idle until timeout (~30s). */
    if (SCHEDULED_DATE_POSTBACK && applied.postBackTarget) {
        try {
            const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
            await triggerDoPostBackSloppy(page, applied.postBackTarget);
            await Promise.race([nav, page.waitForTimeout(settleMs)]);
            await page.waitForFunction(() => document.readyState === 'complete', { timeout: 12000 }).catch(() => {});
            await page.waitForTimeout(350);
            console.log('[Macromatix] Date postback fired (SCRAPER_SCHEDULED_DATE_POSTBACK)');
        } catch (e) {
            console.warn('[Macromatix] Date postback/navigation:', e.message);
        }
        await page.waitForTimeout(120);
    } else {
        const clicked = await clickFirstToolbarAction(page);
        if (clicked) {
            console.log('[Macromatix] Post-date toolbar:', clicked);
            await Promise.race([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {}),
                page.waitForTimeout(settleMs),
            ]);
            await page.waitForFunction(() => document.readyState === 'complete', { timeout: 12000 }).catch(() => {});
            await page.waitForTimeout(350);
        }
        await page.waitForTimeout(120);
    }

    await page.waitForTimeout(350);
}

async function setScheduledOrdersDateOffset(page, offsetDays) {
    if (!Number.isFinite(offsetDays) || offsetDays === 0) return;
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    await setScheduledOrdersToYmd(page, d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/* -----------------------------------------------------------
   Multi-store support
----------------------------------------------------------- */

/** Optional allowlist/order of store numbers; default = every store the account can see. */
function getConfiguredStoreNumbers() {
    return String(process.env.DASHBOARD_STORE_NUMBERS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Single-store Macromatix accounts must pick a store after each login, then logout before the next store.
 * Set SCRAPER_SINGLE_STORE_LOGIN=0 to restore the legacy multi-store dropdown flow on one session.
 */
function useSingleStoreLoginMode() {
    const raw = process.env.SCRAPER_SINGLE_STORE_LOGIN;
    if (raw === undefined || raw === '') return true;
    return !/^(0|false|no|off)$/i.test(String(raw).trim());
}

function getScraperConcurrency(storeCount) {
    const singleStore = useSingleStoreLoginMode();
    const fallback = singleStore ? 4 : 3;
    const requestedConc = Number(process.env.SCRAPER_CONCURRENCY);
    const maxConc =
        Number.isFinite(requestedConc) && requestedConc > 0 ? Math.floor(requestedConc) : fallback;
    return Math.max(1, Math.min(maxConc, storeCount));
}

/** Pull a 3–6 digit store number out of an option label like "3811 Chirnside Park". */
function storeNumberFromLabel(label) {
    const m = String(label || '').match(/\b(\d{3,6})\b/);
    return m ? m[1] : '';
}

/** Load-on-demand store combo: how long to poll for items after triggering the fetch. */
const STORE_COMBO_LOAD_TIMEOUT_MS = Number(process.env.SCRAPER_STORE_COMBO_TIMEOUT_MS || 9000);

/**
 * The store picker on the labour scheduler is a Telerik RadComboBox (id `..._ddlEntity`,
 * input `..._ddlEntity_Input`), not a native `<select>`. Find its component id so we can drive it.
 */
async function findStoreComboId(page) {
    return page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        for (const el of document.querySelectorAll('td, label, span, div')) {
            if (/^store\s*:?$/i.test(norm(el.textContent))) {
                const scope = el.closest('tr, table, div') || el.parentElement;
                const combo = scope && scope.querySelector('.RadComboBox[id]');
                if (combo) return combo.id;
            }
        }
        const byId = document.querySelector(
            '.RadComboBox[id$="ddlEntity"], .RadComboBox[id*="Entity"], .RadComboBox[id*="Store" i]'
        );
        return byId ? byId.id : '';
    });
}

/** Read RadComboBox items via the Telerik client API ($find). */
async function readStoreComboItems(page, comboId) {
    return page.evaluate((id) => {
        const c = typeof window.$find === 'function' ? window.$find(id) : null;
        if (!c || typeof c.get_items !== 'function') return [];
        const list = c.get_items();
        const out = [];
        for (let i = 0; i < list.get_count(); i++) {
            const text = (list.getItem(i).get_text() || '').replace(/\s+/g, ' ').trim();
            if (text) out.push({ storeName: text, optionValue: list.getItem(i).get_value() });
        }
        return out;
    }, comboId);
}

/** Current selected text of the store combo (e.g. "3904 Butler"). */
async function getStoreComboText(page, comboId) {
    return page.evaluate((id) => {
        const c = typeof window.$find === 'function' ? window.$find(id) : null;
        return c && typeof c.get_text === 'function' ? (c.get_text() || '').trim() : '';
    }, comboId);
}

/**
 * Open the store RadComboBox and return its items. The picker is load-on-demand, so clicking the
 * arrow cell triggers the server fetch (showDropDown alone does not); then poll until items populate.
 */
async function openStoreComboAndReadItems(page, comboId) {
    const arrow = await page.$(`#${comboId} .rcbArrowCell, #${comboId} .rcbArrowCellRight`);
    if (arrow) {
        await arrow.click().catch(() => {});
    } else {
        await page.evaluate((id) => {
            const c = typeof window.$find === 'function' ? window.$find(id) : null;
            if (c && typeof c.requestItems === 'function') c.requestItems('', false);
            else if (c && typeof c.showDropDown === 'function') c.showDropDown();
        }, comboId);
    }
    const deadline = Date.now() + STORE_COMBO_LOAD_TIMEOUT_MS;
    let items = [];
    while (Date.now() < deadline) {
        await page.waitForTimeout(400);
        items = await readStoreComboItems(page, comboId);
        if (items.length) break;
    }
    return items;
}

/** Read rendered `<li>` items straight from the dropdown element (fallback when the client API is empty). */
async function readStoreComboDropdownLis(page, comboId) {
    return page.evaluate((id) => {
        const dd = document.getElementById(`${id}_DropDown`) || document;
        const out = [];
        dd.querySelectorAll('li.rcbItem').forEach((li) => {
            const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) out.push({ storeName: t, optionValue: t });
        });
        return out;
    }, comboId);
}

/** Native `<select>` fallback for accounts/pages where the store picker is a plain dropdown. */
async function readNativeStoreSelect(page) {
    return page.evaluate(() => {
        const out = [];
        for (const sel of document.querySelectorAll('select')) {
            const ctx = ((sel.closest('tr, td, div, table') || sel).innerText || '').toLowerCase();
            const looks = Array.from(sel.options).some((o) => /\b\d{3,6}\b/.test(o.text || ''));
            if (!ctx.includes('store') && !looks) continue;
            for (const opt of sel.options) {
                const text = (opt.textContent || '').replace(/\s+/g, ' ').trim();
                if (text && /\b\d{3,6}\b/.test(text) && !/select|choose/i.test(text)) {
                    out.push({ storeName: text, optionValue: opt.value });
                }
            }
            if (out.length) break;
        }
        return out;
    });
}

/**
 * Enumerate every store the account can access. Tries the RadComboBox client API, then the opened
 * dropdown's `<li>` items, then a native `<select>`. Returns `[{ storeNumber, storeName, optionValue }]`.
 */
async function enumerateStores(page) {
    const comboId = await findStoreComboId(page);
    let raw = [];

    if (comboId) {
        raw = await readStoreComboItems(page, comboId);
        if (!raw.length) {
            raw = await openStoreComboAndReadItems(page, comboId);
        }
        if (!raw.length) {
            raw = await readStoreComboDropdownLis(page, comboId);
        }
    }
    if (!raw.length) {
        raw = await readNativeStoreSelect(page);
    }

    const seen = new Set();
    const stores = [];
    for (const r of raw) {
        const storeNumber = storeNumberFromLabel(r.storeName);
        if (!storeNumber || seen.has(storeNumber)) continue;
        seen.add(storeNumber);
        stores.push({ storeNumber, storeName: r.storeName, optionValue: r.optionValue });
    }

    const configured = getConfiguredStoreNumbers();
    if (configured.length) {
        const byNumber = new Map(stores.map((s) => [s.storeNumber, s]));
        const ordered = configured.map((n) => byNumber.get(n)).filter(Boolean);
        const missing = configured.filter((n) => !byNumber.has(n));
        if (missing.length) {
            console.warn('[Macromatix] DASHBOARD_STORE_NUMBERS not found on the account:', missing.join(', '));
        }
        return ordered.length ? ordered : stores;
    }

    return stores;
}

/**
 * ASP.NET postback after RadCombo store change - wait before the next page.evaluate.
 */
async function waitForStoreSelectionPostback(page) {
    const { waitForAspPostback } = require('./mmxReports/mmx-postback');
    await waitForAspPostback(page, { timeoutMs: 12000 });
}

/**
 * Select a store by number on the current page. Drives the RadComboBox (open + click the matching item,
 * which fires the ASP.NET postback), with a client-API path and a native `<select>` fallback.
 * Returns the selected option text, or null if nothing matched.
 */
async function selectStoreOnPage(page, storeNumber) {
    const want = String(storeNumber).replace(/[^0-9]/g, '');
    if (!want) return null;

    const comboId = await findStoreComboId(page);
    if (comboId) {
        // Already on this store? Skip - its <li> may not render in the dropdown when selected.
        const current = await getStoreComboText(page, comboId);
        if (new RegExp(`(^|\\D)${want}(\\D|$)`).test(current)) {
            return current;
        }

        await openStoreComboAndReadItems(page, comboId);

        const clicked = await page.evaluate(
            ({ id, w }) => {
                const re = new RegExp(`(^|\\D)${w}(\\D|$)`);
                const dd = document.getElementById(`${id}_DropDown`) || document;
                for (const li of dd.querySelectorAll('li.rcbItem')) {
                    const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
                    if (re.test(t)) {
                        li.scrollIntoView({ block: 'center' });
                        li.click();
                        return t;
                    }
                }
                return null;
            },
            { id: comboId, w: want }
        );
        if (clicked) {
            await waitForStoreSelectionPostback(page);
            return clicked;
        }

        const viaApi = await page.evaluate(
            ({ id, w }) => {
                const c = typeof window.$find === 'function' ? window.$find(id) : null;
                if (!c || typeof c.get_items !== 'function') return null;
                const re = new RegExp(`(^|\\D)${w}(\\D|$)`);
                const list = c.get_items();
                for (let i = 0; i < list.get_count(); i++) {
                    const it = list.getItem(i);
                    if (re.test((it.get_text() || '').trim())) {
                        if (typeof it.select === 'function') it.select();
                        if (typeof c.set_text === 'function') c.set_text(it.get_text());
                        return it.get_text();
                    }
                }
                return null;
            },
            { id: comboId, w: want }
        );
        if (viaApi) {
            await waitForStoreSelectionPostback(page);
            return viaApi;
        }
    }

    const fromSelect = await page.evaluate((w) => {
        const re = new RegExp(`(^|\\D)${w}(\\D|$)`);
        for (const sel of document.querySelectorAll('select')) {
            const ctx = ((sel.closest('tr, td, div, table') || sel).innerText || '').toLowerCase();
            const looks = Array.from(sel.options).some((o) => /\b\d{3,6}\b/.test(o.text || ''));
            if (!ctx.includes('store') && !looks) continue;
            for (const opt of sel.options) {
                if (re.test((opt.textContent || '').trim())) {
                    const changed = sel.value !== opt.value;
                    if (changed) {
                        sel.value = opt.value;
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    return { text: (opt.textContent || '').trim(), changed };
                }
            }
        }
        return null;
    }, want);
    if (fromSelect?.changed) {
        await waitForStoreSelectionPostback(page);
    }
    return fromSelect?.text || null;
}

/**
 * True when the current page is already scoped to `storeNumber` (single-store logins, or combo
 * already showing the right store). Does not navigate away from the current page.
 */
async function confirmStoreContextOnPage(page, storeNumber) {
    const want = String(storeNumber || '').replace(/[^0-9]/g, '');
    if (!want) return null;

    const comboId = await findStoreComboId(page);
    if (comboId) {
        const text = await getStoreComboText(page, comboId);
        if (new RegExp(`(^|\\D)${want}(\\D|$)`).test(text || '')) {
            return text.trim();
        }
        let items = await readStoreComboItems(page, comboId);
        if (!items.length) {
            items = await openStoreComboAndReadItems(page, comboId);
        }
        if (items.length === 1 && storeNumberFromLabel(items[0].storeName) === want) {
            return items[0].storeName;
        }
    }

    const hasStoreHint = await page.evaluate((w) => {
        const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
        return new RegExp(`\\b${w}\\b`).test(body.slice(0, 16000));
    }, want);
    if (hasStoreHint) return want;

    return null;
}

/** Select a store on the current MMX page, or confirm the session is already on that store. */
async function resolveStoreOnCurrentPage(page, storeNumber, options = {}) {
    const num = String(storeNumber || '').replace(/\D/g, '');
    if (!num) throw new Error('Store number required');

    const storeCfg = getStoreConfig(num) || { storeNumber: num, storeName: num };
    const storeLabel = [storeCfg.storeNumber, storeCfg.storeName].filter(Boolean).join(' ').trim() || num;

    await page.waitForTimeout(Number(options.waitMs ?? 800));
    let picked = await selectStoreOnPage(page, num);
    if (!picked && storeLabel && storeLabel !== num) {
        const { selectStore: selectStoreByLabel } = require('./mmxReports/pipeline-supply-chain-reports');
        await selectStoreByLabel(page, storeLabel, { storeNumber: num, waitMs: 500 });
        picked = await selectStoreOnPage(page, num);
    }
    if (!picked && !options.requireComboSelection) {
        picked = await confirmStoreContextOnPage(page, num);
        if (picked) {
            console.log(`[Macromatix] Store ${num} already in session context (${picked})`);
        }
    }
    if (!picked && !options.optional) {
        throw new Error(`Could not select store ${num} in Macromatix`);
    }
    return picked;
}

/** Day view tab on the labour scheduler (re-clicked after each store change because the grid reloads). */
const DAY_VIEW_TAB_SELECTOR =
    '#ctl00_ph_scheduleLabour_rdScheduler_C_rtbLabour > div > div > div > ul > li:nth-child(12) > a';

async function openDayViewAndReadSales(page, shouldReadForecast) {
    await page.waitForSelector(DAY_VIEW_TAB_SELECTOR, { timeout: 15000 });
    await page.click(DAY_VIEW_TAB_SELECTOR);

    await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {}),
        page.waitForTimeout(4000),
    ]);
    await page.waitForTimeout(1200);

    await page.waitForFunction(
        () => {
            const row = document.querySelector('tr[data-kpi="ActualSalesKpi"]');
            if (!row) return false;
            return row.querySelectorAll('td').length > 10;
        },
        { timeout: 15000 }
    );

    return page.evaluate((readForecast) => {
        const parseHourlyRow = (row) => {
            const cells = row.querySelectorAll('td');
            const values = [];
            for (let i = 2; i < cells.length; i++) {
                const raw = cells[i].textContent.replace(/[^0-9.-]/g, '').trim();
                const value = parseFloat(raw);
                if (!Number.isNaN(value)) values.push(value);
            }
            return values;
        };

        const actualRow = document.querySelector('tr[data-kpi="ActualSalesKpi"]');
        const forecastRow = document.querySelector('tr[data-kpi="ForecastSalesKpi"]');
        if (!actualRow || (readForecast && !forecastRow)) throw new Error('Sales data rows not found');

        return {
            actual: parseHourlyRow(actualRow),
            forecast: readForecast ? parseHourlyRow(forecastRow) : null,
        };
    }, shouldReadForecast);
}

/** Raw vendor text from Macromatix → short label for the dashboard (only these are listed). */
const VENDOR_LABEL_RULES = [
    { re: /americold/i, label: 'Americold' },
    { re: /schweppes/i, label: 'Schweppes' },
    { re: /cut\s*fresh/i, label: 'Cut Fresh' },
    { re: /bega/i, label: 'Bega' },
];

function rawVendorToDisplayLabel(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    for (const { re, label } of VENDOR_LABEL_RULES) {
        if (re.test(s)) return label;
    }
    return null;
}

function uniqueSortedLabels(rawVendors) {
    const labels = new Set();
    for (const raw of rawVendors) {
        const label = rawVendorToDisplayLabel(raw);
        if (label) labels.add(label);
    }
    return [...labels].sort((a, b) => a.localeCompare(b));
}

/** Full page reload after postback can replace the JS context while we scrape; retry after load settles. */
async function withPageContextRetry(page, label, fn) {
    const backoffMs = [450, 900, 1600];
    let lastErr;
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastErr = e;
            const msg = String(e && e.message ? e.message : e);
            const retriable = /Execution context was destroyed|Target closed|Protocol error|most likely because of a navigation/i.test(
                msg
            );
            if (!retriable || attempt === backoffMs.length) {
                throw e;
            }
            console.warn(`[Macromatix] ${label}: context lost during scrape; retry ${attempt + 2}/${backoffMs.length + 1}`);
            await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            await page.waitForTimeout(backoffMs[attempt]);
        }
    }
    throw lastErr;
}

/**
 * Parse scheduled-orders tables: rows that still need an order placed (Create/Process in Order #,
 * or Pending / Unprocessed status) and no numeric order # → vendor names.
 */
async function scrapePendingVendors(page, opts = {}) {
    await page.goto(SCHEDULED_ORDERS_URL, GOTO_OPTS);
    await page.waitForTimeout(700);

    if (opts.storeNumber && !opts.skipStoreSelect) {
        const picked = await selectStoreOnPage(page, opts.storeNumber);
        if (picked) {
            console.log('[Macromatix] Scheduled orders store selected:', picked);
            await Promise.race([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {}),
                page.waitForTimeout(1500),
            ]);
            await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 }).catch(() => {});
        } else {
            console.warn(`[Macromatix] Scheduled orders: store ${opts.storeNumber} not selectable; using current view`);
        }
    }

    // await withPageContextRetry(page, 'scheduled orders date', async () => {
    //     await setScheduledOrdersDateOffset(page, SCHEDULED_ORDERS_DAY_OFFSET);
    // });

    const { pickYmd } = opts;
    if (
        pickYmd &&
        Number.isFinite(pickYmd.year) &&
        Number.isFinite(pickYmd.month) &&
        Number.isFinite(pickYmd.day)
    ) {
        await withPageContextRetry(page, 'scheduled orders date (test YMD)', async () => {
            await setScheduledOrdersToYmd(page, pickYmd.year, pickYmd.month, pickYmd.day);
        });
        await page.waitForTimeout(500);
    } else {
        const { applyScheduledOrdersListDateFromConfig } = require('./mmxReports/mmx-scheduled-orders');
        await applyScheduledOrdersListDateFromConfig(page);
    }

    const parsed = await withPageContextRetry(page, 'scheduled orders vendors', async () => {
        await Promise.race([
            page
                .waitForFunction(
                    () =>
                        [...document.querySelectorAll('table')].some((t) => {
                            const txt = (t.innerText || '').toLowerCase();
                            return txt.includes('vendor') && txt.includes('status');
                        }),
                    { timeout: 3500 }
                )
                .catch(() => {}),
            page.waitForTimeout(500),
        ]);
        await page.waitForTimeout(120);

        return page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const lower = (s) => norm(s).toLowerCase();

        const looksLikeOrderNumber = (text) => {
            const t = norm(text);
            if (!t) return false;
            if (/^[\s\-\n\/\.a]*$/i.test(t.replace(/\s/g, ''))) return false;
            return /[0-9]/.test(t);
        };

        /** Macromatix: "Create" / "Process" sit in Order #; status is often Pending / Unprocessed. */
        const rowNeedsOrderPlaced = (statusText, orderText) => {
            if (looksLikeOrderNumber(orderText)) return false;
            const s = lower(statusText);
            const o = lower(orderText);
            if (s.includes('past cutoff') || s.includes('no order required') || s.includes('actioned')) {
                return false;
            }
            if (o.includes('create') || o.includes('process') || o.includes('in progress')) return true;
            if (s.includes('pending')) return true;
            if (s.includes('unprocessed')) return true;
            if (s.includes('order to be placed')) return true;
            return false;
        };

        let best = [];
        let bestDataRowCount = 0;
        let matchedTableCount = 0;
        const tables = Array.from(document.querySelectorAll('table'));

        for (const table of tables) {
            if (table.closest('[id$="_DatePicker_wrapper"]')) continue;
            if (table.classList.contains('RadCalendar') || table.classList.contains('RadCalendarTimeView')) {
                continue;
            }

            const headerTr = table.querySelector('thead tr') || table.rows[0];
            if (!headerTr) continue;
            const headCells = Array.from(headerTr.querySelectorAll('th, td')).map((c) => norm(c.textContent));
            if (!headCells.some((h) => lower(h).includes('status'))) continue;
            if (!headCells.some((h) => lower(h).includes('vendor'))) continue;

            const statusIdx = headCells.findIndex((h) => lower(h).includes('status'));
            let orderIdx = headCells.findIndex((h) => {
                const L = lower(h);
                return (L.includes('order') && L.includes('#')) || /^order\s*#/.test(L);
            });
            if (orderIdx < 0) {
                orderIdx = headCells.findIndex((h) => {
                    const L = lower(h);
                    return (
                        (L.includes('order') && (L.includes('no') || L.includes('number'))) ||
                        L === 'po' ||
                        L.includes('po #')
                    );
                });
            }
            const vendorIdx = headCells.findIndex((h) => {
                const L = lower(h);
                return L.includes('vendor') || L.includes('supplier');
            });

            if (statusIdx < 0 || vendorIdx < 0 || orderIdx < 0) continue;
            matchedTableCount += 1;

            let dataRows = [...table.querySelectorAll('tbody > tr')];
            if (!dataRows.length) {
                dataRows = [...table.querySelectorAll('tr')].filter((tr) => tr !== headerTr);
            }

            const maxIdx = Math.max(statusIdx, vendorIdx, orderIdx);
            const found = [];
            for (const tr of dataRows) {
                const cells = Array.from(tr.querySelectorAll('td'));
                if (cells.length <= maxIdx) continue;
                const statusText = cells[statusIdx]?.textContent;
                const vendorRaw = norm(cells[vendorIdx]?.textContent);
                const orderText = norm(cells[orderIdx]?.textContent);
                if (!vendorRaw) continue;
                if (!rowNeedsOrderPlaced(statusText, orderText)) continue;
                found.push(vendorRaw);
            }
            if (found.length > best.length || (found.length === best.length && dataRows.length > bestDataRowCount)) {
                best = found;
                bestDataRowCount = dataRows.length;
            }
        }

        return {
            rawVendors: best,
            matchedTableCount,
            dataRowCount: bestDataRowCount,
        };
    });
    });

    if (!parsed.matchedTableCount) {
        throw new Error('Scheduled orders table not found');
    }

    return {
        vendors: uniqueSortedLabels(parsed.rawVendors),
        dataRowCount: parsed.dataRowCount,
        matchedTableCount: parsed.matchedTableCount,
    };
}

/** Lightweight check: pending scheduled-order vendors per store for one calendar date. */
async function probePendingOrdersForStores(page, stores, options = {}) {
    const pickYmd = options.pickYmd || null;
    const results = [];

    for (const store of stores) {
        const storeNumber = String(store.storeNumber || '').trim();
        const label = storeNumber || '(default)';
        try {
            const pendingResult = await scrapePendingVendors(page, {
                storeNumber,
                pickYmd,
            });
            const vendors = pendingResult.vendors || [];
            results.push({
                storeNumber,
                storeName: store.storeName || storeNumber,
                pendingVendors: vendors,
                hasOrders: vendors.length > 0,
            });
            console.log(`[Macromatix] Probe ${label} (${pickYmd ? 'dated' : 'default date'}):`, vendors.join(', ') || '(none)');
        } catch (err) {
            console.warn(`[Macromatix] Probe ${label} failed:`, err.message);
            results.push({
                storeNumber,
                storeName: store.storeName || storeNumber,
                pendingVendors: [],
                hasOrders: false,
                error: err.message,
            });
        }
    }

    return results;
}

/**
 * Scrape one store on an already-logged-in page: select the store on the labour scheduler, enter Day view,
 * read actual/forecast, then read pending vendors from scheduled orders for that same store.
 * When skipStoreSelect is true (single-store login mode), the session is already bound to that store.
 */
async function scrapeStoreData(page, store, ctx, scrapeOpts = {}) {
    const { todayKey, testScheduledOrdersPick, pickYmd, skipScheduledPersistence } = ctx;
    const skipStoreSelect = Boolean(scrapeOpts.skipStoreSelect);
    const storeNumber = String(store.storeNumber || '').trim();
    const label = storeNumber || '(default)';

    await page.goto(LABOUR_URL, GOTO_OPTS);
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});

    if (storeNumber && !skipStoreSelect) {
        const picked = await selectStoreOnPage(page, storeNumber);
        if (picked) {
            console.log(`[Macromatix] Labour scheduler store selected: ${picked}`);
            // Entity change is a postback that reloads the scheduler panel - wait for it to settle.
            await Promise.race([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {}),
                page.waitForTimeout(2500),
            ]);
            await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
            await page.waitForTimeout(1200);
        } else {
            console.warn(`[Macromatix] Labour scheduler: store ${storeNumber} not selectable; reading current view`);
        }
    }

    const cachedForecast = getCachedForecastForToday(storeNumber, todayKey);
    const sales = await openDayViewAndReadSales(page, !cachedForecast);
    if (cachedForecast) {
        sales.forecast = cachedForecast;
    } else {
        setCachedForecast(storeNumber, todayKey, sales.forecast);
        warnIfSuspiciousForecast(storeNumber, sales.forecast);
    }

    console.log(
        `[Macromatix] Store ${label} - actual ${sales.actual.length}h, forecast ${sales.forecast.length}h ${cachedForecast ? '(cached)' : '(fresh)'}`
    );

    let pendingVendors = [];
    try {
        const pendingResult = await scrapePendingVendors(page, {
            storeNumber,
            pickYmd: testScheduledOrdersPick ? pickYmd : null,
            skipStoreSelect,
        });
        pendingVendors = pendingResult.vendors;
        console.log(`[Macromatix] Store ${label} pending vendors:`, pendingVendors.join(', ') || '(none)');
        if (!skipScheduledPersistence) {
            recordScheduledOrdersResult(storeNumber, todayKey, pendingVendors);
        }
    } catch (vendorErr) {
        console.warn(`[Macromatix] Store ${label} scheduled orders scrape failed:`, vendorErr.message);
        pendingVendors = getLastKnownPendingVendors(storeNumber, todayKey);
    }

    const hours = resolveStoreHours(store, storeNumber);
    return {
        storeNumber,
        storeName: store.storeName || storeNumber,
        openHour: hours.openHour,
        closeHour: hours.closeHour,
        actual: sales.actual,
        forecast: sales.forecast,
        pendingVendors,
    };
}

/** Trading hours for a store: prefer the passed store object, then .storelist, then defaults. */
function resolveStoreHours(store, storeNumber) {
    const cfg = getStoreConfig(storeNumber);
    const openHour = Number.isFinite(store && store.openHour)
        ? store.openHour
        : cfg
          ? cfg.openHour
          : DEFAULT_OPEN_HOUR;
    const closeHour = Number.isFinite(store && store.closeHour)
        ? store.closeHour
        : cfg
          ? cfg.closeHour
          : DEFAULT_CLOSE_HOUR;
    return { openHour, closeHour };
}

/** Resource types worth aborting - they don't affect the data we read but cost time/bandwidth. */
const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

/**
 * Abort heavy, irrelevant requests (images/media/fonts) to speed up navigation.
 * Stylesheets and scripts are kept so Telerik widgets and visibility-based waits still work.
 * Disable with SCRAPER_BLOCK_RESOURCES=0 if a page ever misbehaves.
 */
async function applyResourceBlocking(page) {
    if (/^(0|false|no|off)$/i.test(String(process.env.SCRAPER_BLOCK_RESOURCES ?? 'true').trim())) {
        return;
    }
    try {
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
                req.abort().catch(() => {});
            } else {
                req.continue().catch(() => {});
            }
        });
    } catch (err) {
        console.warn('[Macromatix] Resource blocking unavailable:', err.message);
    }
}

/** Paste credentials instantly (never page.type with per-key delay). */
async function fillInputValue(page, selector, value) {
    const text = String(value ?? '');
    await page.waitForSelector(selector, { visible: true, timeout: 15000 });
    await page.evaluate(
        (sel, val) => {
            const el = document.querySelector(sel);
            if (!el) throw new Error(`Field not found: ${sel}`);
            el.focus();
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        selector,
        text
    );
    const filled = await page.$eval(selector, (el) => el.value).catch(() => '');
    if (filled !== text) {
        await page.focus(selector);
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type(selector, text, { delay: 0 });
    }
}

const LOGIN_GOTO_OPTS = { waitUntil: 'domcontentloaded', timeout: 45000 };

async function readMacromatixLoginError(page) {
    return page
        .evaluate(() => {
            const el = document.querySelector(
                '.validation-summary-errors, #FailureText, .failureNotification, span[style*="color: red"]'
            );
            return el ? String(el.textContent || '').trim() : '';
        })
        .catch(() => '');
}

/** True when the page is the Macromatix logon form (not an authenticated screen). */
async function isMacromatixLoginPage(page) {
    const url = page.url();
    if (await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]')) return false;
    if (/MMS_Logon\.aspx/i.test(url)) {
        if (/mode=SelectStore/i.test(url)) return false;
        return Boolean(await page.$('#Login_UserName'));
    }
    return Boolean(await page.$('#Login_UserName'));
}

const SELECT_STORE_URL = `${BASE_URL}MMS_Logon.aspx?mode=SelectStore`;

function maskUsernameForLog(username) {
    const u = String(username || '').trim();
    if (!u) return '(empty)';
    if (u.length <= 3) return `${u[0] || '?'}**`;
    return `${u.slice(0, 3)}***${u.slice(-2)}`;
}

async function countStoresOnLoginDropdown(page) {
    return page.evaluate(() => {
        const sel = document.querySelector('#ddlStoreSelection, select[name="ddlStoreSelection"]');
        if (!sel) return 0;
        return [...sel.options].filter((opt) => {
            const text = (opt.textContent || '').replace(/\s+/g, ' ').trim();
            return text && !/^select store$/i.test(text) && /\b\d{3,6}\b/.test(text);
        }).length;
    });
}

/** Wait until the login store dropdown stops growing (async store list on slow Pi). */
async function waitForLoginStoreDropdownStable(page, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    let lastCount = -1;
    let stableSince = 0;
    while (Date.now() < deadline) {
        const count = await countStoresOnLoginDropdown(page);
        if (count > 0 && count === lastCount) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince >= 1500) return count;
        } else {
            lastCount = count;
            stableSince = 0;
        }
        await page.waitForTimeout(350);
    }
    return Math.max(lastCount, 0);
}

async function waitForLoginStoreDropdownPopulated(page, timeoutMs = 18000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await page.evaluate(() => {
            const sel = document.querySelector('#ddlStoreSelection, select[name="ddlStoreSelection"]');
            if (!sel) return false;
            return [...sel.options].some((opt) => {
                const text = (opt.textContent || '').replace(/\s+/g, ' ').trim();
                return text && !/^select store$/i.test(text) && /\b\d{3,6}\b/.test(text);
            });
        });
        if (ready) return true;
        await page.waitForTimeout(400);
    }
    return false;
}

/** Open the post-login store picker when the account must select a store before labour scheduler works. */
async function ensureLoginStorePickerPage(page) {
    if (await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]')) {
        return true;
    }
    if (/mode=SelectStore/i.test(page.url() || '')) {
        await page
            .waitForSelector('#ddlStoreSelection, select[name="ddlStoreSelection"]', {
                visible: true,
                timeout: 12000,
            })
            .catch(() => {});
        if (await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]')) {
            return true;
        }
    }
    if (await isMacromatixLoginPage(page)) {
        return false;
    }
    console.log('[Macromatix] Navigating to login store picker (SelectStore)...');
    await page.goto(SELECT_STORE_URL, GOTO_OPTS);
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(800);
    await assertMacromatixAuthenticated(page, 'SelectStore');
    return Boolean(await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]'));
}

async function isLoginStorePickerPresent(page) {
    return Boolean(await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]'));
}

/**
 * Post-login `#ddlStoreSelection` - required for multi-store accounts so the store appears in labour scheduler.
 * Returns selected option text, or null if the control is missing / no match.
 */
async function selectStoreOnLoginDropdown(page, storeNumber) {
    const want = String(storeNumber || '').replace(/[^0-9]/g, '');
    if (!want) return null;

    const pickerAvailable = await ensureLoginStorePickerPage(page);
    if (!pickerAvailable) return null;

    await waitForLoginStoreDropdownPopulated(page);

    const match = await page.evaluate((w) => {
        const sel = document.querySelector('#ddlStoreSelection, select[name="ddlStoreSelection"]');
        if (!sel) return null;
        const re = new RegExp(`(^|\\D)${w}(\\D|$)`);
        for (const opt of sel.options) {
            const text = (opt.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || /^select store$/i.test(text)) continue;
            if (re.test(text)) {
                return { text, value: opt.value };
            }
        }
        return null;
    }, want);

    if (!match) return null;

    try {
        await page.select('#ddlStoreSelection', match.value);
    } catch {
        await page.evaluate((value) => {
            const sel = document.querySelector('#ddlStoreSelection, select[name="ddlStoreSelection"]');
            if (!sel) return;
            sel.value = value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        }, match.value);
    }

    await page.waitForTimeout(350);
    await triggerDoPostBackSloppy(page, 'ddlStoreSelection');
    await page.waitForTimeout(450);

    const clicked = await page.evaluate(() => {
        const storeBtn = document.querySelector('#btStoreSelection, input[name="btStoreSelection"]');
        if (storeBtn) {
            storeBtn.click();
            return storeBtn.value || 'btStoreSelection';
        }
        for (const el of document.querySelectorAll('input[type="submit"], input[type="button"], button, a')) {
            const t = (el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^(go|continue|ok|select|submit|log\s*on|login)$/i.test(t)) {
                el.click();
                return t;
            }
        }
        return null;
    });

    await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}),
        page.waitForFunction(
            () => !/mode=SelectStore/i.test(location.href || ''),
            { timeout: 25000 }
        ).catch(() => {}),
        page.waitForTimeout(clicked ? 6000 : 2000),
    ]);
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(600);

    const stillOnPicker =
        /mode=SelectStore/i.test(page.url() || '') ||
        Boolean(await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]'));
    if (stillOnPicker) {
        throw new Error(`Store ${want} selection did not leave the login picker (still on SelectStore)`);
    }

    console.log(
        `[Macromatix] Login store dropdown: ${match.text}${clicked ? ` (clicked ${clicked})` : ''}`
    );
    return match.text;
}

function normalizeStorePickResult(result) {
    if (result && typeof result === 'object') {
        return {
            label: String(result.label || result.storeNumber || '').trim(),
            implicit: Boolean(result.implicit),
            reason: String(result.reason || '').trim(),
        };
    }
    return {
        label: String(result || '').trim(),
        implicit: false,
        reason: '',
    };
}

/**
 * Single-store Macromatix logins often skip `#ddlStoreSelection` and land straight in the app.
 * Detect when the session is already scoped to the target store so we do not force Change Store.
 */
async function tryImplicitSingleStoreContext(page, storeNumber) {
    const want = String(storeNumber || '').replace(/[^0-9]/g, '');
    if (!want) return null;

    const onSelectStore =
        /mode=SelectStore/i.test(page.url() || '') ||
        Boolean(await page.$('#ddlStoreSelection, select[name="ddlStoreSelection"]'));
    if (onSelectStore) return null;

    if (!/LabourScheduler/i.test(page.url() || '')) {
        await page.goto(LABOUR_URL, GOTO_OPTS);
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1200);
    }
    await assertMacromatixAuthenticated(page, 'Store context check');

    const comboId = await findStoreComboId(page);
    if (comboId) {
        const text = await getStoreComboText(page, comboId);
        if (new RegExp(`(^|\\D)${want}(\\D|$)`).test(text || '')) {
            return {
                label: text.trim(),
                implicit: true,
                reason: 'already on store (labour combo)',
            };
        }
        let items = await readStoreComboItems(page, comboId);
        if (!items.length) {
            items = await openStoreComboAndReadItems(page, comboId);
        }
        if (items.length === 1 && storeNumberFromLabel(items[0].storeName) === want) {
            return {
                label: items[0].storeName,
                implicit: true,
                reason: 'single-store account (one combo option)',
            };
        }
        return null;
    }

    const hasStoreHint = await page.evaluate((w) => {
        const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
        return new RegExp(`\\b${w}\\b`).test(body.slice(0, 12000));
    }, want);
    if (hasStoreHint) {
        return {
            label: want,
            implicit: true,
            reason: 'single-store account (no picker)',
        };
    }

    if (/LabourScheduler/i.test(page.url() || '')) {
        return null;
    }

    return null;
}

/** Confirm the labour scheduler (or similar) shows the expected store number. */
async function verifyLabourStoreContext(page, storeNumber) {
    const want = String(storeNumber || '').replace(/[^0-9]/g, '');
    if (!want) return false;

    if (!/LabourScheduler/i.test(page.url() || '')) {
        await page.goto(LABOUR_URL, GOTO_OPTS);
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1200);
    }

    const comboId = await findStoreComboId(page);
    if (!comboId) {
        const hasStoreHint = await page.evaluate((w) => {
            const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
            return new RegExp(`\\b${w}\\b`).test(body.slice(0, 12000));
        }, want);
        return hasStoreHint;
    }
    const text = await getStoreComboText(page, comboId);
    return new RegExp(`(^|\\D)${want}(\\D|$)`).test(text || '');
}

/** Read every store on the post-login `#ddlStoreSelection` dropdown. */
async function listStoresOnLoginDropdown(page) {
    return page.evaluate(() => {
        const sel = document.querySelector('#ddlStoreSelection, select[name="ddlStoreSelection"]');
        if (!sel) return [];
        const out = [];
        for (const opt of sel.options) {
            const text = (opt.textContent || '').replace(/\s+/g, ' ').trim();
            if (!text || /^select store$/i.test(text)) continue;
            const m = text.match(/\b(\d{3,6})\b/);
            if (!m) continue;
            out.push({ storeNumber: m[1], storeName: text, optionValue: opt.value });
        }
        return out;
    });
}

/**
 * Throw if the browser was sent back to the logon page (bad credentials or expired session).
 */
async function assertMacromatixAuthenticated(page, context = 'Macromatix') {
    if (!(await isMacromatixLoginPage(page))) return;
    const loginError = await readMacromatixLoginError(page);
    const hint = 'Configure store logins in Admin menu → Setup Store Logins.';
    throw new Error(
        `${context}: not logged in${loginError ? ` - ${loginError}` : ''}. ${hint}`
    );
}

/** Log in on a fresh page (each isolated context needs its own session). */
async function loginPage(page, username, password) {
    const userLabel = maskUsernameForLog(username);
    console.log(`[Macromatix] Navigating to login (SelectStore) as ${userLabel}...`);
    await page.goto(SELECT_STORE_URL, LOGIN_GOTO_OPTS);

    if (await isLoginStorePickerPresent(page)) {
        const count = await waitForLoginStoreDropdownStable(page);
        console.log(`[Macromatix] Logged in (${count} stores on login picker)`);
        return;
    }

    await page.waitForSelector('#Login_UserName', { visible: true, timeout: 15000 });
    console.log(`[Macromatix] Logging in as ${userLabel}...`);
    await fillInputValue(page, '#Login_UserName', username);
    await fillInputValue(page, '#Login_Password', password);
    const loginButton = await page.$('input[type="submit"]');
    if (!loginButton) throw new Error('Login button not found');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
        loginButton.click(),
    ]);
    await page
        .waitForFunction(
            () => {
                if (document.querySelector('#ddlStoreSelection, select[name="ddlStoreSelection"]')) return true;
                if (/mode=SelectStore/i.test(location.search || '')) return true;
                return (
                    !/MMS_Logon\.aspx/i.test(location.pathname) &&
                    !document.querySelector('#Login_UserName')
                );
            },
            { timeout: 25000 }
        )
        .catch(() => {});
    if (await isMacromatixLoginPage(page)) {
        const loginError = await readMacromatixLoginError(page);
        throw new Error(
            loginError || 'Macromatix login failed. Check username and password in Admin → Setup Store Logins.'
        );
    }
    if (await isLoginStorePickerPresent(page)) {
        const count = await waitForLoginStoreDropdownStable(page);
        console.log(`[Macromatix] Logged in (${count} stores on login picker)`);
        return;
    }

    // Headless login sometimes skips SelectStore and lands on home - reopen the picker URL.
    if (!(await isMacromatixLoginPage(page))) {
        console.log('[Macromatix] Login skipped store picker; reopening SelectStore...');
        await page.goto(SELECT_STORE_URL, LOGIN_GOTO_OPTS);
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(800);
        if (await isLoginStorePickerPresent(page)) {
            const count = await waitForLoginStoreDropdownStable(page);
            console.log(`[Macromatix] Logged in (${count} stores on login picker)`);
            return;
        }
    }

    console.log('[Macromatix] Logged in (no store picker - single-store account?)');
}

const LOGOUT_URL_CANDIDATES = [
    `${BASE_URL}MMS_Logon.aspx?SignOut=1`,
    `${BASE_URL}MMS_Logon.aspx?logout=1`,
    `${BASE_URL}MMS_Logon.aspx`,
];

/** End the Macromatix session so the next store can log in fresh (single-store accounts). */
async function logoutPage(page) {
    const clicked = await page
        .evaluate(() => {
            for (const el of document.querySelectorAll('a, input[type="submit"], button, span')) {
                const t = (el.textContent || el.value || '').trim();
                if (/^(log\s*off|logout|sign\s*out)$/i.test(t)) {
                    el.click();
                    return t;
                }
            }
            return null;
        })
        .catch(() => null);

    if (clicked) {
        console.log(`[Macromatix] Logged out via "${clicked}"`);
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(600);
    } else {
        for (const url of LOGOUT_URL_CANDIDATES) {
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            } catch {
                /* try next */
            }
            if (await isMacromatixLoginPage(page)) {
                console.log('[Macromatix] Logged out via URL');
                break;
            }
        }
    }

    try {
        const client = await page.createCDPSession();
        await client.send('Network.clearBrowserCookies');
    } catch {
        /* ignore */
    }
}

/**
 * Post-login store picker - login dropdown, then labour scheduler combo (full store list),
 * then Change Store SPA for accounts that only expose stores there.
 */
async function selectStoreAfterLogin(page, storeNumber, credentials) {
    const target = String(storeNumber || '').trim();
    const want = target.replace(/\D/g, '');
    if (!want) throw new Error('Store number required after login');

    const cachedAccessible = accessibleStoresByCredential.get(credentialCacheKey(credentials));
    if (cachedAccessible && cachedAccessible.size > 0 && !cachedAccessible.has(want)) {
        throw new StoreInaccessibleError(target, buildStoreInaccessibleMessage(target, cachedAccessible));
    }

    let pickedLogin = null;
    for (let attempt = 0; attempt < 3 && !pickedLogin; attempt++) {
        if (attempt > 0) {
            console.log(`[Macromatix] Retrying login store picker for ${target} (attempt ${attempt + 1})`);
            await page.waitForTimeout(800);
        }
        pickedLogin = await selectStoreOnLoginDropdown(page, target);
    }
    if (pickedLogin) {
        console.log(`[Macromatix] Post-login store selected (login dropdown): ${target}`);
        return pickedLogin;
    }

    const pickerPresent = await isLoginStorePickerPresent(page);
    if (!pickerPresent) {
        await ensureLoginStorePickerPage(page);
    }
    let loginNums = [];
    const hasLoginDropdown = await isLoginStorePickerPresent(page);
    if (hasLoginDropdown) {
        await waitForLoginStoreDropdownStable(page);
        const available = await listStoresOnLoginDropdown(page);
        loginNums = available.map((s) => s.storeNumber);
        const nums = loginNums.join(', ') || '(none parsed)';
        if (loginNums.includes(want)) {
            throw new Error(
                `Store ${target} is on the login picker but could not be selected. Available: ${nums}`
            );
        }
        console.log(
            `[Macromatix] Store ${target} not on login picker (${available.length} stores: ${nums}); trying labour scheduler`
        );
    }

    const implicit = await tryImplicitSingleStoreContext(page, target);
    if (implicit) {
        console.log(`[Macromatix] Post-login store context (${implicit.reason}): ${target}`);
        return implicit;
    }

    if (!/LabourScheduler/i.test(page.url() || '')) {
        await page.goto(LABOUR_URL, GOTO_OPTS);
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(1200);
    }
    await assertMacromatixAuthenticated(page, 'Store selection');

    const pickedOnLabour = await selectStoreOnPage(page, target);
    if (pickedOnLabour) {
        console.log(`[Macromatix] Post-login store selected (labour scheduler): ${target}`);
        await waitForStoreSelectionPostback(page);
        return pickedOnLabour;
    }

    let labourNums = [];
    try {
        const labourStores = await enumerateStores(page);
        labourNums = labourStores.map((s) => s.storeNumber);
        if (labourStores.length && !labourNums.includes(want)) {
            console.log(
                `[Macromatix] Store ${target} not on labour scheduler (${labourNums.join(', ')}); trying Change Store SPA`
            );
        }
    } catch {
        /* ignore */
    }

    const {
        CHANGE_STORE_URL,
        ensureSpaAuthenticated,
        listStoresOnChangeStorePage,
        selectStoreOnSpa,
    } = require('./sssg/sssgScraper');

    await page.goto(CHANGE_STORE_URL, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(1200);
    await ensureSpaAuthenticated(page, credentials);

    const listed = await listStoresOnChangeStorePage(page);
    const spaNums = listed.map((s) => s.storeNumber);
    const knownLists = [loginNums, labourNums, spaNums].filter((nums) => nums.length > 0);
    const inAnyList = knownLists.some((nums) => nums.includes(want));
    if (knownLists.length > 0 && !inAnyList) {
        const parts = [];
        if (loginNums.length) parts.push(`login picker: ${loginNums.join(', ')}`);
        if (labourNums.length) parts.push(`labour: ${labourNums.join(', ')}`);
        if (spaNums.length) parts.push(`change store: ${spaNums.join(', ')}`);
        throw new StoreInaccessibleError(target, parts.join('; '));
    }

    try {
        await selectStoreOnSpa(page, target);
        console.log(`[Macromatix] Post-login store selected (SPA): ${target}`);
        return target;
    } catch (spaErr) {
        const picked = await selectStoreOnPage(page, target);
        if (picked) {
            console.log(`[Macromatix] Post-login store selected (ASP.NET fallback): ${picked}`);
            await waitForStoreSelectionPostback(page);
            return picked;
        }
        if (knownLists.length > 0 && !inAnyList) {
            throw new StoreInaccessibleError(target, spaErr.message);
        }
        throw spaErr;
    }
}

/** Attach SSSG percent to a scrape result when LY slots are available. */
function attachSssgToResult(result, _todayKey) {
    if (!result || result.error) return result;
    try {
        const { computeSssgPercent } = require('../../dashboard/src/sssg/sssgCalc');
        const { getCachedSssgLy, sssgDateKeyForStore } = require('../../dashboard/src/sssg/sssgCache');
        const cfg = getStoreConfig(result.storeNumber);
        const timeZone = cfg?.timeZone || DASHBOARD_TIME_ZONE;
        const dateKey = sssgDateKeyForStore(result.storeNumber);
        const slots = getCachedSssgLy(result.storeNumber, dateKey);
        result.sssgPercent = computeSssgPercent({
            slots,
            actual: result.actual,
            forecast: result.forecast,
            openHour: result.openHour,
            closeHour: result.closeHour,
            timeZone,
            storeNumber: result.storeNumber,
        });
        if (result.sssgPercent != null) {
            console.log(`[Macromatix] Store ${result.storeNumber} SSSG: ${result.sssgPercent}%`);
        }
    } catch (err) {
        console.warn(`[Macromatix] Store ${result.storeNumber} SSSG compute failed:`, err.message);
    }
    return result;
}

/**
 * One isolated login session: pick store → sales + vendors → logout.
 * SSSG Last Year is scraped in one shared SPA pass after all stores (see runBatchSssgLyScrape).
 */
async function scrapeSingleStoreSession(page, store, ctx, credentials) {
    const storeNumber = String(store.storeNumber || '').trim();

    const pick = await selectStoreAfterLogin(page, storeNumber, credentials);
    const pickMeta = normalizeStorePickResult(pick);

    if (!pickMeta.implicit) {
        const onCorrectStore = await verifyLabourStoreContext(page, storeNumber);
        if (!onCorrectStore) {
            throw new Error(
                `Labour scheduler is not showing store ${storeNumber} after login store selection`
            );
        }
    } else {
        console.log(
            `[Macromatix] Store ${storeNumber}: implicit login context (${pickMeta.reason})`
        );
    }

    const result = await scrapeStoreData(page, store, ctx, { skipStoreSelect: true });
    await logoutPage(page);
    return result;
}

/** One login → loop Change Store in SPA for all stores needing LY → logout. */
async function runBatchSssgLyScrape(browser, stores, _todayKey, credentials) {
    const {
        needsSssgLyScrape,
        hasSssgLyCachedToday,
        setCachedSssgLy,
        loadSssgLyFromDisk,
        sssgDateKeyForStore,
    } = require('../../dashboard/src/sssg/sssgCache');
    const { scrapeSssgLastYearAllStores } = require('./sssg/sssgScraper');

    for (const store of stores) {
        loadSssgLyFromDisk(store.storeNumber, sssgDateKeyForStore(store));
    }

    if (!needsSssgLyScrape(stores)) return;

    const storesNeedingLy = stores.filter(
        (s) => !hasSssgLyCachedToday(s.storeNumber, sssgDateKeyForStore(s))
    );
    if (!storesNeedingLy.length) return;

    console.log(
        `[Macromatix] Batch SSSG Last Year scrape for ${storesNeedingLy.length} store(s) in one SPA session...`
    );

    let context;
    let lyPage;
    try {
        context = await createIsolatedContext(browser);
        lyPage = await context.newPage();
        await lyPage.setViewport({ width: 1280, height: 720 });
        await applyResourceBlocking(lyPage);
        await loginPage(lyPage, credentials.username, credentials.password);
        await selectStoreOnLoginDropdown(lyPage, storesNeedingLy[0].storeNumber);

        const lyResults = await scrapeSssgLastYearAllStores(lyPage, storesNeedingLy, { credentials });
        for (const r of lyResults) {
            if (r.slots?.length) {
                setCachedSssgLy(r.storeNumber, sssgDateKeyForStore(r.storeNumber), r.slots);
            }
        }
    } catch (err) {
        console.warn('[Macromatix] Batch SSSG LY scrape failed:', err.message);
    } finally {
        if (lyPage) {
            try {
                await logoutPage(lyPage);
            } catch {
                /* ignore */
            }
        }
        if (context) {
            try {
                await context.close();
            } catch {
                /* ignore */
            }
        }
    }
}

/**
 * Verify Macromatix username/password (opens browser, attempts login, closes).
 * Used when creating store sub-accounts with their own Key Item Count credentials.
 */
async function verifyMacromatixLogin(username, password) {
    const mmxUser = String(username || '').trim();
    const mmxPass = String(password || '');
    if (!mmxUser || !mmxPass) {
        return { ok: false, error: 'Macromatix username and password are required.' };
    }

    let browser;
    try {
        browser = await puppeteer.launch(getPuppeteerLaunchOptions({ skipSlowMo: true }));
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await applyResourceBlocking(page);
        try {
            await loginPage(page, mmxUser, mmxPass);
        } catch (loginErr) {
            return {
                ok: false,
                error: loginErr.message || 'Macromatix login failed. Check username and password.',
            };
        }

        const stillOnLogin = await page.$('#Login_UserName');
        const loginError = await page
            .evaluate(() => {
                const el = document.querySelector(
                    '.validation-summary-errors, #FailureText, .failureNotification, span[style*="color: red"]'
                );
                return el ? String(el.textContent || '').trim() : '';
            })
            .catch(() => '');

        if (stillOnLogin) {
            return {
                ok: false,
                error: loginError || 'Macromatix login failed. Check username and password.',
            };
        }

        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message || 'Could not reach Macromatix.' };
    } finally {
        await closeBrowserQuietly(browser, 'mmx-login-verify');
    }
}

/**
 * Macromatix logins from per-store encrypted files (Admin → Setup Store Logins).
 */
function collectStoreMmxCredentials(storeNumber) {
    const { listCredentialCandidates } = require('../../stores/src/storeCredentials');
    return listCredentialCandidates(storeNumber, 'mmx').map((entry) => ({
        username: entry.username,
        password: entry.password,
        source: entry.source,
        updatedBy: entry.updatedBy || '',
    }));
}

function storeHasMmxCredentials(storeNumber) {
    const { storeHasServiceCredentials } = require('../../stores/src/storeCredentials');
    return storeHasServiceCredentials(storeNumber, 'mmx');
}

const STORE_LOGIN_SETUP_HINT =
    'Configure Macromatix login in Admin menu → Setup Store Logins for this store.';

/**
 * Resolve Macromatix login candidates for a store (primary, then user-added fallbacks).
 */
function listMacromatixCredentialCandidatesForStore(storeNumber, options = {}) {
    void options;
    const store = String(storeNumber || '').trim().replace(/\D/g, '');
    const candidates = collectStoreMmxCredentials(store).map((entry) => ({
        username: entry.username,
        password: entry.password,
        source: entry.source,
    }));
    if (!candidates.length) {
        throw new Error(`No Macromatix login for store ${store}. ${STORE_LOGIN_SETUP_HINT}`);
    }
    return candidates;
}

function resolveMacromatixCredentialsForStore(storeNumber, options = {}) {
    void options;
    const store = String(storeNumber || '').trim().replace(/\D/g, '');
    const candidates = listMacromatixCredentialCandidatesForStore(storeNumber, options);
    const picked = candidates[0];
    console.log(
        `[Macromatix] Store ${store}: using store login via ${picked.source} (${maskUsernameForLog(picked.username)})`
    );
    return picked;
}

function resolveMacromatixCredentials(options = {}) {
    const storeNumber = String(options.storeNumber || '').trim();
    const oneTimeUser = String(options.mmxUsername || options.username || '').trim();
    const oneTimePass = String(options.mmxPassword ?? options.password ?? '');
    if (oneTimeUser && oneTimePass) {
        return {
            username: oneTimeUser,
            password: oneTimePass,
            source: options.mmxUsername || options.mmxPassword ? 'one-time session' : 'explicit options',
        };
    }

    if (options.useDashboardUserMmx && options.dashboardUsername) {
        const { readMmxCredentialsForUser } = require('../../users/src/core/mmxUserCredentials');
        const userCreds = readMmxCredentialsForUser(options.dashboardUsername);
        if (userCreds?.username && userCreds?.password) {
            console.log(
                `[Macromatix] Store ${storeNumber || '-'}: using crew login for ${options.dashboardUsername} (${maskUsernameForLog(userCreds.username)})`
            );
            return {
                username: userCreds.username,
                password: userCreds.password,
                source: `user-mmx/${options.dashboardUsername}`,
            };
        }
        if (options.requireDashboardUserMmx) {
            throw new Error(
                'Your Macromatix login is not set up. Enter your MMX username and password when sending to Macromatix.'
            );
        }
    }

    if (storeNumber) {
        const perStore = resolveMacromatixCredentialsForStore(storeNumber, options);
        return {
            username: perStore.username,
            password: perStore.password,
            source: perStore.source || 'store-logins/mmx',
        };
    }
    throw new Error(`Macromatix credentials require a store number. ${STORE_LOGIN_SETUP_HINT}`);
}

/** Placeholder result used when a single store's scrape throws - keeps the store in the payload. */
function buildErrorResult(store, err, todayKey) {
    const hours = resolveStoreHours(store, store.storeNumber);
    return {
        storeNumber: store.storeNumber || '',
        storeName: store.storeName || store.storeNumber || '',
        openHour: hours.openHour,
        closeHour: hours.closeHour,
        actual: [],
        forecast: [],
        pendingVendors: getLastKnownPendingVendors(store.storeNumber, todayKey),
        error: err.message,
    };
}

/** Create an isolated (incognito-style) browser context, across Puppeteer versions. */
function createIsolatedContext(browser) {
    const fn = browser.createBrowserContext || browser.createIncognitoBrowserContext;
    return fn.call(browser);
}

function groupStoresByMacromatixCredentials(stores, resolvedCredMap = null) {
    const groups = new Map();
    for (const store of stores) {
        const fromMap = resolvedCredMap?.get(store.storeNumber);
        const resolved =
            fromMap ||
            resolveMacromatixCredentialsForStore(store.storeNumber);
        const key = `${resolved.username}\0${resolved.password}`;
        if (!groups.has(key)) {
            groups.set(key, {
                credentials: { username: resolved.username, password: resolved.password },
                source: resolved.source || 'global SCRAPER_*',
                stores: [],
            });
        }
        groups.get(key).stores.push(store);
    }
    return [...groups.values()];
}

async function scrapeStoreWithCredentialCandidates(browser, store, ctx, candidates) {
    const label = store.storeNumber || '(default)';
    const want = normalizeStoreNumberKey(store.storeNumber);
    const tries = Array.isArray(candidates) && candidates.length
        ? candidates
        : listMacromatixCredentialCandidatesForStore(store.storeNumber);
    let lastErr;

    for (let attempt = 0; attempt < tries.length; attempt++) {
        const resolved = tries[attempt];
        const storeCreds = { username: resolved.username, password: resolved.password };
        const accessible = await getAccessibleStoreNumbersForCredentials(browser, storeCreds);
        if (accessible && want && !accessible.has(want)) {
            lastErr = new StoreInaccessibleError(
                label,
                buildStoreInaccessibleMessage(label, accessible)
            );
            continue;
        }
        let context;
        try {
            if (tries.length > 1 || resolved.source !== 'global SCRAPER_*') {
                console.log(
                    `[Macromatix] Store ${label}: trying ${resolved.source} (${resolved.username})`
                );
            }
            context = await createIsolatedContext(browser);
            const workerPage = await context.newPage();
            await workerPage.setViewport({ width: 1280, height: 720 });
            await applyResourceBlocking(workerPage);
            await loginPage(workerPage, storeCreds.username, storeCreds.password);
            const result = await scrapeSingleStoreSession(workerPage, store, ctx, storeCreds);
            if (attempt > 0 || tries.length > 1) {
                console.log(`[Macromatix] Store ${label}: succeeded via ${resolved.source}`);
            }
            return {
                result,
                credentials: storeCreds,
                source: resolved.source,
            };
        } catch (err) {
            lastErr = err;
            const hasMore = attempt < tries.length - 1;
            if (!isStoreInaccessibleError(err) || hasMore) {
                console.warn(
                    `[Macromatix] Store ${label}: ${resolved.source} failed - ${err.message}${
                        hasMore ? ' - trying next login' : ''
                    }`
                );
            }
        } finally {
            if (context) {
                try {
                    await context.close();
                } catch {
                    /* ignore */
                }
            }
        }
    }

    if (isStoreInaccessibleError(lastErr)) {
        throw lastErr;
    }
    throw lastErr || new Error(`No Macromatix credentials available for store ${label}`);
}

function resolveStoreFilterNumbers(options = {}) {
    const nums = [];
    if (Array.isArray(options.storeNumbers)) {
        for (const n of options.storeNumbers) {
            const s = String(n || '').trim();
            if (s) nums.push(s);
        }
    }
    const onlyStore = String(options.storeNumber || '').trim();
    if (onlyStore) nums.push(onlyStore);
    return [...new Set(nums)];
}

function filterStoresByNumbers(stores, filterNums) {
    if (!filterNums.length) return stores;
    const set = new Set(filterNums.map(String));
    const filtered = stores.filter((s) => set.has(String(s.storeNumber)));
    const found = new Set(filtered.map((s) => String(s.storeNumber)));
    for (const num of filterNums) {
        if (!found.has(num)) {
            filtered.push(getStoreConfig(num) || { storeNumber: num, storeName: '' });
        }
    }
    return filtered;
}

/**
 * Taco Bell AU Macromatix - for every store the account can access: labour scheduler (hourly sales) +
 * scheduled orders (pending vendor labels). Returns `{ success, timestamp, stores: [...] }`.
 */
async function scrapeMacromatix(options = {}) {
    clearAccessibleStoresDiscoveryCache();
    const todayKey = dashboardDateKey();
    const pickYmd = options.scheduledOrdersPickYmd;
    const testScheduledOrdersPick =
        pickYmd &&
        Number.isFinite(pickYmd.year) &&
        Number.isFinite(pickYmd.month) &&
        Number.isFinite(pickYmd.day);
    const skipScheduledPersistence = Boolean(options.skipScheduledOrdersPersistence);
    const storeFilter = resolveStoreFilterNumbers(options);
    const onlyStore = storeFilter.length === 1 ? storeFilter[0] : '';

    const respectScrapeSchedule = !testScheduledOrdersPick && !options.bypassScrapeSchedule;
    let prelistedStores = getStoreList();
    if (storeFilter.length && prelistedStores.length) {
        prelistedStores = filterStoresByNumbers(prelistedStores, storeFilter);
    }
    if (respectScrapeSchedule && prelistedStores.length) {
        const activeStores = prelistedStores.filter((s) => getStoreScrapePhase(s) === 'active');
        const skipped = prelistedStores.filter((s) => getStoreScrapePhase(s) !== 'active');
        for (const s of skipped) {
            console.log(
                `[Macromatix] Store ${s.storeNumber} outside scrape window (${getStoreScrapePhase(s)}) - ${formatScrapeWindow(s)}`
            );
        }
        if (!activeStores.length) {
            console.log('[Macromatix] No stores in active scrape window - skipping browser session');
            return {
                success: true,
                timestamp: new Date().toISOString(),
                stores: [],
                scrapeSkipped: true,
            };
        }
    }

    let browser;
    try {
        const launchOpts = getPuppeteerLaunchOptions(options.launchOptions || {});
        if (!launchOpts.headless) {
            console.log('[Macromatix] Visible browser (SCRAPER_HEADLESS=false/0); use SCRAPER_SLOW_MO_MS only when debugging');
        }
        browser = await puppeteer.launch(launchOpts);
        if (typeof options.onBrowser === 'function') {
            options.onBrowser(browser);
        }

        const singleStoreLogin = useSingleStoreLoginMode();
        if (!singleStoreLogin) {
            console.warn(
                '[Macromatix] Shared-session mode (SCRAPER_SINGLE_STORE_LOGIN=0) is deprecated. Using per-store login mode.'
            );
        }

        // `.storelist` is the master list of stores to scrape.
        let stores = getStoreList();
        if (stores.length) {
            console.log(
                `[Macromatix] Store list (.storelist) - ${stores.length}:`,
                stores.map((s) => s.storeNumber).join(', ')
            );
        } else {
            throw new Error(
                'Single-store login mode requires .storelist. Configure stores and per-store Macromatix logins in Admin → Setup Store Logins.'
            );
        }

        if (storeFilter.length) {
            stores = filterStoresByNumbers(stores, storeFilter);
            if (storeFilter.length === 1) {
                console.log(`[Macromatix] Restricting scrape to store ${storeFilter[0]}`);
            } else {
                console.log(
                    `[Macromatix] Restricting scrape to ${stores.length} store(s):`,
                    storeFilter.join(', ')
                );
            }
        }

        if (respectScrapeSchedule) {
            const activeStores = stores.filter((s) => getStoreScrapePhase(s) === 'active');
            const skipped = stores.filter((s) => getStoreScrapePhase(s) !== 'active');
            if (skipped.length) {
                for (const s of skipped) {
                    const phase = getStoreScrapePhase(s);
                    console.log(
                        `[Macromatix] Store ${s.storeNumber} outside scrape window (${phase}) - ${formatScrapeWindow(s)}`
                    );
                }
            }
            if (!activeStores.length) {
                console.log('[Macromatix] No stores in active scrape window - skipping remaining scrape');
                await closeBrowserQuietly(browser, 'schedule idle');
                browser = null;
                return {
                    success: true,
                    timestamp: new Date().toISOString(),
                    stores: [],
                    scrapeSkipped: true,
                };
            }
            stores = activeStores;
            console.log(
                `[Macromatix] Scraping ${stores.length} store(s) in active window:`,
                stores.map((s) => s.storeNumber).join(', ')
            );
        }

        if (useSingleStoreLoginMode()) {
            const withCreds = stores.filter((s) => storeHasMmxCredentials(s.storeNumber));
            const missing = stores.length - withCreds.length;
            if (missing > 0) {
                console.log(
                    `[Macromatix] Skipping ${missing} store(s) with no Macromatix login (Admin → Setup Store Logins)`
                );
            }
            stores = withCreds;
            if (!stores.length) {
                console.log('[Macromatix] No stores with Macromatix logins - skipping scrape');
                await closeBrowserQuietly(browser, 'no mmx logins');
                browser = null;
                return {
                    success: true,
                    timestamp: new Date().toISOString(),
                    stores: [],
                    scrapeSkipped: true,
                };
            }
        }

        const ctx = { todayKey, testScheduledOrdersPick, pickYmd, skipScheduledPersistence };
        const results = new Array(stores.length);
        let nextIndex = 0;
        const takeNext = () => (nextIndex < stores.length ? nextIndex++ : -1);
        const concurrency = getScraperConcurrency(stores.length);

        console.log(
            `[Macromatix] Per-store login mode - ${stores.length} store(s), concurrency ${concurrency} (login → select → scrape → logout per store)`
        );

        const storeSuccessfulCreds = new Map();

        const runSingleStoreWorker = async (workerId) => {
            for (;;) {
                throwIfSalesScrapeAborted();
                const i = takeNext();
                if (i < 0) break;
                const store = stores[i];
                const label = store.storeNumber || '(default)';
                try {
                    const candidates = listMacromatixCredentialCandidatesForStore(store.storeNumber);
                    const scraped = await scrapeStoreWithCredentialCandidates(
                        browser,
                        store,
                        ctx,
                        candidates
                    );
                    results[i] = scraped.result;
                    storeSuccessfulCreds.set(store.storeNumber, {
                        credentials: scraped.credentials,
                        source: scraped.source,
                    });
                } catch (storeErr) {
                    if (storeErr?.aborted) throw storeErr;
                    if (isStoreInaccessibleError(storeErr)) {
                        results[i] = null;
                        continue;
                    }
                    console.error(
                        `[Macromatix] Worker ${workerId} store ${label} failed:`,
                        storeErr.message
                    );
                    results[i] = buildErrorResult(store, storeErr, todayKey);
                }
            }
        };

        const workers = [];
        for (let w = 0; w < concurrency; w++) {
            workers.push(runSingleStoreWorker(w));
        }
        await Promise.all(workers);

        throwIfSalesScrapeAborted();

        const credGroups = groupStoresByMacromatixCredentials(
            stores.filter((s) => storeSuccessfulCreds.has(s.storeNumber)),
            new Map(
                [...storeSuccessfulCreds.entries()].map(([storeNumber, row]) => [
                    storeNumber,
                    { ...row.credentials, source: row.source },
                ])
            )
        );
        for (const group of credGroups) {
            console.log(
                `[Macromatix] SSSG LY batch (${group.stores.length} store(s)) via ${group.source} (${group.credentials.username})`
            );
            await runBatchSssgLyScrape(browser, group.stores, todayKey, group.credentials);
        }
        for (const result of results) {
            attachSssgToResult(result, todayKey);
        }

        summarizeInaccessibleStores(stores, results);

        await closeBrowserQuietly(browser, 'normal completion');
        browser = null;

        const scrapedStores = results.filter((r) => r != null);
        return {
            success: true,
            timestamp: new Date().toISOString(),
            stores: scrapedStores,
        };
    } catch (error) {
        await closeBrowserQuietly(browser, 'error cleanup');
        if (error?.aborted || isSalesScrapeAbortRequested()) {
            throw error?.aborted ? error : new MmxWorkAbortedError('Sales scrape aborted - stock count / orders in progress');
        }
        console.error('[Macromatix] Error:', error.message);
        throw error;
    }
}

/**
 * Discovery helper: log in and return every store the account can access, as
 * `[{ storeNumber, storeName }]`. Used by `npm run list-stores` to build `.storelist`.
 * Does NOT use `.storelist` (it ignores it on purpose, so you can see the full account).
 */
async function listStores() {
    const storeList = getStoreList();
    if (!storeList.length) {
        throw new Error('No stores in .storelist. Add stores before listing Macromatix access.');
    }
    const firstStore = storeList[0].storeNumber;
    const { username, password } = resolveMacromatixCredentialsForStore(firstStore);

    let browser;
    try {
        browser = await puppeteer.launch(getPuppeteerLaunchOptions());
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await applyResourceBlocking(page);

        await loginPage(page, username, password);

        console.log('[Macromatix] Opening labour scheduler to enumerate stores...');
        await page.goto(LABOUR_URL, GOTO_OPTS);
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});

        const stores = await enumerateStores(page);
        return stores.map((s) => ({ storeNumber: s.storeNumber, storeName: s.storeName }));
    } finally {
        await closeBrowserQuietly(browser, 'list-stores');
    }
}

async function submitStockCountToMacromatix(page, storeNumber, vendorSlug, aggregatedPayload) {
    void aggregatedPayload;
    const { sendStockCountToMmx } = require('./stockCountMmxPipeline');
    return sendStockCountToMmx(storeNumber, vendorSlug, page ? { page, browser: null } : {});
}

/** Launch Puppeteer, log in, and return `{ browser, page }` for one-off automation (e.g. report downloads). */
async function openMacromatixBrowser(options = {}) {
    const storeNumber = String(options.storeNumber || '').trim();
    const { username, password, source } = resolveMacromatixCredentials(options);
    if (!String(username || '').trim() || !String(password || '').trim()) {
        const storeHint = storeNumber
            ? ` Configure Macromatix login in Admin menu → Setup Store Logins for store ${storeNumber}.`
            : ` ${STORE_LOGIN_SETUP_HINT}`;
        throw new Error(`Macromatix credentials are not configured.${storeHint}`);
    }
    if (
        /^your-/i.test(String(username || '').trim()) ||
        /^your-/i.test(String(password || '').trim()) ||
        /^change-this/i.test(String(username || '').trim())
    ) {
        throw new Error(`Macromatix credentials are placeholders.${STORE_LOGIN_SETUP_HINT}`);
    }

    console.log(
        `[Macromatix] Opening browser${storeNumber ? ` for store ${storeNumber}` : ''} via ${source || 'unknown'} as ${maskUsernameForLog(username)}`
    );

    const launchOpts = getPuppeteerLaunchOptions({
        ...(options.browserOptions || options.launchOptions || {}),
        skipSlowMo: options.browserOptions?.skipSlowMo ?? options.launchOptions?.skipSlowMo,
    });
    const browser = await puppeteer.launch(launchOpts);
    if (!launchOpts.headless) {
        console.log('[Macromatix] Visible browser - watch for Edge/Chrome window (headed mode)');
    }
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await applyResourceBlocking(page);
    await loginPage(page, username, password);
    if (storeNumber) {
        const pick = await selectStoreAfterLogin(page, storeNumber, { username, password });
        const pickMeta = normalizeStorePickResult(pick);
        console.log(
            `[Macromatix] Browser ready for store ${storeNumber}${
                pickMeta.implicit ? ` (${pickMeta.reason})` : pickMeta.label ? `: ${pickMeta.label}` : ''
            }`
        );
    }
    if (typeof options.onBrowser === 'function') {
        options.onBrowser(browser);
    }
    return { browser, page };
}

module.exports = scrapeMacromatix;
module.exports.listStores = listStores;
module.exports.submitStockCountToMacromatix = submitStockCountToMacromatix;
module.exports.openMacromatixBrowser = openMacromatixBrowser;
module.exports.verifyMacromatixLogin = verifyMacromatixLogin;
module.exports.resolveMacromatixCredentials = resolveMacromatixCredentials;
module.exports.resolveMacromatixCredentialsForStore = resolveMacromatixCredentialsForStore;
module.exports.listMacromatixCredentialCandidatesForStore = listMacromatixCredentialCandidatesForStore;
module.exports.collectStoreMmxCredentials = collectStoreMmxCredentials;
module.exports.storeHasMmxCredentials = storeHasMmxCredentials;
module.exports.loginPage = loginPage;
module.exports.logoutPage = logoutPage;
module.exports.selectStoreAfterLogin = selectStoreAfterLogin;
module.exports.selectStoreOnLoginDropdown = selectStoreOnLoginDropdown;
module.exports.listStoresOnLoginDropdown = listStoresOnLoginDropdown;
module.exports.useSingleStoreLoginMode = useSingleStoreLoginMode;
module.exports.assertMacromatixAuthenticated = assertMacromatixAuthenticated;
module.exports.isMacromatixLoginPage = isMacromatixLoginPage;
module.exports.closeBrowserQuietly = closeBrowserQuietly;
module.exports.getPuppeteerLaunchOptions = getPuppeteerLaunchOptions;
module.exports.applyResourceBlocking = applyResourceBlocking;
module.exports.probePendingOrdersForStores = probePendingOrdersForStores;
module.exports.selectStoreOnPage = selectStoreOnPage;
module.exports.setScheduledOrdersToYmd = setScheduledOrdersToYmd;
module.exports.openDayViewAndReadSales = openDayViewAndReadSales;
module.exports.confirmStoreContextOnPage = confirmStoreContextOnPage;
module.exports.resolveStoreOnCurrentPage = resolveStoreOnCurrentPage;
module.exports.getLastKnownPendingVendors = getLastKnownPendingVendors;
module.exports.onStoreOrdersComplete = onStoreOrdersComplete;
module.exports.isScheduledOrdersCompleteToday = isScheduledOrdersCompleteToday;
module.exports.clearStoreScrapeCaches = clearStoreScrapeCaches;
module.exports.resetScheduledOrdersForNewDay = resetScheduledOrdersForNewDay;
module.exports.resetSssgForNewDay = (storeNumber) => {
    try {
        require('../../dashboard/src/sssg/sssgCache').resetSssgForNewDay(storeNumber);
    } catch {
        /* ignore */
    }
};
module.exports.getCachedSssgLy = (storeNumber, dateKey) => {
    try {
        return require('../../dashboard/src/sssg/sssgCache').getCachedSssgLy(storeNumber, dateKey);
    } catch {
        return null;
    }
};
