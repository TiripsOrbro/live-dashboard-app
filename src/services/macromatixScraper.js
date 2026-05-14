const crypto = require('crypto');
const fs = require('fs');
const puppeteer = require('puppeteer');

const BASE_URL = 'https://tacobellau.macromatix.net/';
const LABOUR_URL = 'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249';
const SCHEDULED_ORDERS_URL = 'https://tacobellau.macromatix.net/mms_stores_scheduledorders.aspx';

/** `networkidle2` often never resolves on Macromatix (long-polling / beacons). */
const GOTO_OPTS = { waitUntil: 'load', timeout: 45000 };
const DASHBOARD_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';
const CONFIRMED_EMPTY_ORDER_CHECKS = Number(process.env.CONFIRMED_EMPTY_ORDER_CHECKS || 2);

let forecastCache = { dateKey: null, values: null };
let scheduledOrdersCompleteDateKey = null;
let scheduledOrdersEmptyCheck = { dateKey: null, count: 0 };
let lastKnownPendingVendors = { dateKey: null, values: [] };

function decryptCredentialPayload(encryptedPayload, keyText) {
    if (!encryptedPayload || !keyText) return null;

    const key = crypto.createHash('sha256').update(String(keyText)).digest();
    const parsed = JSON.parse(Buffer.from(String(encryptedPayload), 'base64').toString('utf8'));
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(parsed.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'base64')),
        decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
}

