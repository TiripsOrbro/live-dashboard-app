const { closeBrowserQuietly } = require('../../mmx/src/macromatixScraper');
const {
    createAuthenticatedLifeLenzSession,
    parseStoreLabel,
    dedupeStores,
} = require('./lifelenzAuth');
const { aggregateDayPartsFromHourlyPlan, LIFELENZ_DAY_PARTS } = require('./lifelenzDayParts');

const SETTLE_MS = 800;
const DATE_SETTLE_MS = 2000;
const DAY_PART_INPUT_SELECTOR = 'input.forecast-adjustment.form-control, input.input-number.forecast-adjustment';
const DEFAULT_DAY_PART_INPUT_TIMEOUT_MS = 20000;
const DAY_PART_INPUT_COUNT = 9;
// Upper bound on the post-save reload wait. This is a cap, not a sleep: the
// settle logic polls for the inputs to return and finishes as soon as they do,
// so a generous cap only costs time on genuinely slow reloads.
const DEFAULT_QUIRK_RELOAD_MAX_MS = 15000;
const VERIFY_TIMEOUT_MS = 10000;
const WRITE_DAY_MAX_ATTEMPTS = 2;

/** True for puppeteer evaluate errors caused by an in-flight SPA navigation. */
function isDestroyedContextError(err) {
    return /context was destroyed|Execution context|Cannot find context/i.test(err?.message || '');
}

function resolveQuirkReloadMaxMs(options = {}) {
    if (Number.isFinite(options.quirkReloadMaxMs)) return options.quirkReloadMaxMs;
    const raw = process.env.LIFELENZ_QUIRK_RELOAD_MAX_MS;
    if (raw !== undefined && raw !== '') {
        const n = Number(raw);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return DEFAULT_QUIRK_RELOAD_MAX_MS;
}

function resolveFieldDelayMs(options = {}) {
    if (Number.isFinite(options.fieldDelayMs)) return options.fieldDelayMs;
    const headless = options.headless !== false;
    return headless ? 90 : 200;
}

function emitProgress(options, payload) {
    if (typeof options.onProgress === 'function') {
        options.onProgress({ platform: 'lifelenz', ...payload });
    }
}

async function clickByText(page, selectors, textPattern, options = {}) {
    const pattern = textPattern instanceof RegExp ? textPattern : new RegExp(String(textPattern), 'i');
    for (const selector of selectors) {
        const handles = await page.$$(selector);
        for (const handle of handles) {
            const text = await page.evaluate((el) => (el.textContent || '').replace(/\s+/g, ' ').trim(), handle);
            if (pattern.test(text)) {
                await handle.click();
                return true;
            }
        }
    }
    return page.evaluate((regexSource, flags) => {
        const pattern = new RegExp(regexSource, flags);
        for (const el of document.querySelectorAll('a, button, span, li, div[role="menuitem"], [role="option"]')) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!pattern.test(text)) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            el.click();
            return true;
        }
        return false;
    }, pattern.source, pattern.flags.replace('g', ''));
}

async function readCurrentStoreTriggerLabel(page) {
    return page.evaluate(() => {
        for (const el of document.querySelectorAll(
            'button[aria-haspopup="listbox"], button[aria-haspopup="menu"], [data-slot="trigger"], div.max-w-60'
        )) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^\d{4}\s*-\s*/.test(text)) return text;
        }
        return '';
    });
}

/** Poll until the store picker trigger shows the requested store. */
async function waitForStoreSelected(page, labelNeedle, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const current = await readCurrentStoreTriggerLabel(page).catch(() => '');
        if (current.startsWith(labelNeedle)) return true;
        await page.waitForTimeout(200);
    }
    return false;
}

async function selectStoreInLifeLenz(page, storeNumber) {
    const store = String(storeNumber || '').trim();
    const labelNeedle = `${store} -`;

    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(300);

    const current = await readCurrentStoreTriggerLabel(page);
    if (current.startsWith(labelNeedle)) return true;

    const storePattern = new RegExp(`\\b${store}\\s*-`, 'i');
    const triggers = [
        'button[aria-haspopup="listbox"]',
        'button[aria-haspopup="menu"]',
        '[data-slot="trigger"]',
        'div.max-w-60',
    ];
    for (const selector of triggers) {
        const el = await page.$(selector);
        if (!el) continue;
        await el.click().catch(() => null);
        await page.waitForTimeout(500);
        const picked = await clickByText(
            page,
            ['[role="option"]', '[role="menuitem"]', 'li', 'button', 'a'],
            storePattern
        );
        if (picked) {
            // Confirm the picker actually switched before touching the forecast:
            // typing against the previous store silently corrupts its data.
            if (await waitForStoreSelected(page, labelNeedle)) return true;
            throw new Error(`Clicked store ${store} in the LifeLenz picker but it did not become active.`);
        }
        await page.keyboard.press('Escape').catch(() => null);
    }

    throw new Error(`Store ${store} was not found in the LifeLenz store list.`);
}

