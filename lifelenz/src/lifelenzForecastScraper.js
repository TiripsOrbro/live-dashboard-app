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
    return { weekday, day: d, month, year: y, needle: `${weekday} ${d} ${month}` };
}

async function isForecastDateActive(page, isoDate) {
    const href = await page.url();
    if (href.includes(`/${isoDate}`)) return true;
    const display = isoToLifeLenzDisplay(isoDate);
    if (!display?.needle) return false;
    return page.evaluate((needle) => (document.body?.innerText || '').includes(needle), display.needle);
}

async function setForecastDateViaUrl(page, isoDate) {
    const current = page.url();
    if (current.includes(`/${isoDate}`) || current.endsWith(isoDate)) return true;
    if (!/\d{4}-\d{2}-\d{2}/.test(current)) return false;

    const nextUrl = current.replace(/\d{4}-\d{2}-\d{2}/, isoDate);
    if (nextUrl === current) return false;

    await page.goto(nextUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(DATE_SETTLE_MS);
    return await isForecastDateActive(page, isoDate);
}

async function advanceForecastDateWithArrows(page, isoDate) {
    for (let step = 0; step < 8; step += 1) {
        if (await isForecastDateActive(page, isoDate)) return true;

        const advanced = await page.evaluate(() => {
            const selectors = [
                'a.next',
                'button.next',
                '[aria-label*="Next"]',
                '[aria-label*="next"]',
                '.fa-chevron-right',
                '.icon-chevron-right',
            ];
            for (const selector of selectors) {
                const el = document.querySelector(selector);
                if (!el) continue;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                el.click();
                return true;
            }
            return false;
        });
        if (!advanced) return false;
        await page.waitForTimeout(DATE_SETTLE_MS);
    }
    return await isForecastDateActive(page, isoDate);
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

    await page.keyboard.press('Escape').catch(() => null);
    await page.waitForTimeout(200);

    const dateTrigger = await page.$('.display-date, a.display-date, [aria-label="Open calendar picker"]');
    if (dateTrigger) {
        await dateTrigger.click();
    } else {
        await clickByText(page, ['a', 'button'], /\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/);
    }
    await page.waitForTimeout(500);

    const picked = await page.evaluate(({ day, month, year }) => {
        const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthIdx = monthNames.indexOf(month);

        const header = document.querySelector(
            '.datepicker-days .datepicker-switch, .bootstrap-datetimepicker-widget .picker-switch, [class*="calendar"] [class*="switch"]'
        );
        const headerText = (header?.textContent || document.body?.innerText || '').replace(/\s+/g, ' ');

        const ensureMonth = () => {
            if (monthIdx < 0) return;
            const want = `${monthNames[monthIdx]} ${year}`;
            if (new RegExp(want, 'i').test(headerText)) return;
            for (let i = 0; i < 14; i += 1) {
                const prev = document.querySelector('.prev, .datepicker-prev, [aria-label*="Previous"]');
                const next = document.querySelector('.next, .datepicker-next, [aria-label*="Next"]');
                const currentHeader = (
                    document.querySelector('.datepicker-days .datepicker-switch, .bootstrap-datetimepicker-widget .picker-switch')?.textContent ||
                    ''
                ).replace(/\s+/g, ' ');
                if (new RegExp(want, 'i').test(currentHeader)) return;
                if (monthIdx < monthNames.findIndex((m) => currentHeader.includes(m))) {
                    prev?.click();
                } else {
                    next?.click();
                }
            }
        };

        ensureMonth();

        for (const cell of document.querySelectorAll('td.day, td[data-day], button, a, span')) {
            const text = (cell.textContent || '').trim();
            if (text !== String(day)) continue;
            if (cell.classList?.contains('old') || cell.classList?.contains('new')) continue;
            if (cell.classList?.contains('disabled') || cell.getAttribute('aria-disabled') === 'true') continue;
            cell.click();
            return true;
        }
        return false;
    }, display);

    if (!picked) {
        await page.keyboard.press('Escape').catch(() => null);
        if (await setForecastDateViaUrl(page, isoDate)) return;
        throw new Error(`Could not select date ${isoDate} in LifeLenz calendar.`);
    }

    await page.waitForTimeout(DATE_SETTLE_MS);
    await page.keyboard.press('Escape').catch(() => null);
}

const DAY_PART_INPUT_COUNT = 9;

/** Day-part Adjusted inputs only — first 9 visible fields; the 10th is the day total (auto-calculated). */
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
