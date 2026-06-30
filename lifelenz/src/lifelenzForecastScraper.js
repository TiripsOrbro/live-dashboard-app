const { closeBrowserQuietly } = require('../../mmx/src/macromatixScraper');
const {
    createAuthenticatedLifeLenzSession,
    parseStoreLabel,
    dedupeStores,
} = require('./lifelenzAuth');
const { aggregateDayPartsFromHourlyPlan, LIFELENZ_DAY_PARTS } = require('./lifelenzDayParts');

const SETTLE_MS = 800;
const DATE_SETTLE_MS = 2000;
const DEFAULT_QUIRK_RELOAD_MAX_MS = 6000;

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

async function selectStoreInLifeLenz(page, storeNumber) {
    const store = String(storeNumber || '').trim();
    const labelNeedle = `${store} -`;

    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(300);

    const current = await page.evaluate(() => {
        for (const el of document.querySelectorAll(
            'button[aria-haspopup="listbox"], button[aria-haspopup="menu"], [data-slot="trigger"], div.max-w-60'
        )) {
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/^\d{4}\s*-\s*/.test(text)) return text;
        }
        return '';
    });
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
            await page.waitForTimeout(SETTLE_MS);
            return true;
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
            await page.waitForTimeout(SETTLE_MS);
            return;
        }
    }

    throw new Error('Could not open Forecast from the LifeLenz analytics menu.');
}

async function switchToDayView(page) {
    const dayLink = await page.$('a.calendar-unit-link.day, a[aria-label="Day View"]');
    if (dayLink) {
        await dayLink.click();
    } else {
        const clicked = await clickByText(page, ['a', 'button'], /^d$/i);
        if (!clicked) throw new Error('Could not switch LifeLenz forecast to Day view.');
    }
    await page.waitForTimeout(SETTLE_MS);
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
            feb: '02',
            mar: '03',
            apr: '04',
            may: '05',
            jun: '06',
            jul: '07',
            aug: '08',
            sep: '09',
            oct: '10',
            nov: '11',
            dec: '12',
        };

        const wordsMatch = text.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
        if (wordsMatch) {
            const month = monthMap[wordsMatch[2].slice(0, 3).toLowerCase()];
            if (month) {
                return `${wordsMatch[3]}-${month}-${String(Number(wordsMatch[1])).padStart(2, '0')}`;
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
    const href = page.url();
    if (href.includes(isoDate)) return true;
    const display = isoToLifeLenzDisplay(isoDate);
    if (!display?.needle) return false;
    return page.evaluate(
        ({ needle, day, month, year }) => {
            const dateEl = document.querySelector('.display-date, a.display-date, [aria-label="Open calendar picker"]');
            const text = (dateEl?.textContent || '').replace(/\s+/g, ' ').trim();
            if (
                text &&
                new RegExp(`\\b${day}\\b`).test(text) &&
                new RegExp(month, 'i').test(text) &&
                new RegExp(String(year)).test(text)
            ) {
                return true;
            }
            return (document.body?.innerText || '').includes(needle);
        },
        { needle: display.needle, day: display.day, month: display.month, year: display.year }
    );
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
        await page.waitForTimeout(DATE_SETTLE_MS);
        if (await isForecastDateActive(page, isoDate)) return true;
    }
    return false;
}

async function clickForecastDateArrow(page, forward) {
    return page.evaluate((goForward) => {
        const dateRoots = [
            document.querySelector('.display-date')?.closest('div, nav, header, section, form'),
            document.querySelector('.calendar-unit-link.day')?.closest('div, nav, section, form'),
            document.querySelector('[class*="date-nav"]')?.closest('div, nav, section, form'),
        ].filter(Boolean);

        const selectors = goForward
            ? [
                  '[aria-label*="Next day"]',
                  '[aria-label*="next day"]',
                  'a.next',
                  'button.next',
                  '[aria-label*="Next"]',
                  '[aria-label*="next"]',
                  '.fa-chevron-right',
                  '.icon-chevron-right',
              ]
            : [
                  '[aria-label*="Previous day"]',
                  '[aria-label*="previous day"]',
                  'a.prev',
                  'button.prev',
                  '[aria-label*="Previous"]',
                  '[aria-label*="previous"]',
                  '.fa-chevron-left',
                  '.icon-chevron-left',
              ];

        const roots = dateRoots.length ? dateRoots : [document.body];
        for (const root of roots) {
            for (const selector of selectors) {
                for (const el of root.querySelectorAll(selector)) {
                    if (el.closest('.datepicker, .bootstrap-datetimepicker-widget, .datepicker-dropdown')) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    el.click();
                    return true;
                }
            }
        }
        return false;
    }, forward);
}