async function navigateToForecast(page) {
    await page.waitForSelector('[data-testid="lz-dropdown-trigger-analytics"]', {
        visible: true,
        timeout: 15000,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
        await page.keyboard.press('Escape').catch(() => null);
        await page.waitForTimeout(200);

        const analyticsBtn = await page.$('[data-testid="lz-dropdown-trigger-analytics"]');
        if (analyticsBtn) {
            await analyticsBtn.click();
        } else {
            await clickByText(page, ['button'], /analytics/i);
        }
        await page.waitForTimeout(600);

        const opened = await clickByText(
            page,
            ['span', 'a', 'button', '[role="menuitem"]', 'li'],
            /^forecast$/i
        );
        if (opened) {
            // Wait for the forecast page chrome instead of a fixed sleep.
            const ready = await page
                .waitForSelector(
                    'a.calendar-unit-link.day, .display-date, a.display-date, [aria-label="Open calendar picker"]',
                    { visible: true, timeout: 15000 }
                )
                .then(() => true)
                .catch(() => false);
            if (ready) return;
        }
    }

    throw new Error('Could not open Forecast from the LifeLenz analytics menu.');
}

async function isForecastDayViewActive(page) {
    return page.evaluate(() => {
        const day = document.querySelector('a.calendar-unit-link.day, a[aria-label="Day View"]');
        if (!day) return false;
        if (day.classList.contains('active') || day.classList.contains('is-active')) return true;
        if (day.getAttribute('aria-selected') === 'true') return true;
        if (day.getAttribute('aria-current') === 'page') return true;
        const week = document.querySelector('a.calendar-unit-link.week, a[aria-label="Week View"]');
        if (week && (week.classList.contains('active') || week.classList.contains('is-active'))) return false;
        // Day-part adjusted inputs only render in day view.
        return [...document.querySelectorAll('input.forecast-adjustment.form-control, input.input-number.forecast-adjustment')].some(
            (input) => {
                const r = input.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            }
        );
    });
}

async function switchToDayView(page) {
    const alreadyDay = await isForecastDayViewActive(page).catch(() => false);
    if (!alreadyDay) {
        const dayLink = await page.$('a.calendar-unit-link.day, a[aria-label="Day View"]');
        if (dayLink) {
            await dayLink.click();
        } else {
            const clicked =
                (await clickByText(page, ['a', 'button'], /^day$/i)) ||
                (await clickByText(page, ['a', 'button'], /^d$/i));
            if (!clicked) throw new Error('Could not switch LifeLenz forecast to Day view.');
        }
    }
    // Day view is ready when the date toolbar renders; fall back to a short
    // settle if the selector never appears (older UI variants).
    const ready = await page
        .waitForSelector('.display-date, a.display-date, [aria-label="Open calendar picker"]', {
            visible: true,
            timeout: 10000,
        })
        .then(() => true)
        .catch(() => false);
    if (!ready) await page.waitForTimeout(SETTLE_MS);
}

const LIFELENZ_TIME_ZONE = process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne';

function getMelbourneTodayIso(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: LIFELENZ_TIME_ZONE }).format(date);
}

function addDaysToIso(iso, days) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + (Number(days) || 0));
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function getMelbourneTomorrowIso(date = new Date()) {
    return addDaysToIso(getMelbourneTodayIso(date), 1);
}

function isoToLifeLenzDisplay(iso) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    const dt = new Date(`${iso}T12:00:00`);
    const weekday = new Intl.DateTimeFormat('en-AU', { weekday: 'short' }).format(dt);
    const month = new Intl.DateTimeFormat('en-AU', { month: 'short' }).format(dt);
    return { weekday, day: d, month, monthIdx: m - 1, year: y, needle: `${weekday} ${d} ${month}` };
}