function getMacromatixCredentials() {
    const encrypted = String(process.env.SCRAPER_CREDENTIALS_ENCRYPTED || '').trim();
    if (encrypted) {
        if (!String(process.env.SCRAPER_CREDENTIALS_KEY || '').trim()) {
            throw new Error('SCRAPER_CREDENTIALS_KEY is required when SCRAPER_CREDENTIALS_ENCRYPTED is set');
        }

        let decrypted;
        try {
            decrypted = decryptCredentialPayload(encrypted, process.env.SCRAPER_CREDENTIALS_KEY);
        } catch (e) {
            throw new Error(`Failed to decrypt SCRAPER_CREDENTIALS_ENCRYPTED: ${e.message}`);
        }
        return {
            username: decrypted && decrypted.username != null ? String(decrypted.username).trim() : '',
            password: decrypted && decrypted.password != null ? String(decrypted.password).trim() : '',
        };
    }

    return {
        username: String(process.env.SCRAPER_USERNAME || '').trim(),
        password: String(process.env.SCRAPER_PASSWORD || '').trim(),
    };
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

function getCachedForecastForToday(dateKey) {
    return forecastCache.dateKey === dateKey && Array.isArray(forecastCache.values) ? forecastCache.values : null;
}

function getConfirmedEmptyOrderChecks() {
    return Number.isFinite(CONFIRMED_EMPTY_ORDER_CHECKS) && CONFIRMED_EMPTY_ORDER_CHECKS > 0
        ? Math.floor(CONFIRMED_EMPTY_ORDER_CHECKS)
        : 2;
}

function getLastKnownPendingVendors(dateKey) {
    return lastKnownPendingVendors.dateKey === dateKey ? lastKnownPendingVendors.values : [];
}

function recordScheduledOrdersResult(dateKey, vendors) {
    lastKnownPendingVendors = { dateKey, values: vendors };

    if (vendors.length > 0) {
        scheduledOrdersEmptyCheck = { dateKey, count: 0 };
        scheduledOrdersCompleteDateKey = null;
        return;
    }

    const nextCount = scheduledOrdersEmptyCheck.dateKey === dateKey ? scheduledOrdersEmptyCheck.count + 1 : 1;
    scheduledOrdersEmptyCheck = { dateKey, count: nextCount };

    if (nextCount >= getConfirmedEmptyOrderChecks()) {
        scheduledOrdersCompleteDateKey = dateKey;
    }
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
 * Disabled — Macromatix default date on the page is enough for now.
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
    /* Day click often fires a full postback — wait for load before any further CDP ops or context is destroyed. */
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

/** Enter on the date box + click elsewhere to blur — same cues Macromatix often needs before the grid reloads. */
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
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/usr/bin/google-chrome-stable',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return undefined;
}

/** Visible window: set SCRAPER_HEADLESS to 0, false, no, or off. Optional SCRAPER_SLOW_MO_MS (ms), SCRAPER_DEVTOOLS=1 */
function getPuppeteerLaunchOptions() {
    const raw = process.env.SCRAPER_HEADLESS;
    const headless =
        raw === undefined || raw === ''
            ? true
            : !/^(0|false|no|off)$/i.test(String(raw).trim());
    const opts = {
        headless,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
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
    }
    const slowMo = Number(process.env.SCRAPER_SLOW_MO_MS);
    if (Number.isFinite(slowMo) && slowMo > 0) {
        opts.slowMo = slowMo;
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
 * Scheduled orders: Telerik RadDatePicker — calendar pick + Enter/blur, then `__doPostBack` via injected
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

    /** Date change is usually a partial postback — no document navigation, so `waitForNavigation` would idle until timeout (~30s). */
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
            if (/^[\s\-–—n\/\.a]*$/i.test(t.replace(/\s/g, ''))) return false;
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

/**
 * Taco Bell AU Macromatix — labour scheduler (hourly sales) + scheduled orders (pending vendor labels).
 */
async function scrapeMacromatix(options = {}) {
    const { username, password } = getMacromatixCredentials();
    const todayKey = dashboardDateKey();
    const cachedForecast = getCachedForecastForToday(todayKey);
    const pickYmd = options.scheduledOrdersPickYmd;
    const testScheduledOrdersPick =
        pickYmd &&
        Number.isFinite(pickYmd.year) &&
        Number.isFinite(pickYmd.month) &&
        Number.isFinite(pickYmd.day);
    const skipScheduledPersistence = Boolean(options.skipScheduledOrdersPersistence);

    if (!String(username || '').trim() || !String(password || '').trim()) {
        const hint =
            String(process.env.SCRAPER_CREDENTIALS_ENCRYPTED || '').trim()
                ? 'Check SCRAPER_CREDENTIALS_ENCRYPTED / SCRAPER_CREDENTIALS_KEY (decrypt failed or empty username/password).'
                : 'Set SCRAPER_USERNAME and SCRAPER_PASSWORD in .env or .env.production at the project root (both are loaded on startup).';
        throw new Error(`Macromatix scraper credentials are not configured. ${hint}`);
    }

    let browser;
    try {
        const launchOpts = getPuppeteerLaunchOptions();
        if (!launchOpts.headless) {
            console.log('[Macromatix] Visible browser (SCRAPER_HEADLESS=false/0); optional SCRAPER_SLOW_MO_MS, SCRAPER_DEVTOOLS=1');
        }
        browser = await puppeteer.launch(launchOpts);
        if (typeof options.onBrowser === 'function') {
            options.onBrowser(browser);
        }

        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        console.log('[Macromatix] Navigating to login...');
        await page.goto(BASE_URL, GOTO_OPTS);

        console.log('[Macromatix] Logging in...');
        await page.type('#Login_UserName', username);
        await page.type('#Login_Password', password);

        const loginButton = await page.$('input[type="submit"]');
        if (!loginButton) throw new Error('Login button not found');
        await loginButton.click();

        await page.waitForNavigation({ waitUntil: 'load', timeout: 45000 });
        console.log('[Macromatix] Logged in');

        console.log('[Macromatix] Opening labour scheduler...');
        await page.goto(LABOUR_URL, GOTO_OPTS);

        console.log('[Macromatix] Day view...');
        await page.waitForSelector(
            '#ctl00_ph_scheduleLabour_rdScheduler_C_rtbLabour > div > div > div > ul > li:nth-child(12) > a > span > span > span > span',
            { timeout: 5000 }
        );
        await page.click('#ctl00_ph_scheduleLabour_rdScheduler_C_rtbLabour > div > div > div > ul > li:nth-child(12) > a');

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
            { timeout: 10000 }
        );

        const salesData = await page.evaluate((shouldReadForecast) => {
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
            if (!actualRow || (shouldReadForecast && !forecastRow)) throw new Error('Sales data rows not found');

            return {
                actual: parseHourlyRow(actualRow),
                forecast: shouldReadForecast ? parseHourlyRow(forecastRow) : null,
            };
        }, !cachedForecast);

        if (cachedForecast) {
            salesData.forecast = cachedForecast;
        } else {
            forecastCache = { dateKey: todayKey, values: salesData.forecast };
        }

        console.log(
            '[Macromatix] actual hours:',
            salesData.actual.length,
            'forecast:',
            salesData.forecast.length,
            cachedForecast ? '(cached)' : '(fresh)'
        );

        let pendingVendors = [];
        const skipPendingForCompletedToday =
            !testScheduledOrdersPick && scheduledOrdersCompleteDateKey === todayKey;
        if (skipPendingForCompletedToday) {
            console.log('[Macromatix] Scheduled orders already complete today; skipping check');
            pendingVendors = getLastKnownPendingVendors(todayKey);
        } else {
            try {
                console.log('[Macromatix] Opening scheduled orders...');
                if (testScheduledOrdersPick) {
                    console.log(
                        '[Macromatix] Scheduled orders date pick (test):',
                        pickYmd.year,
                        pickYmd.month,
                        pickYmd.day
                    );
                }
                const pendingResult = await scrapePendingVendors(page, {
                    pickYmd: testScheduledOrdersPick ? pickYmd : null,
                });
                pendingVendors = pendingResult.vendors;
                console.log('[Macromatix] pending vendor labels:', pendingVendors.join(', ') || '(none)');
                console.log(
                    '[Macromatix] scheduled order tables:',
                    pendingResult.matchedTableCount,
                    'rows:',
                    pendingResult.dataRowCount
                );
                if (!skipScheduledPersistence) {
                    recordScheduledOrdersResult(todayKey, pendingVendors);
                }
            } catch (vendorErr) {
                console.warn('[Macromatix] Scheduled orders scrape failed:', vendorErr.message);
                pendingVendors = getLastKnownPendingVendors(todayKey);
            }
        }

        await closeBrowserQuietly(browser, 'normal completion');
        browser = null;

        return {
            success: true,
            actual: salesData.actual,
            forecast: salesData.forecast,
            timestamp: new Date().toISOString(),
            pendingVendors,
        };
    } catch (error) {
        await closeBrowserQuietly(browser, 'error cleanup');
        console.error('[Macromatix] Error:', error.message);
        throw error;
    }
}

module.exports = scrapeMacromatix;