async function advanceForecastDateWithArrows(page, isoDate) {
    const targetMs = Date.parse(`${isoDate}T12:00:00Z`);
    for (let step = 0; step < 45; step += 1) {
        if (await isForecastDateActive(page, isoDate)) return true;

        const currentIso = await readActiveForecastIsoDate(page);
        const goForward = !currentIso || targetMs >= Date.parse(`${currentIso}T12:00:00Z`);
        const advanced = await clickForecastDateArrow(page, goForward);
        if (!advanced) return false;
        await page.waitForTimeout(DATE_SETTLE_MS);
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

async function setForecastDate(page, isoDate) {
    if (await isForecastDateActive(page, isoDate)) {
        await page.waitForTimeout(500);
        return;
    }

    if (await setForecastDateViaUrl(page, isoDate)) return;
    if (await advanceForecastDateWithArrows(page, isoDate)) return;

    const display = isoToLifeLenzDisplay(isoDate);
    if (!display) throw new Error(`Invalid forecast date: ${isoDate}`);

    if (await pickForecastDateFromCalendar(page, isoDate, display)) return;

    if (await setForecastDateViaUrl(page, isoDate)) return;
    if (await advanceForecastDateWithArrows(page, isoDate)) return;
    if (await waitForForecastDate(page, isoDate, 3000)) return;

    const currentIso = await readActiveForecastIsoDate(page);
    throw new Error(
        `Could not select date ${isoDate} in LifeLenz calendar` + (currentIso ? ` (showing ${currentIso})` : '') + '.'
    );
}

const DAY_PART_INPUT_COUNT = 9;

/** Day-part Adjusted inputs only - first 9 visible fields; the 10th is the day total (auto-calculated). */
async function getDayPartAdjustmentInputs(page) {
    const handles = await page.$$('input.forecast-adjustment.form-control, input.input-number.forecast-adjustment');
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
    return page.evaluate(
        () =>
            [...document.querySelectorAll('input.forecast-adjustment.form-control')].filter((input) => {
                const r = input.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            }).length
    );
}

/** Wait for LifeLenz to settle after overnight quirk save (inputs visible again, capped by maxMs). */
async function waitForDayPartSaveSettle(page, options = {}) {
    const maxMs = resolveQuirkReloadMaxMs(options);
    const started = Date.now();

    await Promise.race([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: maxMs }).catch(() => null),
        page
            .waitForFunction(
                () =>
                    [...document.querySelectorAll('input.forecast-adjustment.form-control')].filter((input) => {
                        const r = input.getBoundingClientRect();
                        return r.width > 0 && r.height > 0;
                    }).length >= 9,
                { timeout: maxMs, polling: 150 }
            )
            .catch(() => null),
        page.waitForTimeout(maxMs),
    ]);

    const remaining = Math.max(0, Math.min(SETTLE_MS, maxMs - (Date.now() - started)));
    if (remaining > 0) await page.waitForTimeout(remaining);

    const count = await countVisibleDayPartInputs(page);
    if (count < DAY_PART_INPUT_COUNT) {
        throw new Error(
            `LifeLenz day-part inputs not ready after save (${count} visible, need ${DAY_PART_INPUT_COUNT}).`
        );
    }
}

async function fillDayPartsWithOvernightQuirk(page, dayParts, options = {}) {
    await page.waitForSelector('input.forecast-adjustment.form-control', { visible: true, timeout: 15000 });
    await page.waitForFunction(
        () =>
            [...document.querySelectorAll('input.forecast-adjustment.form-control')].filter((input) => {
                const r = input.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            }).length >= 9,
        { timeout: 15000, polling: 500 }
    );
    let inputs = await locateDayPartInputs(page);

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
    if (!(await isForecastDateActive(page, isoDate))) {
        await setForecastDate(page, isoDate);
    }
    const dayParts = aggregateDayPartsFromHourlyPlan(planDay);
    await fillDayPartsWithOvernightQuirk(page, dayParts, options);
    emitProgress(options, {
        type: 'day-complete',
        date: isoDate,
        adjustedTotal: dayParts.reduce((sum, row) => sum + row.adjusted, 0),
    });
    return { date: isoDate, dayParts };
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
    fillDayPartsWithOvernightQuirk,
    waitForDayPartSaveSettle,
    countVisibleDayPartInputs,
    resolveQuirkReloadMaxMs,
    writeForecastPlanToLifeLenz,
    writeForecastPlanOnPage,
    aggregateDayPartsFromHourlyPlan,
    parseStoreLabel,
    dedupeStores,
};