async function readActiveForecastIsoDate(page) {
    return page.evaluate(() => {
        const href = location.href || '';
        const urlMatch = href.match(/(\d{4}-\d{2}-\d{2})/);
        if (urlMatch) return urlMatch[1];

        const dateEl = document.querySelector('.display-date, a.display-date, [aria-label="Open calendar picker"]');
        const text = (dateEl?.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) return '';

        const monthMap = {
            jan: '01',
            january: '01',
            feb: '02',
            february: '02',
            mar: '03',
            march: '03',
            apr: '04',
            april: '04',
            may: '05',
            jun: '06',
            june: '06',
            jul: '07',
            july: '07',
            aug: '08',
            august: '08',
            sep: '09',
            sept: '09',
            september: '09',
            oct: '10',
            october: '10',
            nov: '11',
            november: '11',
            dec: '12',
            december: '12',
        };

        const wordsMatch = text.match(/(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
        if (wordsMatch) {
            const monthKey = wordsMatch[2].toLowerCase();
            const month = monthMap[monthKey] || monthMap[monthKey.slice(0, 3)];
            if (month) {
                return `${wordsMatch[3]}-${month}-${String(Number(wordsMatch[1])).padStart(2, '0')}`;
            }
        }

        const commaMatch = text.match(/[A-Za-z]+,\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/);
        if (commaMatch) {
            const monthKey = commaMatch[2].toLowerCase();
            const month = monthMap[monthKey] || monthMap[monthKey.slice(0, 3)];
            if (month) {
                return `${commaMatch[3]}-${month}-${String(Number(commaMatch[1])).padStart(2, '0')}`;
            }
        }

        const slashMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if (slashMatch) {
            const left = Number(slashMatch[1]);
            const right = Number(slashMatch[2]);
            const year = Number(slashMatch[3]);
            const month = right <= 12 ? right : left;
            const day = right <= 12 ? left : right;
            return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }

        return '';
    });
}

async function isForecastDateActive(page, isoDate) {
    const activeIso = await readActiveForecastIsoDate(page);
    if (activeIso === isoDate) return true;
    return page.url().includes(isoDate);
}

async function waitForForecastDateToolbar(page) {
    await page
        .waitForSelector('.display-date, a.display-date, [aria-label="Open calendar picker"]', {
            visible: true,
            timeout: 15000,
        })
        .catch(() => null);
    await page.waitForTimeout(400);
}

function buildForecastUrlsForDate(currentUrl, isoDate) {
    const out = [];
    if (!isoDate) return out;
    if (currentUrl.includes(isoDate)) out.push(currentUrl);
    if (/\d{4}-\d{2}-\d{2}/.test(currentUrl)) {
        out.push(currentUrl.replace(/\d{4}-\d{2}-\d{2}/g, isoDate));
    }
    try {
        const url = new URL(currentUrl);
        if (/\d{4}-\d{2}-\d{2}/.test(url.hash)) {
            url.hash = url.hash.replace(/\d{4}-\d{2}-\d{2}/g, isoDate);
            out.push(url.toString());
        }
        if (url.searchParams.has('date')) {
            const next = new URL(url.toString());
            next.searchParams.set('date', isoDate);
            out.push(next.toString());
        }
        const basePath = url.pathname.replace(/\/$/, '');
        out.push(`${url.origin}${basePath}/${isoDate}${url.search}${url.hash}`);
        if (url.hash) {
            out.push(`${url.origin}${basePath}${url.search}${url.hash.replace(/\d{4}-\d{2}-\d{2}/g, isoDate)}`);
        }
    } catch {
        /* ignore malformed URLs */
    }
    return [...new Set(out.filter(Boolean))];
}

async function setForecastDateViaUrl(page, isoDate) {
    const current = page.url();
    if (current.includes(isoDate)) return true;

    const candidates = buildForecastUrlsForDate(current, isoDate);
    for (const nextUrl of candidates) {
        if (nextUrl === current) continue;
        await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null);
        // Poll for the SPA to hydrate and show the target date rather than
        // sleeping a fixed interval and hoping it was long enough.
        if (await waitForForecastDate(page, isoDate, DATE_SETTLE_MS * 3)) return true;
    }
    return false;
}

/** Poll until the displayed date differs from previousIso (arrow click landed). */
async function waitForActiveDateChange(page, previousIso, timeoutMs = DATE_SETTLE_MS * 2) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const current = await readActiveForecastIsoDate(page).catch(() => '');
        if (current && current !== previousIso) return current;
        await page.waitForTimeout(200);
    }
    return readActiveForecastIsoDate(page).catch(() => '');
}

async function clickForecastDateArrow(page, forward) {
    const iconSelectors = forward
        ? ['.glyphicon-chevron-right', '.fa-chevron-right', '.icon-chevron-right']
        : ['.glyphicon-chevron-left', '.fa-chevron-left', '.icon-chevron-left'];
    const controlSelectors = forward
        ? ['a.next', 'button.next', '[aria-label*="Next day"]', '[aria-label*="next day"]', '[aria-label*="Next"]']
        : [
              'a.prev',
              'button.prev',
              '[aria-label*="Previous day"]',
              '[aria-label*="previous day"]',
              '[aria-label*="Previous"]',
          ];

    for (const selector of [...iconSelectors, ...controlSelectors]) {
        const handles = await page.$$(selector);
        for (const handle of handles) {
            const shouldClick = await handle.evaluate((el, goForward) => {
                if (el.closest('.datepicker, .bootstrap-datetimepicker-widget, .datepicker-dropdown')) return false;
                const displayDate = document.querySelector(
                    '.display-date, a.display-date, [aria-label="Open calendar picker"]'
                );
                if (!displayDate) return false;
                const displayRect = displayDate.getBoundingClientRect();
                const target = el.closest('a, button') || el;
                const targetRect = target.getBoundingClientRect();
                if (displayRect.width <= 0 || targetRect.width <= 0) return false;
                if (Math.abs(targetRect.top - displayRect.top) > 96) return false;
                const displayMid = displayRect.left + displayRect.width / 2;
                const targetMid = targetRect.left + targetRect.width / 2;
                return goForward ? targetMid > displayMid : targetMid < displayMid;
            }, forward);
            if (!shouldClick) continue;
            const clickHandle = await handle.evaluateHandle((el) => el.closest('a, button') || el);
            const clickEl = clickHandle.asElement();
            if (!clickEl) continue;
            await clickEl.click().catch(() => null);
            return true;
        }
    }

    return page.evaluate((goForward) => {
        const displayDate = document.querySelector('.display-date, a.display-date, [aria-label="Open calendar picker"]');
        const roots = [
            displayDate?.closest('div, nav, header, section, form, table, tr, td'),
            document.querySelector('.calendar-unit-link.day')?.closest('div, nav, section, form'),
        ].filter(Boolean);

        const selectors = goForward
            ? ['.glyphicon-chevron-right', '.fa-chevron-right', 'a.next', 'button.next']
            : ['.glyphicon-chevron-left', '.fa-chevron-left', 'a.prev', 'button.prev'];

        for (const root of roots.length ? roots : [document.body]) {
            for (const selector of selectors) {
                for (const el of root.querySelectorAll(selector)) {
                    if (el.closest('.datepicker, .bootstrap-datetimepicker-widget, .datepicker-dropdown')) continue;
                    const target = el.closest('a, button') || el;
                    const r = target.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    target.click();
                    return true;
                }
            }
        }
        return false;
    }, forward);
}

async function advanceForecastDateByDays(page, dayCount) {
    const steps = Math.max(0, Number(dayCount) || 0);
    if (!steps) return true;

    for (let step = 0; step < steps; step += 1) {
        const before = await readActiveForecastIsoDate(page).catch(() => '');
        const clicked = await clickForecastDateArrow(page, true);
        if (!clicked) return false;
        await waitForActiveDateChange(page, before);
    }
    return true;
}

async function advanceForecastDateWithArrows(page, isoDate) {
    const targetMs = Date.parse(`${isoDate}T12:00:00Z`);
    for (let step = 0; step < 45; step += 1) {
        if (await isForecastDateActive(page, isoDate)) return true;

        const currentIso = await readActiveForecastIsoDate(page);
        const goForward = !currentIso || targetMs >= Date.parse(`${currentIso}T12:00:00Z`);
        const advanced = await clickForecastDateArrow(page, goForward);
        if (!advanced) return false;
        await waitForActiveDateChange(page, currentIso);
    }
    return await isForecastDateActive(page, isoDate);
}

async function openForecastCalendarPicker(page) {
    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(200);

    const dateTrigger = await page.$('.display-date, a.display-date, [aria-label="Open calendar picker"]');
    if (dateTrigger) {
        await dateTrigger.click();
    } else {
        const clicked = await clickByText(
            page,
            ['a', 'button', 'span'],
            /\d{1,2}\s+[A-Za-z]{3}\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4}/
        );
        if (!clicked) return false;
    }
    await page.waitForTimeout(500);
    return page.evaluate(() => {
        const widgetSelectors = [
            '.datepicker.datepicker-dropdown',
            '.bootstrap-datetimepicker-widget.dropdown-menu',
            '.bootstrap-datetimepicker-widget',
            '.datepicker:not(.datepicker-inline)',
        ];
        return widgetSelectors.some((selector) => {
            const el = document.querySelector(selector);
            return el && el.getBoundingClientRect().width > 0;
        });
    });
}

async function pickForecastDateFromCalendar(page, isoDate, display) {
    const opened = await openForecastCalendarPicker(page);
    if (!opened) return false;

    const picked = await page.evaluate(({ day, monthIdx, year, isoDate: targetIso }) => {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const want = monthIdx >= 0 ? `${monthNames[monthIdx]} ${year}` : '';

        const widgetSelectors = [
            '.datepicker.datepicker-dropdown',
            '.bootstrap-datetimepicker-widget.dropdown-menu',
            '.bootstrap-datetimepicker-widget',
            '.datepicker:not(.datepicker-inline)',
        ];
        let widget = null;
        for (const selector of widgetSelectors) {
            const candidate = document.querySelector(selector);
            if (candidate && candidate.getBoundingClientRect().width > 0) {
                widget = candidate;
                break;
            }
        }
        if (!widget) return false;

        const readHeader = () =>
            (
                widget.querySelector(
                    '.datepicker-days .datepicker-switch, .bootstrap-datetimepicker-widget .picker-switch, .picker-switch, [class*="switch"]'
                )?.textContent || ''
            ).replace(/\s+/g, ' ');

        const ensureMonth = () => {
            if (!want) return;
            for (let i = 0; i < 24; i += 1) {
                const currentHeader = readHeader();
                if (new RegExp(want, 'i').test(currentHeader)) return;
                const prev = widget.querySelector('.prev, th.prev, .datepicker-prev, [aria-label*="Previous"]');
                const next = widget.querySelector('.next, th.next, .datepicker-next, [aria-label*="Next"]');
                const currentMonthIdx = monthNames.findIndex((name) => currentHeader.includes(name));
                if (currentMonthIdx < 0 || monthIdx < 0) {
                    next?.click();
                    continue;
                }
                if (
                    monthIdx < currentMonthIdx ||
                    (monthIdx === currentMonthIdx && !new RegExp(String(year), 'i').test(currentHeader))
                ) {
                    prev?.click();
                } else {
                    next?.click();
                }
            }
        };

        ensureMonth();

        const dayCells = widget.querySelectorAll('td.day, td[data-day], td[data-date], button.day, a.day, span.day');
        for (const cell of dayCells) {
            const dataDay = cell.getAttribute?.('data-day') || cell.getAttribute?.('data-date') || '';
            if (dataDay) {
                const normalized = dataDay.replace(/\//g, '-');
                if (
                    normalized.startsWith(targetIso) ||
                    normalized.includes(targetIso.slice(5)) ||
                    (dataDay.includes(String(day)) && dataDay.includes(String(year)))
                ) {
                    if (cell.classList?.contains('disabled') || cell.getAttribute('aria-disabled') === 'true') continue;
                    if (cell.classList?.contains('old') || cell.classList?.contains('new')) continue;
                    cell.click();
                    return true;
                }
            }
            const text = (cell.textContent || '').trim();
            if (text !== String(day)) continue;
            if (cell.classList?.contains('old') || cell.classList?.contains('new')) continue;
            if (cell.classList?.contains('disabled') || cell.getAttribute('aria-disabled') === 'true') continue;
            cell.click();
            return true;
        }
        return false;
    }, { day: display.day, monthIdx: display.monthIdx, year: display.year, isoDate });

    if (!picked) {
        await page.keyboard.press('Escape').catch(() => null);
        return false;
    }

    await page.waitForTimeout(DATE_SETTLE_MS);
    await page.keyboard.press('Escape').catch(() => null);
    return await isForecastDateActive(page, isoDate);
}

async function waitForForecastDate(page, isoDate, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await isForecastDateActive(page, isoDate)) return true;
        await page.waitForTimeout(300);
    }
    return false;
}

function resolveDayPartInputTimeoutMs(options = {}) {
    if (Number.isFinite(options.dayPartInputTimeoutMs)) return options.dayPartInputTimeoutMs;
    return DEFAULT_DAY_PART_INPUT_TIMEOUT_MS;
}

/**
 * Day-part adjusted inputs only appear in day view. After date navigation the
 * Aurelia forecast page can briefly show the date toolbar while still in week
 * view or while inputs are hydrating - poll until 9 fields are visible.
 */
async function ensureForecastDayViewReady(page, options = {}) {
    const timeoutMs = resolveDayPartInputTimeoutMs(options);
    const deadline = Date.now() + timeoutMs;
    let lastCount = 0;

    while (Date.now() < deadline) {
        await switchToDayView(page).catch(() => null);
        try {
            lastCount = await countVisibleDayPartInputs(page);
        } catch (err) {
            if (!isDestroyedContextError(err)) throw err;
            lastCount = 0;
        }
        if (lastCount >= DAY_PART_INPUT_COUNT) {
            await page.waitForTimeout(300);
            const settled = await countVisibleDayPartInputs(page).catch(() => 0);
            if (settled >= DAY_PART_INPUT_COUNT) return;
            lastCount = settled;
        }
        await page.waitForTimeout(200);
    }

    const activeDate = await readActiveForecastIsoDate(page).catch(() => 'unknown');
    const inDayView = await isForecastDayViewActive(page).catch(() => false);
    throw new Error(
        `LifeLenz day-part inputs not ready (${lastCount} visible, need ${DAY_PART_INPUT_COUNT}, ` +
            `date showing ${activeDate}, day view ${inDayView ? 'active' : 'not active'}).`
    );
}

async function finishForecastDateNavigation(page, target, options = {}) {
    if (!(await isForecastDateActive(page, target))) return false;
    await ensureForecastDayViewReady(page, options);
    return true;
}

async function setForecastDate(page, isoDate, options = {}) {
    const target = String(isoDate || '').trim();
    if (!target) throw new Error('Forecast date is required.');

    if (await finishForecastDateNavigation(page, target, options)) return;

    const currentIso = await readActiveForecastIsoDate(page);
    const tomorrowIso = getMelbourneTomorrowIso();
    console.log(
        `[LifeLenz forecast] Navigating from ${currentIso || 'unknown'} to ${target}` +
            (target === tomorrowIso ? ' (tomorrow)' : '')
    );

    if (target === tomorrowIso) {
        if (await clickByText(page, ['a', 'button', 'span'], /^tomorrow$/i)) {
            await page.waitForTimeout(DATE_SETTLE_MS);
            if (await finishForecastDateNavigation(page, target, options)) return;
        }
        if (!currentIso || currentIso === getMelbourneTodayIso()) {
            if ((await advanceForecastDateByDays(page, 1)) && (await finishForecastDateNavigation(page, target, options))) {
                return;
            }
        }
    }

    if (currentIso && /^\d{4}-\d{2}-\d{2}$/.test(currentIso) && /^\d{4}-\d{2}-\d{2}$/.test(target)) {
        const dayOffset = Math.round(
            (Date.parse(`${target}T12:00:00Z`) - Date.parse(`${currentIso}T12:00:00Z`)) / 86400000
        );
        if (dayOffset > 0 && dayOffset <= 14) {
            if (
                (await advanceForecastDateByDays(page, dayOffset)) &&
                (await finishForecastDateNavigation(page, target, options))
            ) {
                return;
            }
        }
    }

    if ((await setForecastDateViaUrl(page, target)) && (await finishForecastDateNavigation(page, target, options))) {
        return;
    }
    if ((await advanceForecastDateWithArrows(page, target)) && (await finishForecastDateNavigation(page, target, options))) {
        return;
    }

    const display = isoToLifeLenzDisplay(target);
    if (!display) throw new Error(`Invalid forecast date: ${target}`);

    if ((await pickForecastDateFromCalendar(page, target, display)) && (await finishForecastDateNavigation(page, target, options))) {
        return;
    }

    if ((await setForecastDateViaUrl(page, target)) && (await finishForecastDateNavigation(page, target, options))) {
        return;
    }
    if ((await advanceForecastDateWithArrows(page, target)) && (await finishForecastDateNavigation(page, target, options))) {
        return;
    }
    if ((await waitForForecastDate(page, target, 3000)) && (await finishForecastDateNavigation(page, target, options))) {
        return;
    }

    const showing = await readActiveForecastIsoDate(page);
    throw new Error(
        `Could not select date ${target} in LifeLenz calendar` + (showing ? ` (showing ${showing})` : '') + '.'
    );
}

/** Day-part Adjusted inputs only - first 9 visible fields; the 10th is the day total (auto-calculated). */
async function getDayPartAdjustmentInputs(page) {
    const handles = await page.$$(DAY_PART_INPUT_SELECTOR);
    const visible = [];
    for (const handle of handles) {
        const box = await handle.boundingBox();
        if (box && box.width > 0 && box.height > 0) visible.push(handle);
    }
    return visible.slice(0, DAY_PART_INPUT_COUNT);
}

async function locateDayPartInputs(page) {
    const inputs = await getDayPartAdjustmentInputs(page);
    if (inputs.length < DAY_PART_INPUT_COUNT) return [];
    return inputs.slice(0, DAY_PART_INPUT_COUNT).map((_, index) => ({ index }));
}

async function clearAndTypeForecastAdjustment(page, visibleIndex, value, options = {}) {
    const inputs = await getDayPartAdjustmentInputs(page);
    const input = inputs[visibleIndex];
    if (!input) {
        throw new Error(`Forecast adjustment input ${visibleIndex} not found (${inputs.length} day-part fields).`);
    }
    await input.click({ clickCount: 3 });
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await input.type(String(value), { delay: 25 });
    if (options.avoidTab) {
        await input.evaluate((el) => el.blur());
    } else {
        await input.press('Tab').catch(() => null);
    }
}

async function clearAndTypeInput(page, _selectorOrIndex, value, inputIndex) {
    await clearAndTypeForecastAdjustment(page, inputIndex, value);
}

async function countVisibleDayPartInputs(page) {
    return page.evaluate((selector) => {
        const inputs = document.querySelectorAll(selector);
        return [...inputs].filter((input) => {
            const r = input.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }).length;
    }, DAY_PART_INPUT_SELECTOR);
}

/**
 * Wait for LifeLenz to settle after the overnight quirk save. The save can
 * trigger a full SPA reload, so instead of racing fixed sleeps against
 * networkidle2 (which an Aurelia SPA may never reach), poll until the
 * day-part inputs are visible again and hold steady, capped by maxMs.
 */
async function waitForDayPartSaveSettle(page, options = {}) {
    const maxMs = resolveQuirkReloadMaxMs(options);
    const deadline = Date.now() + maxMs;

    let count = 0;
    while (Date.now() < deadline) {
        try {
            count = await countVisibleDayPartInputs(page);
        } catch (err) {
            if (!isDestroyedContextError(err)) throw err;
            count = 0;
        }
        if (count >= DAY_PART_INPUT_COUNT) break;
        await page.waitForTimeout(150);
    }

    if (count < DAY_PART_INPUT_COUNT) {
        throw new Error(
            `LifeLenz day-part inputs not ready after save (${count} visible, need ${DAY_PART_INPUT_COUNT}, waited ${maxMs}ms).`
        );
    }

    // Require the input count to hold steady so we don't read/type against a
    // page that is still re-rendering mid-reload.
    await page.waitForTimeout(300);
    const settled = await countVisibleDayPartInputs(page).catch(() => 0);
    if (settled < DAY_PART_INPUT_COUNT) {
        const graceDeadline = Date.now() + Math.min(maxMs, 5000);
        let recovered = settled;
        while (recovered < DAY_PART_INPUT_COUNT && Date.now() < graceDeadline) {
            await page.waitForTimeout(200);
            recovered = await countVisibleDayPartInputs(page).catch(() => 0);
        }
        if (recovered < DAY_PART_INPUT_COUNT) {
            throw new Error(
                `LifeLenz day-part inputs disappeared while settling after save (${recovered} visible, need ${DAY_PART_INPUT_COUNT}).`
            );
        }
    }
}

function parseDayPartInputNumber(raw) {
    const cleaned = String(raw ?? '').replace(/[^0-9.-]/g, '');
    if (!cleaned) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

/** Read the current values of the 9 visible day-part adjustment inputs. */
async function readDayPartInputValues(page) {
    const raw = await page.evaluate((selector) => {
        return [...document.querySelectorAll(selector)]
            .filter((input) => {
                const r = input.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            })
            .slice(0, 9)
            .map((input) => input.value);
    }, DAY_PART_INPUT_SELECTOR);
    return raw.map(parseDayPartInputNumber);
}

/**
 * Read the entered day-part values back and confirm they match the plan.
 * Polls because the quirk save/reload can briefly repopulate inputs with
 * stale values before the saved ones render.
 */
async function verifyDayPartValues(page, dayParts, options = {}) {
    const timeoutMs = Number.isFinite(options.verifyTimeoutMs) ? options.verifyTimeoutMs : VERIFY_TIMEOUT_MS;
    const expected = dayParts.map((part) => Math.round(Number(part.adjusted) || 0));
    const deadline = Date.now() + timeoutMs;
    let mismatches = [];

    while (Date.now() < deadline) {
        let values = null;
        try {
            values = await readDayPartInputValues(page);
        } catch (err) {
            if (!isDestroyedContextError(err)) throw err;
        }
        if (values && values.length >= expected.length) {
            mismatches = [];
            for (let i = 0; i < expected.length; i += 1) {
                const actual = values[i];
                if (actual == null || Math.round(actual) !== expected[i]) {
                    mismatches.push({ index: i, label: dayParts[i].label, expected: expected[i], actual });
                }
            }
            if (!mismatches.length) return { ok: true };
        }
        await page.waitForTimeout(400);
    }

    return { ok: false, mismatches };
}

async function fillDayPartsWithOvernightQuirk(page, dayParts, options = {}) {
    const inputs = await locateDayPartInputs(page);

    if (inputs.length < dayParts.length) {
        throw new Error(
            `Could not locate LifeLenz day-part adjusted inputs (${inputs.length} found, need ${dayParts.length}).`
        );
    }

    const firstOvernightValue = dayParts[0]?.adjusted ?? 0;
    const fieldDelayMs = resolveFieldDelayMs(options);

    emitProgress(options, { type: 'daypart-entering', label: 'OVERNIGHT', phase: 'quirk-start' });
    await clearAndTypeForecastAdjustment(page, 0, 'x');
    await page.waitForTimeout(Math.min(fieldDelayMs, 150));

    for (let i = 1; i < dayParts.length; i += 1) {
        const part = dayParts[i];
        emitProgress(options, { type: 'daypart-entering', label: part.label, value: part.adjusted });
        const isLastDayPart = i === dayParts.length - 1;
        await clearAndTypeForecastAdjustment(page, i, part.adjusted, { avoidTab: isLastDayPart });
        await page.waitForTimeout(fieldDelayMs);
    }

    emitProgress(options, {
        type: 'daypart-entering',
        label: 'OVERNIGHT',
        phase: 'quirk-finish',
        value: firstOvernightValue,
    });
    await clearAndTypeForecastAdjustment(page, 0, firstOvernightValue, { avoidTab: true });

    await waitForDayPartSaveSettle(page, options);
}

async function writeForecastDay(page, isoDate, planDay, options = {}) {
    emitProgress(options, { type: 'day-start', date: isoDate, forecastTotal: planDay.forecastTotal });
    const dayParts = aggregateDayPartsFromHourlyPlan(planDay);

    let verification = null;
    for (let attempt = 1; attempt <= WRITE_DAY_MAX_ATTEMPTS; attempt += 1) {
        await setForecastDate(page, isoDate, options);
        await fillDayPartsWithOvernightQuirk(page, dayParts, options);

        verification = await verifyDayPartValues(page, dayParts, options);
        if (verification.ok) break;

        const detail = (verification.mismatches || [])
            .map((m) => `${m.label}: expected ${m.expected}, saw ${m.actual ?? 'blank'}`)
            .join('; ');
        if (attempt < WRITE_DAY_MAX_ATTEMPTS) {
            console.warn(
                `[LifeLenz forecast] ${isoDate} verification mismatch (attempt ${attempt}), re-entering: ${detail}`
            );
            emitProgress(options, { type: 'day-retry', date: isoDate, attempt, detail });
        } else {
            throw new Error(`LifeLenz values did not persist for ${isoDate} after ${attempt} attempts: ${detail}`);
        }
    }

    emitProgress(options, {
        type: 'day-complete',
        date: isoDate,
        verified: true,
        adjustedTotal: dayParts.reduce((sum, row) => sum + row.adjusted, 0),
    });
    return { date: isoDate, dayParts, verified: true };
}

async function writeForecastPlanOnPage(page, storeNumber, plan, accessibleStores, options = {}) {
    const store = String(storeNumber || '').trim();
    const allowed = new Set((accessibleStores || []).map((row) => String(row.storeNumber)));
    if (allowed.size && !allowed.has(store)) {
        throw new Error(`Store ${store} is not in this LifeLenz account (accessible: ${[...allowed].join(', ')}).`);
    }

    await selectStoreInLifeLenz(page, store);
    await navigateToForecast(page);
    await switchToDayView(page);
    await waitForForecastDateToolbar(page);
    await ensureForecastDayViewReady(page, options);

    const applied = [];
    for (const day of plan || []) {
        try {
            const result = await writeForecastDay(page, day.date, day, options);
            applied.push(result);
        } catch (err) {
            emitProgress(options, { type: 'day-error', date: day.date, error: err.message || String(err) });
            throw err;
        }
    }
    return applied;
}

async function writeForecastPlanToLifeLenz(storeNumber, plan, credentials, options = {}) {
    const email = String(credentials?.email || credentials?.lifelenzEmail || '').trim();
    const password = String(credentials?.password || credentials?.lifelenzPassword || '');
    if (!email || !password) {
        throw new Error('LifeLenz credentials are required.');
    }

    let browser = options.browser;
    let page = options.page;
    let ownsSession = false;

    if (!page) {
        const session = await createAuthenticatedLifeLenzSession(email, password, options);
        browser = session.browser;
        page = session.page;
        options.accessibleStores = session.stores;
        ownsSession = true;
    }

    try {
        const applied = await writeForecastPlanOnPage(
            page,
            storeNumber,
            plan,
            options.accessibleStores || [],
            options
        );
        return {
            storeNumber: String(storeNumber),
            forecastDays: applied.length,
            lifelenz: applied,
        };
    } finally {
        if (ownsSession && !options.keepBrowserOpen) {
            await closeBrowserQuietly(browser, 'lifelenz-forecast');
        }
    }
}

module.exports = {
    selectStoreInLifeLenz,
    navigateToForecast,
    switchToDayView,
    setForecastDate,
    getDayPartAdjustmentInputs,
    ensureForecastDayViewReady,
    finishForecastDateNavigation,
    fillDayPartsWithOvernightQuirk,
    waitForDayPartSaveSettle,
    readDayPartInputValues,
    verifyDayPartValues,
    countVisibleDayPartInputs,
    resolveQuirkReloadMaxMs,
    writeForecastPlanToLifeLenz,
    writeForecastPlanOnPage,
    aggregateDayPartsFromHourlyPlan,
    parseStoreLabel,
    dedupeStores,
};
