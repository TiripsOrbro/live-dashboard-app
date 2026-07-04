const MMX_SPA_BASE = 'https://m-tacobellau.macromatix.net/';
const CHANGE_STORE_URL = `${MMX_SPA_BASE}#/Administration/ChangeStore?metric=sales`;
const FORECASTING_URL = `${MMX_SPA_BASE}#/Forecasting/Edit?metric=sales`;
const SPA_GOTO_OPTS = { waitUntil: 'load', timeout: 60000 };

function getMacromatixScraper() {
    return require('../macromatixScraper');
}

function getSssgScraper() {
    return require('../sssg/sssgScraper');
}

/** Macromatix SPA date display (MM/DD/YYYY) from ISO YYYY-MM-DD. */
function isoToMmxDate(iso) {
    const [y, m, d] = String(iso || '').split('-').map(Number);
    if (!y || !m || !d) return '';
    return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
}

function mmxDateToIso(mmx) {
    const m = String(mmx || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return '';
    return `${m[3]}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

const DATE_PICKER_SEL = '#mx-forecast-dateselection-dropdown-edit';
const MANAGER_OVERRIDE_INPUT = '#overrideInput';
const POLL_MS = 50;
const VERIFY_POLL_MS = 50;
const VERIFY_TIMEOUT_MS = 2000;
const GRID_WAIT_MS = 20000;
const DATE_CHANGE_MS = 6000;
const SAVE_SETTLE_MS = 8000;
const SAVE_APPEAR_MS = 15000;
const SAVE_APPEAR_FAST_MS = 400;
const SAVE_SUCCESS_TIMEOUT_MS = 15000;
const SAVE_SUCCESS_PATTERN = /changes saved successfully/i;
const OVERRIDE_CLOSE_MS = 2000;
const OVERRIDE_CLOSE_CONTINUOUS_MS = 250;
const DOLLAR_MODE_MS = 2000;
const ZERO_VERIFY_TIMEOUT_MS = 1200;
const CELL_CLICK_DELAY_MS = 0;

function dayDiffIso(fromIso, toIso) {
    if (!fromIso || !toIso) return null;
    const a = new Date(`${fromIso}T12:00:00Z`).getTime();
    const b = new Date(`${toIso}T12:00:00Z`).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return Math.round((b - a) / 86400000);
}

async function waitForDisplayedForecastDate(page, displayStr, timeoutMs = DATE_CHANGE_MS) {
    if (!displayStr) return false;
    try {
        await page.waitForFunction(
            (want, pickerSel) => {
                const valid = (t) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t) && t !== '01/01/1900';
                const host = document.querySelector(pickerSel);
                if (host) {
                    for (const span of host.querySelectorAll('.ng-binding')) {
                        const t = (span.textContent || '').trim();
                        if (valid(t)) return t === want;
                    }
                }
                return false;
            },
            { timeout: timeoutMs, polling: 60 },
            displayStr,
            DATE_PICKER_SEL
        );
        return true;
    } catch {
        return false;
    }
}

async function waitForForecastSaveSuccessToast(page, timeoutMs = SAVE_SUCCESS_TIMEOUT_MS) {
    try {
        await page.waitForFunction(
            (patternSource) => {
                const pattern = new RegExp(patternSource, 'i');
                const selectors = [
                    '.alert-success',
                    '.alert.alert-success',
                    '[role="alert"]',
                    '.alert',
                    '.toast',
                    '[class*="alert-success"]',
                ];
                const seen = new Set();
                for (const sel of selectors) {
                    for (const el of document.querySelectorAll(sel)) {
                        if (seen.has(el)) continue;
                        seen.add(el);
                        const r = el.getBoundingClientRect();
                        if (r.width <= 0 || r.height <= 0) continue;
                        const style = window.getComputedStyle(el);
                        if (style.visibility === 'hidden' || style.display === 'none') continue;
                        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                        if (text.length > 160) continue;
                        if (pattern.test(text)) return true;
                    }
                }
                return false;
            },
            { timeout: timeoutMs, polling: 40 },
            SAVE_SUCCESS_PATTERN.source
        );
        return true;
    } catch {
        return false;
    }
}

async function waitForForecastSaveButtonHidden(page, timeoutMs = 3000) {
    try {
        await page.waitForFunction(
            () => {
                for (const el of document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]')) {
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    const label = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
                    const ngClick = el.getAttribute('ng-click') || '';
                    if (/^save$/i.test(label) || /SaveChanges\s*\(/i.test(ngClick)) return false;
                }
                return true;
            },
            { timeout: timeoutMs, polling: 80 }
        );
        return true;
    } catch {
        return false;
    }
}

/** After Save click: wait for success toast (preferred) or Save button to disappear. */
async function waitForForecastSaveCompleted(page, timeoutMs = SAVE_SUCCESS_TIMEOUT_MS) {
    if (await waitForForecastSaveSuccessToast(page, timeoutMs)) {
        return 'toast';
    }
    if (await waitForForecastSaveButtonHidden(page, Math.min(3000, timeoutMs))) {
        return 'button-hidden';
    }
    return null;
}

/** @deprecated Use waitForForecastSaveCompleted — kept as alias for callers. */
async function waitForForecastSaveSettled(page, timeoutMs = SAVE_SETTLE_MS) {
    await waitForForecastSaveCompleted(page, timeoutMs);
}

/** Top-of-page date on Forecasting/Edit. */
async function readDisplayedForecastDate(page) {
    return page.evaluate((pickerSel) => {
        const valid = (t) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t) && t !== '01/01/1900';
        const host = document.querySelector(pickerSel);
        if (host) {
            for (const span of host.querySelectorAll('.ng-binding')) {
                const t = (span.textContent || '').trim();
                if (valid(t)) return t;
            }
        }
        const spans = [...document.querySelectorAll('span.ng-binding, span.visible-md-and-larger.ng-binding')].filter(
            (s) => valid((s.textContent || '').trim()) && s.children.length === 0
        );
        spans.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        return spans[0] ? spans[0].textContent.trim() : null;
    }, DATE_PICKER_SEL);
}

async function clickForecastDayNav(page, direction) {
    const sel =
        direction === 'next'
            ? `${DATE_PICKER_SEL} button.mx-date-picker-nav-next`
            : `${DATE_PICKER_SEL} button.mx-date-picker-nav-prev`;
    const btn = await page.$(sel);
    if (!btn) return false;
    await btn.click();
    return true;
}

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

function parseUibCalendarTitle(title) {
    const m = String(title || '').match(
        /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i
    );
    if (!m) return null;
    const idx = MONTH_LONG_EN.findIndex((x) => x.toLowerCase() === m[1].toLowerCase());
    if (idx < 0) return null;
    return { monthIndex: idx, year: parseInt(m[2], 10) };
}

async function openForecastDateCalendar(page) {
    const picker = await page.$(`${DATE_PICKER_SEL} .mx-date-picker-selected-date`);
    if (!picker) return false;
    await picker.click();
    try {
        await page.waitForSelector('.uib-datepicker-popup', { visible: true, timeout: 3000 });
        return true;
    } catch {
        return false;
    }
}

/** Jump to date via calendar popup (click day) - much faster than day arrows. */
async function setForecastPageDateByCalendar(page, isoDate) {
    const [year, month, day] = String(isoDate || '').split('-').map(Number);
    if (!year || !month || !day) return { ok: false };

    const previous = await readDisplayedForecastDate(page);
    const opened = await openForecastDateCalendar(page);
    if (!opened) return { ok: false };

    const targetKey = year * 12 + (month - 1);
    for (let step = 0; step < 24; step += 1) {
        const title = await page.evaluate(() => {
            const btn = document.querySelector('.uib-datepicker-popup button.uib-title, .uib-datepicker-popup .mx-date-picker-title');
            return btn ? (btn.textContent || '').trim() : '';
        });
        const parsed = parseUibCalendarTitle(title);
        if (parsed && parsed.year * 12 + parsed.monthIndex === targetKey) break;
        if (!parsed) return { ok: false, reason: 'calendar-title' };

        const curKey = parsed.year * 12 + parsed.monthIndex;
        const sel = curKey < targetKey ? 'button.uib-right' : 'button.uib-left';
        const nav = await page.$(`.uib-datepicker-popup ${sel}`);
        if (!nav) return { ok: false, reason: 'calendar-nav' };
        await nav.click();
        await page
            .waitForFunction(
                (prev) => {
                    const btn = document.querySelector(
                        '.uib-datepicker-popup button.uib-title, .uib-datepicker-popup .mx-date-picker-title'
                    );
                    return btn && (btn.textContent || '').trim() !== prev;
                },
                { timeout: 3000, polling: POLL_MS },
                title
            )
            .catch(() => {});
    }

    const picked = await page.evaluate((dayNum) => {
        const popup = document.querySelector('.uib-datepicker-popup');
        if (!popup) return { ok: false, reason: 'no-popup' };
        const want = String(dayNum);
        const wantPad = String(dayNum).padStart(2, '0');
        for (const td of popup.querySelectorAll('td.uib-day')) {
            if (td.classList.contains('text-muted')) continue;
            const btn = td.querySelector('button');
            if (!btn) continue;
            const t = (btn.textContent || '').trim();
            if (t !== want && t !== wantPad) continue;
            btn.click();
            return { ok: true };
        }
        return { ok: false, reason: 'day-not-found' };
    }, day);

    if (!picked.ok) {
        await page.keyboard.press('Escape').catch(() => {});
        return { ok: false, ...picked };
    }

    const displayStr = isoToMmxDate(isoDate);
    await waitForDisplayedForecastDate(page, displayStr);
    await waitForForecastGrid(page);
    const current = await readDisplayedForecastDate(page);
    if (current === displayStr) {
        return { ok: true, method: 'calendar-pick', previous, display: displayStr };
    }
    return { ok: false, current, reason: 'verify-failed' };
}

async function setForecastPageDateByAdjacentDay(page, isoDate, dateWaitMs = DATE_CHANGE_MS) {
    const displayStr = isoToMmxDate(isoDate);
    const currentIso = mmxDateToIso(await readDisplayedForecastDate(page));
    const diff = dayDiffIso(currentIso, isoDate);
    if (Math.abs(diff) !== 1) return { ok: false };

    const dir = diff > 0 ? 'next' : 'prev';
    const clicked = await clickForecastDayNav(page, dir);
    if (!clicked) return { ok: false };

    await waitForDisplayedForecastDate(page, displayStr, dateWaitMs);
    await waitForForecastGrid(page);
    const current = await readDisplayedForecastDate(page);
    if (current === displayStr) {
        return { ok: true, method: 'day-adjacent', previous: isoToMmxDate(currentIso), display: displayStr };
    }
    return { ok: false, current };
}

async function setForecastPageDateByDayNav(page, isoDate) {
    const targetMmx = isoToMmxDate(isoDate);
    let previous = await readDisplayedForecastDate(page);
    for (let step = 0; step < 45; step += 1) {
        const current = await readDisplayedForecastDate(page);
        if (current === targetMmx) {
            return { ok: true, method: 'day-nav', previous, steps: step };
        }
        const currentIso = mmxDateToIso(current);
        if (!currentIso) break;
        const cur = new Date(`${currentIso}T12:00:00Z`);
        const tgt = new Date(`${isoDate}T12:00:00Z`);
        const dir = tgt > cur ? 'next' : 'prev';
        const clicked = await clickForecastDayNav(page, dir);
        if (!clicked) break;
        await waitForDisplayedForecastDate(page, targetMmx, 4000);
        await waitForForecastGrid(page);
    }
    return { ok: false };
}

async function setForecastPageDateByKeyboard(page, displayStr) {
    const picker = await page.$(`${DATE_PICKER_SEL} .mx-date-picker-selected-date`);
    if (!picker) return { ok: false };
    await picker.click();
    await page.waitForSelector(`${DATE_PICKER_SEL} .mx-date-picker-selected-date`, { visible: true, timeout: 3000 }).catch(
        () => null
    );
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type(displayStr, { delay: 35 });
    await page.keyboard.press('Enter');
    const landed = await waitForDisplayedForecastDate(page, displayStr, DATE_CHANGE_MS);
    const current = await readDisplayedForecastDate(page);
    if (landed || current === displayStr) {
        return { ok: true, method: 'keyboard-type', previous: current };
    }
    return { ok: false, current };
}

async function setForecastPageDateByHiddenInput(page, displayStr) {
    return page.evaluate((wantDate) => {
        function fireInput(el, value) {
            el.removeAttribute('readonly');
            el.removeAttribute('disabled');
            el.focus();
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        for (const inp of document.querySelectorAll('input[type="text"], input:not([type="hidden"])')) {
            const v = (inp.value || '').trim();
            if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v) || /date/i.test(inp.id || '') || /date/i.test(inp.name || '')) {
                fireInput(inp, wantDate);
                return { ok: true, method: 'date-input', id: inp.id || null, previous: v || null };
            }
        }
        return { ok: false };
    }, displayStr);
}

function resolveForecastHeadless(options = {}) {
    if (options.headless === false) return false;
    if (options.headless === true) return true;
    const forecastRaw = process.env.FORECAST_SCRAPER_HEADLESS;
    if (forecastRaw !== undefined && forecastRaw !== '') {
        return !/^(0|false|no|off)$/i.test(String(forecastRaw).trim());
    }
    return true;
}

function formatHourLabel(hour) {
    const h = Number(hour);
    if (!Number.isFinite(h)) return '';
    const normalized = ((h % 24) + 24) % 24;
    if (normalized === 0 || normalized === 24) return '12:00 AM';
    if (normalized === 12) return '12:00 PM';
    if (normalized < 12) return `${normalized}:00 AM`;
    return `${normalized - 12}:00 PM`;
}

/** Reverse of formatHourLabel — e.g. "10:00 AM" → 10, "12:00 PM" → 12. */
function parseHourLabel(label) {
    const m = String(label || '').match(/^(\d{1,2}):00\s*(AM|PM)$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const pm = m[2].toUpperCase() === 'PM';
    if (h === 12 && !pm) return 0;
    if (h === 12 && pm) return 12;
    if (!pm) return h;
    return h + 12;
}

function isWithinTradingHours(hour, openHour, closeHour) {
    const h = Number(hour);
    const open = Number(openHour);
    const close = Number(closeHour);
    if (!Number.isFinite(h) || !Number.isFinite(open) || !Number.isFinite(close)) return false;
    return h >= open && h < close;
}

async function listForecastGridHourLabels(page) {
    return page.evaluate(() => {
        const labels = [];
        for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
            const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
            const label = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
            if (label) labels.push(label);
        }
        return labels;
    });
}

async function readAllManagerForecastCells(page) {
    return page.evaluate(() => {
        const out = {};
        for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
            const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
            const rowLabel = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
            if (!rowLabel) continue;
            const cell =
                tr.querySelector('[id*="managerforecast"]') ||
                tr.querySelector('td.mx-grid-column-input');
            if (!cell) continue;
            out[rowLabel] = (cell.textContent || '').replace(/\s+/g, ' ').trim();
        }
        return out;
    });
}

/** Trading-hour plan slots plus $0 for every other hour row visible on the MMX grid. */
async function buildDayFillSlots(page, day, openHour, closeHour) {
    const open = Number(openHour);
    const close = Number(closeHour);
    const trading = normalizeHourlySlots(day.hourly || []).filter((slot) =>
        isWithinTradingHours(slot.hour, open, close)
    );
    const gridLabels = await listForecastGridHourLabels(page);
    const tradingLabels = new Set(trading.map((s) => s.label));
    const outside = [];

    for (const label of gridLabels) {
        if (tradingLabels.has(label)) continue;
        const hour = parseHourLabel(label);
        if (hour == null) continue;
        outside.push({ hour, label, forecast: 0, outsideHours: true });
    }

    return [...trading, ...outside];
}

async function waitForForecastGrid(page, { minRows = 1, timeoutMs = GRID_WAIT_MS } = {}) {
    await page
        .waitForFunction(
            () =>
                document.querySelectorAll('tr.mx-fg-hour').length > 0 ||
                document.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]') ||
                document.querySelector('table.forecastGrid'),
            { timeout: timeoutMs, polling: POLL_MS }
        )
        .catch(() => {});
    await waitForForecastHourRows(page, { minRows, timeoutMs });
}

async function countForecastHourRows(page) {
    return page.evaluate(() => {
        return [...document.querySelectorAll('tr.mx-fg-hour')].filter((tr) =>
            tr.querySelector('[id*="managerforecast"], td.mx-grid-column-input')
        ).length;
    });
}

/** Poll until the manager-forecast grid shows enough rows and the first planned hour label. */
async function ensureForecastGridReadyForHours(page, hourly, options = {}) {
    const slots = normalizeHourlySlots(hourly);
    const minRows = Math.max(1, Math.min(slots.length, Number(options.minRows) || 8));
    const firstLabel = slots[0]?.label || '';
    const timeoutMs = Number(options.timeoutMs) || GRID_WAIT_MS;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const ready = await page.evaluate(
            (min, label) => {
                const rows = [...document.querySelectorAll('tr.mx-fg-hour')].filter((tr) =>
                    tr.querySelector('[id*="managerforecast"], td.mx-grid-column-input')
                );
                if (rows.length < min) return false;
                if (!label) return true;
                return rows.some((tr) => {
                    const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
                    const rowLabel = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
                    return rowLabel === label;
                });
            },
            minRows,
            firstLabel
        );
        if (ready) return true;
        await page.waitForTimeout(POLL_MS);
    }
    return false;
}

/** Wait until manager-forecast hour rows are present (grid finished reloading after date change). */
async function waitForForecastHourRows(page, { minRows = 8, timeoutMs = GRID_WAIT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const count = await countForecastHourRows(page);
        if (count >= minRows) return true;
        await page.waitForTimeout(POLL_MS);
    }
    return (await countForecastHourRows(page)) >= minRows;
}

async function waitForOverrideEditorClosed(page, timeoutMs = OVERRIDE_CLOSE_MS) {
    try {
        await page.waitForFunction(
            () => {
                const inp = document.querySelector('#overrideInput');
                if (!inp) return true;
                const r = inp.getBoundingClientRect();
                return r.width <= 0 || r.height <= 0;
            },
            { timeout: timeoutMs, polling: POLL_MS }
        );
        return true;
    } catch {
        return false;
    }
}

/** Poll until inline editor is gone and the manager-forecast cell shows the committed value. */
async function waitForCellCommitted(page, wantLabel, wanted, timeoutMs = VERIFY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const editorClosed = await page.evaluate(() => {
            const inp = document.querySelector('#overrideInput');
            if (!inp) return true;
            const r = inp.getBoundingClientRect();
            return r.width <= 0 || r.height <= 0;
        });
        if (editorClosed) {
            const readText = await readManagerForecastCell(page, wantLabel);
            if (forecastValuesMatch(readText, wanted)) return true;
        }
        await page.waitForTimeout(POLL_MS);
    }
    return false;
}

function commitTimeoutForValue(forecast, options = {}) {
    if (options.fastZero || (Math.round(Number(forecast) || 0) === 0 && options.outsideHours)) {
        return ZERO_VERIFY_TIMEOUT_MS;
    }
    if (Math.round(Number(forecast) || 0) === 0) return ZERO_VERIFY_TIMEOUT_MS;
    return VERIFY_TIMEOUT_MS;
}

async function dismissForecastOverrideEditor(page) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => {
        const inp = document.querySelector('#overrideInput');
        if (inp) inp.blur();
        const header = document.querySelector('#ForecastGridHeader, .mx-grid-header-container');
        header?.click();
    });
    await waitForOverrideEditorClosed(page);
}

/** Close inline editor without waiting — used between rapid back-to-back cell entries. */
async function dismissForecastOverrideEditorQuick(page) {
    if (!(await isOverrideEditorVisible(page))) return;
    await page.evaluate(() => {
        const inp = document.querySelector('#overrideInput');
        if (inp) {
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            inp.blur();
        }
    });
}

async function ensureManagerForecastDollarMode(page) {
    const already = await page.evaluate(() => {
        for (const btn of document.querySelectorAll('#ForecastGridHeader button.mx-panel-button')) {
            if ((btn.textContent || '').trim() !== '$') continue;
            return btn.classList.contains('btn-success');
        }
        return false;
    });
    if (already) return;

    await page.evaluate(() => {
        for (const btn of document.querySelectorAll('#ForecastGridHeader button.mx-panel-button')) {
            if ((btn.textContent || '').trim() !== '$') continue;
            if (!btn.classList.contains('btn-success')) btn.click();
            break;
        }
    });
    await page
        .waitForFunction(
            () => {
                for (const btn of document.querySelectorAll('#ForecastGridHeader button.mx-panel-button')) {
                    if ((btn.textContent || '').trim() !== '$') continue;
                    return btn.classList.contains('btn-success');
                }
                return false;
            },
            { timeout: DOLLAR_MODE_MS, polling: POLL_MS }
        )
        .catch(() => {});
}

function parseForecastDollar(text) {
    if (text == null || text === '') return null;
    const match = String(text).match(/-?\$?\s*([\d,]+(?:\.\d+)?)/);
    if (!match) return null;
    const n = Number(String(match[1]).replace(/,/g, ''));
    return Number.isFinite(n) ? Math.round(n) : null;
}

function forecastValuesMatch(readText, want) {
    const wanted = Math.round(Number(want) || 0);
    const read = parseForecastDollar(readText);
    if (wanted === 0) {
        return read === 0;
    }
    if (read == null) return false;
    return read === wanted;
}

function normalizeHourlySlots(hourly) {
    return (hourly || []).map((slot) => ({
        hour: slot.hour,
        label: slot.label || formatHourLabel(slot.hour),
        forecast: Math.round(Number(slot.forecast) || 0),
        ...(slot.outsideHours ? { outsideHours: true } : {}),
    }));
}

function emitSlotProgress(onProgress, payload) {
    if (typeof onProgress !== 'function') return;
    try {
        onProgress(payload);
    } catch (_) {
        /* ignore UI progress errors */
    }
}

async function readManagerForecastCell(page, wantLabel) {
    return page.evaluate((label) => {
        for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
            const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
            const rowLabel = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
            if (rowLabel !== label) continue;
            const cell =
                tr.querySelector('[id*="managerforecast"]') ||
                tr.querySelector('td.mx-grid-column-input');
            if (!cell) return null;
            return (cell.textContent || '').replace(/\s+/g, ' ').trim();
        }
        return null;
    }, wantLabel);
}

async function waitForManagerForecastValue(page, wantLabel, forecast, timeoutMs = VERIFY_TIMEOUT_MS) {
    const wanted = Math.round(Number(forecast) || 0);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const readText = await readManagerForecastCell(page, wantLabel);
        if (forecastValuesMatch(readText, wanted)) {
            return { ok: true, read: parseForecastDollar(readText), readText };
        }
        await page.waitForTimeout(VERIFY_POLL_MS);
    }
    const readText = await readManagerForecastCell(page, wantLabel);
    return {
        ok: forecastValuesMatch(readText, wanted),
        read: parseForecastDollar(readText),
        readText,
    };
}

/** Commit a value into #overrideInput (Angular-aware) so MMX replaces existing manager values. */
async function writeForecastOverrideValue(page, value, options = {}) {
    const text = String(Math.round(Number(value) || 0));
    if (!options.skipWait) {
        const ready = await page
            .waitForSelector(MANAGER_OVERRIDE_INPUT, { visible: true, timeout: 2000 })
            .catch(() => null);
        if (!ready) return false;
    } else if (!(await isOverrideEditorVisible(page))) {
        return false;
    }

    const ok = await page.evaluate(
        (sel, val) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            el.focus();
            if (typeof el.select === 'function') el.select();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, val);
            else el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
            el.blur();
            return true;
        },
        MANAGER_OVERRIDE_INPUT,
        text
    );
    return Boolean(ok);
}

async function findForecastHourRowHandle(page, wantLabel) {
    const handle = await page.evaluateHandle((label) => {
        for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
            const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
            const rowLabel = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
            if (rowLabel !== label) continue;
            return tr;
        }
        return null;
    }, wantLabel);
    const row = handle.asElement();
    if (!row) {
        await handle.dispose();
        return null;
    }
    return row;
}

async function isOverrideEditorVisible(page) {
    return page.evaluate(() => {
        const inp = document.querySelector('#overrideInput');
        if (!inp) return false;
        const r = inp.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    });
}

/** Open manager-forecast inline editor via real Puppeteer clicks (synthetic events are unreliable in MMX). */
async function openForecastHourCell(page, wantLabel, options = {}) {
    const quick = Boolean(options.quick);
    const cellSelectors = [
        '[id*="managerforecast"]',
        'td.mx-grid-column-input span.form-control',
        'td.mx-grid-column-input',
        'td:last-child',
    ];

    for (let attempt = 0; attempt < (quick ? 2 : 3); attempt += 1) {
        if (attempt > 0) {
            if (quick) await dismissForecastOverrideEditorQuick(page);
            else await dismissForecastOverrideEditor(page);
        }

        const row = await findForecastHourRowHandle(page, wantLabel);
        if (!row) return false;

        await row.evaluate(
            (el, isQuick) => el.scrollIntoView({ block: 'center', inline: 'nearest' }),
            quick
        );
        if (!quick) {
            await page
                .waitForFunction(
                    (label) => {
                        for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
                            const labelSpan = tr.querySelector(
                                '[id^="mx-forecast-grid-interval-directive-list-hour-"]'
                            );
                            const rowLabel = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
                            if (rowLabel !== label) continue;
                            const r = tr.getBoundingClientRect();
                            return r.top >= 0 && r.bottom <= window.innerHeight;
                        }
                        return false;
                    },
                    { timeout: 1500, polling: POLL_MS },
                    wantLabel
                )
                .catch(() => {});
        }

        for (const sel of cellSelectors) {
            const cell = await row.$(sel);
            if (!cell) continue;
            try {
                await cell.click({ clickCount: 2, delay: CELL_CLICK_DELAY_MS });
                if (await isOverrideEditorVisible(page)) {
                    await row.dispose();
                    return true;
                }
                await cell.click({ delay: CELL_CLICK_DELAY_MS });
                if (await isOverrideEditorVisible(page)) {
                    await row.dispose();
                    return true;
                }
            } catch {
                /* try next selector */
            }
        }
        await row.dispose();
    }
    return false;
}

/** Click hour row Manager Forecast cell, fill #overrideInput (MMX inline editor). */
async function fillForecastHourCell(page, wantLabel, forecast, options = {}) {
    const wanted = Math.round(Number(forecast) || 0);
    const force = Boolean(options.force);
    const cellCache = options.cellCache;

    if (await isOverrideEditorVisible(page)) {
        if (options.continuous) {
            await dismissForecastOverrideEditorQuick(page);
            await waitForOverrideEditorClosed(page, OVERRIDE_CLOSE_CONTINUOUS_MS);
        } else {
            await dismissForecastOverrideEditor(page);
        }
    }

    const readExisting = () => {
        if (cellCache && Object.prototype.hasOwnProperty.call(cellCache, wantLabel)) {
            return cellCache[wantLabel];
        }
        return readManagerForecastCell(page, wantLabel);
    };

    if (!force) {
        const existing = await readExisting();
        if (forecastValuesMatch(existing, wanted)) {
            return 'already';
        }
    }

    const clicked = await openForecastHourCell(
        page,
        wantLabel,
        options.continuous ? { quick: true } : {}
    );
    if (!clicked) return false;

    try {
        await page.waitForSelector(MANAGER_OVERRIDE_INPUT, {
            visible: true,
            timeout: options.continuous ? 1500 : 3500,
        });
    } catch {
        const afterClick = await readManagerForecastCell(page, wantLabel);
        if (forecastValuesMatch(afterClick, wanted)) return 'already';
        return false;
    }

    let wrote = await writeForecastOverrideValue(page, wanted, { skipWait: options.continuous });
    if (!wrote) {
        wrote = await page.evaluate(
            (sel, val) => {
                const el = document.querySelector(sel);
                if (!el) return false;
                el.focus();
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.blur();
                return true;
            },
            MANAGER_OVERRIDE_INPUT,
            String(wanted)
        );
    }
    if (!wrote) return false;

    if (options.continuous) {
        cacheForecastCellValue(cellCache, wantLabel, wanted);
        return true;
    }

    const committed = await waitForCellCommitted(
        page,
        wantLabel,
        wanted,
        commitTimeoutForValue(wanted, options)
    );
    await dismissForecastOverrideEditor(page);
    if (committed && cellCache) {
        cacheForecastCellValue(cellCache, wantLabel, wanted);
    }
    return committed ? true : false;
}

function cacheForecastCellValue(cellCache, wantLabel, wanted) {
    if (!cellCache) return;
    cellCache[wantLabel] = wanted === 0 ? '$0.00' : `$${wanted.toLocaleString('en-US')}.00`;
}

async function enterAndVerifyForecastSlot(page, slot, onProgress, options = {}) {
    const { retry = false, cellCache = null } = options;
    const preRead =
        cellCache && Object.prototype.hasOwnProperty.call(cellCache, slot.label)
            ? cellCache[slot.label]
            : await readManagerForecastCell(page, slot.label);
    if (forecastValuesMatch(preRead, slot.forecast)) {
        const read = parseForecastDollar(preRead);
        emitSlotProgress(onProgress, {
            type: 'hour-confirmed',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            read,
            skipped: true,
        });
        return { ok: true, read };
    }

    emitSlotProgress(onProgress, {
        type: 'hour-entering',
        hour: slot.hour,
        label: slot.label,
        forecast: slot.forecast,
        retry,
        outsideHours: Boolean(slot.outsideHours),
    });

    const fillOpts = {
        cellCache,
        outsideHours: slot.outsideHours,
        fastZero: slot.outsideHours || slot.forecast === 0,
        continuous: Boolean(options.continuous),
    };
    const filled = await fillForecastHourCell(page, slot.label, slot.forecast, fillOpts);
    if (!filled) {
        if (!retry && slot.forecast !== 0 && !slot.outsideHours) {
            await dismissForecastOverrideEditor(page);
            return enterAndVerifyForecastSlot(page, slot, onProgress, { retry: true, cellCache });
        }
        emitSlotProgress(onProgress, {
            type: 'hour-failed',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            reason: 'Could not open forecast cell',
        });
        return { ok: false, reason: 'no-fill' };
    }

    if (filled === 'already') {
        const read = parseForecastDollar(preRead);
        emitSlotProgress(onProgress, {
            type: 'hour-confirmed',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            read,
            skipped: true,
        });
        return { ok: true, read };
    }

    if (filled && options.continuous) {
        emitSlotProgress(onProgress, {
            type: 'hour-confirmed',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            read: slot.forecast,
        });
        return { ok: true, read: slot.forecast };
    }

    if (filled) {
        const readText = await readManagerForecastCell(page, slot.label);
        const read = parseForecastDollar(readText);
        emitSlotProgress(onProgress, {
            type: 'hour-confirmed',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            read: read ?? slot.forecast,
        });
        if (cellCache) cacheForecastCellValue(cellCache, slot.label, slot.forecast);
        return { ok: true, read: read ?? slot.forecast };
    }

    return { ok: false, reason: 'no-fill' };
}

/** Fill many manager-forecast cells in one browser turn (avoids per-cell Puppeteer round-trips). */
async function fillForecastSlotsBulkInPage(page, updates) {
    if (!updates?.length) return { filled: [], failed: [] };

    return page.evaluate((rows) => {
        const spin = (ms) => {
            const end = Date.now() + ms;
            while (Date.now() < end) {
                /* yield to Angular digest between cells */
            }
        };

        const parseDollar = (text) => {
            if (text == null || text === '') return null;
            const match = String(text).match(/-?\$?\s*([\d,]+(?:\.\d+)?)/);
            if (!match) return null;
            const n = Number(String(match[1]).replace(/,/g, ''));
            return Number.isFinite(n) ? Math.round(n) : null;
        };

        const valuesMatch = (readText, want) => {
            const wanted = Math.round(Number(want) || 0);
            const read = parseDollar(readText);
            if (wanted === 0) return read === 0;
            if (read == null) return false;
            return read === wanted;
        };

        const rowForLabel = (label) => {
            for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
                const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
                const rowLabel = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
                if (rowLabel === label) return tr;
            }
            return null;
        };

        const readCell = (tr) => {
            const cell =
                tr.querySelector('[id*="managerforecast"]') || tr.querySelector('td.mx-grid-column-input');
            return (cell?.textContent || '').replace(/\s+/g, ' ').trim();
        };

        const overrideOpen = () => {
            const inp = document.querySelector('#overrideInput');
            if (!inp) return false;
            const r = inp.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        };

        const closeOverride = () => {
            const inp = document.querySelector('#overrideInput');
            if (inp) {
                inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
                inp.blur();
            }
        };

        const openCell = (tr) => {
            tr.scrollIntoView({ block: 'center', inline: 'nearest' });
            const selectors = [
                '[id*="managerforecast"]',
                'td.mx-grid-column-input span.form-control',
                'td.mx-grid-column-input',
                'td:last-child',
            ];
            for (const sel of selectors) {
                const cell = tr.querySelector(sel);
                if (!cell) continue;
                cell.click();
                cell.click();
                if (overrideOpen()) return true;
            }
            return false;
        };

        const writeOverride = (val) => {
            const el = document.querySelector('#overrideInput');
            if (!el) return false;
            const text = String(Math.round(Number(val) || 0));
            el.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(el, text);
            else el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
            el.blur();
            return true;
        };

        const filled = [];
        const failed = [];

        for (const row of rows) {
            const label = row.label;
            const forecast = Math.round(Number(row.forecast) || 0);
            const tr = rowForLabel(label);
            if (!tr) {
                failed.push({ label, reason: 'no-row' });
                continue;
            }
            if (valuesMatch(readCell(tr), forecast)) {
                filled.push({ label, skipped: true });
                continue;
            }
            closeOverride();
            spin(1);
            if (!openCell(tr)) {
                failed.push({ label, reason: 'no-open' });
                continue;
            }
            spin(1);
            if (!writeOverride(forecast)) {
                failed.push({ label, reason: 'no-write' });
                continue;
            }
            spin(2);
            filled.push({ label, skipped: false });
        }

        closeOverride();
        return { filled, failed };
    }, updates);
}

/** Fill each hour via bulk in-page loop; slow Puppeteer retry only for mismatches. */
async function fillForecastHourlyInputs(page, hourly, options = {}) {
    if (!options.skipDollarMode) await ensureManagerForecastDollarMode(page);

    const slots = normalizeHourlySlots(hourly);
    const onProgress = options.onProgress;
    const cellCache = options.cellCache || (await readAllManagerForecastCells(page));
    let confirmed = 0;
    const missed = [];
    const failed = [];

    const pending = slots.filter((slot) => !forecastValuesMatch(cellCache[slot.label], slot.forecast));
    for (const slot of slots) {
        if (!pending.some((row) => row.label === slot.label)) {
            confirmed += 1;
            emitSlotProgress(onProgress, {
                type: 'hour-confirmed',
                hour: slot.hour,
                label: slot.label,
                forecast: slot.forecast,
                read: parseForecastDollar(cellCache[slot.label]),
                skipped: true,
            });
        }
    }

    if (pending.length) {
        for (const slot of pending) {
            emitSlotProgress(onProgress, {
                type: 'hour-entering',
                hour: slot.hour,
                label: slot.label,
                forecast: slot.forecast,
                outsideHours: Boolean(slot.outsideHours),
            });
        }

        await dismissForecastOverrideEditor(page).catch(() => {});
        const bulk = await fillForecastSlotsBulkInPage(
            page,
            pending.map((slot) => ({ label: slot.label, forecast: slot.forecast }))
        );

        Object.assign(cellCache, await readAllManagerForecastCells(page));

        for (const slot of pending) {
            if (forecastValuesMatch(cellCache[slot.label], slot.forecast)) {
                confirmed += 1;
                emitSlotProgress(onProgress, {
                    type: 'hour-confirmed',
                    hour: slot.hour,
                    label: slot.label,
                    forecast: slot.forecast,
                    read: parseForecastDollar(cellCache[slot.label]),
                });
            } else {
                const bulkFail = bulk.failed.find((row) => row.label === slot.label);
                missed.push(slot.label);
                failed.push({ ...slot, reason: bulkFail?.reason || 'bulk-mismatch' });
            }
        }
    }

    let changed = pending.length > 0;

    for (const slot of slots) {
        if (!forecastValuesMatch(cellCache[slot.label], slot.forecast)) {
            await dismissForecastOverrideEditor(page).catch(() => {});
            const result = await enterAndVerifyForecastSlot(page, slot, onProgress, {
                cellCache,
                continuous: false,
            });
            if (result.ok) {
                changed = true;
                if (missed.includes(slot.label)) {
                    missed.splice(missed.indexOf(slot.label), 1);
                    failed.splice(
                        failed.findIndex((row) => row.label === slot.label),
                        1
                    );
                }
                confirmed += 1;
                Object.assign(cellCache, await readAllManagerForecastCells(page));
            }
        }
    }

    confirmed = slots.filter((slot) => forecastValuesMatch(cellCache[slot.label], slot.forecast)).length;
    missed.length = 0;
    failed.length = 0;
    for (const slot of slots) {
        if (!forecastValuesMatch(cellCache[slot.label], slot.forecast)) {
            missed.push(slot.label);
            failed.push({ ...slot, reason: 'batch-mismatch' });
        }
    }

    const out = { touched: confirmed, confirmed, missed, failed, slotCount: slots.length, changed };
    const tradingSlots = slots.filter((s) => !s.outsideHours);
    const tradingMissed = missed.filter((label) => {
        const slot = slots.find((s) => s.label === label);
        return slot && !slot.outsideHours;
    });
    if (!tradingSlots.length || tradingMissed.length) {
        throw new Error(
            `No Manager Forecast cells matched (${tradingMissed.join(', ') || out.missed?.join(', ') || 'no slots'}). Check Macromatix grid layout.`
        );
    }
    return out;
}

/** Second pass: read every hour on the page; re-enter any that do not match. */
async function verifyForecastDay(page, hourly, options = {}) {
    const slots = normalizeHourlySlots(hourly);
    const onProgress = options.onProgress;
    const cellCache = options.cellCache || (await readAllManagerForecastCells(page));
    let confirmed = 0;
    const failed = [];

    for (const slot of slots) {
        emitSlotProgress(onProgress, {
            type: 'hour-verifying',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            phase: 'day-check',
        });

        const readText =
            cellCache && Object.prototype.hasOwnProperty.call(cellCache, slot.label)
                ? cellCache[slot.label]
                : await readManagerForecastCell(page, slot.label);
        if (forecastValuesMatch(readText, slot.forecast)) {
            confirmed += 1;
            emitSlotProgress(onProgress, {
                type: 'hour-confirmed',
                hour: slot.hour,
                label: slot.label,
                forecast: slot.forecast,
                read: parseForecastDollar(readText),
                phase: 'day-check',
            });
            continue;
        }

        const fix = await enterAndVerifyForecastSlot(page, slot, onProgress, { cellCache });
        if (fix.ok) {
            confirmed += 1;
        } else {
            failed.push({ ...slot, read: fix.read, reason: fix.reason || 'day-check-failed' });
        }
    }

    return { ok: failed.length === 0, confirmed, slotCount: slots.length, failed };
}

async function waitForForecastSaveButton(page, timeoutMs = 15000) {
    const handle = await page
        .waitForFunction(
            () => {
                for (const el of document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]')) {
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    const style = window.getComputedStyle(el);
                    if (style.visibility === 'hidden' || style.display === 'none') continue;
                    const label = (el.textContent || el.value || el.getAttribute('aria-label') || '')
                        .replace(/\s+/g, ' ')
                        .trim();
                    const ngClick = el.getAttribute('ng-click') || '';
                    if (/^save$/i.test(label) || /SaveChanges\s*\(/i.test(ngClick)) {
                        return {
                            tag: el.tagName,
                            id: el.id || null,
                            label,
                            ngClick: ngClick || null,
                            className: (el.className || '').slice(0, 80),
                        };
                    }
                }
                return null;
            },
            { timeout: timeoutMs, polling: 200 }
        )
        .catch(() => null);
    if (!handle) return null;
    return handle.jsonValue();
}

async function commitForecastDaySave(page, options = {}) {
    const fast = options.fast !== false;
    const savedAs = await clickForecastSave(page, {
        timeoutMs: fast ? SAVE_APPEAR_FAST_MS : SAVE_APPEAR_MS,
        saveSuccessTimeoutMs: SAVE_SUCCESS_TIMEOUT_MS,
    });
    return savedAs || 'unchanged';
}

async function clickForecastSave(page, { timeoutMs = SAVE_APPEAR_MS, saveSuccessTimeoutMs = SAVE_SUCCESS_TIMEOUT_MS } = {}) {
    const meta = await waitForForecastSaveButton(page, timeoutMs);
    if (!meta) return null;

    const clicked = await page.evaluate((want) => {
        for (const el of document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]')) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const label = (el.textContent || el.value || el.getAttribute('aria-label') || '')
                .replace(/\s+/g, ' ')
                .trim();
            const ngClick = el.getAttribute('ng-click') || '';
            if (!/^save$/i.test(label) && !/SaveChanges\s*\(/i.test(ngClick)) continue;
            if (want.id && el.id !== want.id) continue;
            el.click();
            return label || ngClick || 'Save';
        }
        return null;
    }, meta);

    if (clicked) {
        await waitForForecastSaveCompleted(page, saveSuccessTimeoutMs);
        await waitForForecastGrid(page);
    }
    return clicked;
}

/**
 * Set the trading date on Forecasting/Edit via calendar day pick, keyboard, hidden input, or day arrows.
 */
async function setForecastPageDate(page, isoDate, options = {}) {
    const displayStr = isoToMmxDate(isoDate);
    if (!displayStr) throw new Error(`Invalid forecast date: ${isoDate}`);

    if (!options.skipScroll) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page
            .waitForFunction(() => window.scrollY === 0, { timeout: 1000, polling: 40 })
            .catch(() => null);
    }
    await waitForForecastGrid(page);

    const already = await readDisplayedForecastDate(page);
    if (already === displayStr) {
        return { ok: true, method: 'already-set', date: isoDate, display: displayStr, previous: already };
    }

    const currentIso = mmxDateToIso(already);
    const diff = dayDiffIso(currentIso, isoDate);

    let result = { ok: false };
    const dateWait = options.fast ? 1500 : DATE_CHANGE_MS;
    if (Math.abs(diff) === 1) result = await setForecastPageDateByAdjacentDay(page, isoDate, dateWait);
    if (!result.ok && (diff == null || Math.abs(diff) > 1)) result = await setForecastPageDateByCalendar(page, isoDate);
    if (!result.ok) result = await setForecastPageDateByKeyboard(page, displayStr);
    if (!result.ok) result = await setForecastPageDateByHiddenInput(page, displayStr);
    if (!result.ok) result = await setForecastPageDateByDayNav(page, isoDate);

    if (!result.ok) {
        const hints = await page.evaluate(() => {
            const inputs = [...document.querySelectorAll('input')].slice(0, 12).map((inp) => ({
                id: inp.id || null,
                type: inp.type || null,
                value: (inp.value || '').trim().slice(0, 40),
            }));
            const dateTexts = [...document.querySelectorAll('span, button, a')]
                .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
                .filter((t) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t))
                .slice(0, 8);
            return { inputs, dateTexts };
        });
        throw new Error(`Forecast date control not found (${JSON.stringify(hints).slice(0, 400)})`);
    }

    const verified = await readDisplayedForecastDate(page);
    if (verified && verified !== displayStr) {
        throw new Error(`Forecast date did not stick: wanted ${displayStr}, still ${verified}`);
    }

    await waitForForecastGrid(page);
    if (options.fast) {
        await waitForForecastHourRows(page, { minRows: 1, timeoutMs: 800 });
    } else {
        await waitForForecastHourRows(page, { minRows: 1 });
    }

    return { date: isoDate, display: displayStr, ...result };
}

async function writeForecastPlanToSpa(page, storeNumber, plan, options = {}) {
    const sssg = getSssgScraper();
    const store = String(storeNumber || '').trim();
    const { getStoreList, resolveHours } = require('../../../stores/src/storeList');
    const storeRow = getStoreList().find((row) => String(row.storeNumber) === store);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const emit = (payload) => {
        if (!onProgress) return;
        try {
            onProgress({ storeNumber: store, ...payload });
        } catch (_) {
            /* ignore UI progress errors */
        }
    };

    const onForecast = await page.evaluate((storeNum) => {
        const hash = (location.hash || '').toLowerCase();
        const body = document.body?.innerText || '';
        return hash.includes('forecasting/edit') && body.includes(storeNum);
    }, store);

    if (!onForecast) {
        const onChangeStore = await sssg.isOnChangeStorePage(page);
        if (!onChangeStore) {
            await page.goto(CHANGE_STORE_URL, SPA_GOTO_OPTS);
            await waitForForecastGrid(page);
        }
        await sssg.selectStoreOnSpa(page, store, { quick: true });
        await page.goto(FORECASTING_URL, SPA_GOTO_OPTS);
    }

    await waitForForecastGrid(page);
    await ensureManagerForecastDollarMode(page);

    emit({ type: 'store-start', dayCount: (plan || []).length });

    const dayResults = [];
    for (let dayIndex = 0; dayIndex < (plan || []).length; dayIndex += 1) {
        const day = plan[dayIndex];
        const hourly = (day.hourly || []).map((slot) => ({
            hour: slot.hour,
            forecast: slot.forecast,
        }));
        emit({
            type: 'day-start',
            date: day.date,
            weekday: day.weekday,
            forecastTotal: day.forecastTotal,
            hourly,
        });

        const dateResult = await setForecastPageDate(page, day.date, {
            skipScroll: dayIndex > 0,
            fast: dayIndex > 0,
        });
        let gridReady =
            dayIndex > 0 && dateResult.method === 'day-adjacent' && dateResult.ok
                ? await page.evaluate(() => document.querySelectorAll('tr.mx-fg-hour').length >= 8)
                : false;
        if (!gridReady) {
            gridReady = await ensureForecastGridReadyForHours(page, hourly, {
                minRows: Math.min(8, hourly.length),
                timeoutMs: dayIndex > 0 ? 3000 : GRID_WAIT_MS,
            });
        }
        if (!gridReady) {
            await setForecastPageDate(page, day.date, { skipScroll: true, fast: false });
            gridReady = await ensureForecastGridReadyForHours(page, hourly, {
                minRows: Math.min(8, hourly.length),
                timeoutMs: GRID_WAIT_MS,
            });
        }
        if (!gridReady) {
            const visible = await countForecastHourRows(page);
            const display = await readDisplayedForecastDate(page);
            throw new Error(
                `Forecast grid not ready for ${day.date} (${visible} hour rows visible, date showing ${display || 'unknown'}).`
            );
        }
        await dismissForecastOverrideEditor(page).catch(() => {});
        emit({ type: 'day-filling', date: day.date });

        if (dayIndex === 0) {
            await ensureManagerForecastDollarMode(page);
        }
        const dayHours = storeRow
            ? resolveHours(storeRow, new Date(`${day.date}T12:00:00`))
            : { openHour: day.openHour, closeHour: day.closeHour };
        const dayForFill = {
            ...day,
            openHour: dayHours.openHour ?? day.openHour,
            closeHour: dayHours.closeHour ?? day.closeHour,
        };
        const fillSlots = await buildDayFillSlots(page, day, dayForFill.openHour, dayForFill.closeHour);
        const outsideCount = fillSlots.filter((s) => s.outsideHours).length;
        if (outsideCount) {
            emit({
                type: 'day-outside-hours',
                date: day.date,
                outsideCount,
                openHour: dayForFill.openHour,
                closeHour: dayForFill.closeHour,
            });
        }
        const slotProgress = (evt) => emit({ date: day.date, ...evt });
        const fillResult = await fillForecastHourlyInputs(page, fillSlots, {
            skipDollarMode: true,
            onProgress: slotProgress,
        });

        let verifyResult;
        if (fillResult.failed.length === 0 && fillResult.confirmed === fillResult.slotCount) {
            verifyResult = {
                ok: true,
                confirmed: fillResult.confirmed,
                slotCount: fillResult.slotCount,
                failed: [],
                skipped: true,
            };
        } else {
            emit({ type: 'day-verifying', date: day.date });
            verifyResult = await verifyForecastDay(page, fillSlots, { onProgress: slotProgress });
        }
        if (!verifyResult.ok) {
            const tradingFailed = verifyResult.failed.filter((row) => !row.outsideHours);
            const labels = tradingFailed.map((row) => row.label).join(', ');
            if (tradingFailed.length) {
                throw new Error(
                    `Forecast verify failed for ${day.date} (${verifyResult.confirmed}/${verifyResult.slotCount} hours confirmed). Failed: ${labels || 'unknown'}`
                );
            }
        }

        emit({ type: 'day-saving', date: day.date, fill: fillResult, verify: verifyResult });

        const savedAs = fillResult.changed
            ? await commitForecastDaySave(page, { fast: true })
            : 'unchanged';

        const dayResult = {
            date: day.date,
            forecastTotal: day.forecastTotal,
            dateSet: dateResult,
            fill: fillResult,
            verify: verifyResult,
            savedAs,
        };
        dayResults.push(dayResult);
        emit({ type: 'day-done', date: day.date, ...dayResult });
    }

    const hourTouched = dayResults.reduce((sum, d) => sum + (d.verify?.confirmed || d.fill?.confirmed || 0), 0);
    const slotCount = dayResults.reduce((sum, d) => sum + (d.verify?.slotCount || d.fill?.slotCount || 0), 0);
    if (!hourTouched) {
        throw new Error('Could not write any forecast values in Macromatix.');
    }

    const applied = {
        ok: true,
        hourTouched,
        hourVerified: hourTouched,
        slotCount,
        dayTouched: dayResults.length,
        days: dayResults,
    };
    emit({ type: 'store-done', ...applied });
    return applied;
}

async function writeForecastPlanToMmx(storeNumber, plan, options = {}) {
    const scraper = getMacromatixScraper();
    const sssg = getSssgScraper();
    const store = String(storeNumber || '').trim();
    if (!store) throw new Error('Store number is required.');

    const credentials = scraper.resolveMacromatixCredentialsForStore(store);
    if (!credentials?.username || !credentials?.password) {
        throw new Error(`No Macromatix credentials configured for store ${store}.`);
    }

    let browser;
    const headless = resolveForecastHeadless(options);
    try {
        const opened = await scraper.openMacromatixBrowser({
            storeNumber: store,
            mmxUsername: credentials.username,
            mmxPassword: credentials.password,
            browserOptions: { headless, skipSlowMo: headless },
        });
        browser = opened.browser;
        const { page } = opened;

        try {
            const forecastAbort = require('../../../dashboard/src/forecastMmxAbort');
            forecastAbort.resetForecastMmxAbort();
            forecastAbort.registerForecastMmxBrowser(browser);
        } catch {
            /* forecast abort optional outside dashboard process */
        }

        if (!headless) {
            console.log('[Forecast] Headed browser - watch the Macromatix window (FORECAST_SCRAPER_HEADLESS=false)');
        }

        await sssg.ensureSpaAuthenticated(page, credentials, { quick: headless });
        const applied = await writeForecastPlanToSpa(page, store, plan, {
            onProgress: options.onProgress,
        });

        return {
            storeNumber: store,
            forecastDays: plan.length,
            mmx: applied,
        };
    } finally {
        try {
            const forecastAbort = require('../../../dashboard/src/forecastMmxAbort');
            forecastAbort.clearForecastMmxBrowser(browser);
        } catch {
            /* ignore */
        }
        if (!headless && options.keepBrowserOpen) {
            console.log('[Forecast] Headed mode - browser left open (keepBrowserOpen)');
        } else {
            await scraper.closeBrowserQuietly(browser, 'forecast tool');
        }
    }
}

/** Optional MMX backfill for missing history days (slow - use import when possible). */
async function backfillStoreHistoryFromMmx(storeNumber, options = {}) {
    const { recordForecastHistoryDay } = require('../../../dashboard/src/forecast/forecastHistoryLedger');
    const LABOUR_URL =
        'https://tacobellau.macromatix.net/MMS_Stores_LabourScheduler.aspx?MenuCustomItemID=249';
    const scraper = getMacromatixScraper();
    const store = String(storeNumber || '').trim();
    const daysBack = Number(options.daysBack) || 35;
    const credentials = scraper.resolveMacromatixCredentialsForStore(store);
    if (!credentials?.username || !credentials?.password) {
        throw new Error(`No Macromatix credentials configured for store ${store}.`);
    }

    const { addDaysToIso, sumHourly } = require('../../../dashboard/src/forecast/forecastHistoryLedger');
    const melbourneTodayIso = () =>
        new Intl.DateTimeFormat('en-CA', {
            timeZone: process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
        }).format(new Date());

    let browser;
    let imported = 0;
    try {
        const opened = await scraper.openMacromatixBrowser({
            storeNumber: store,
            mmxUsername: credentials.username,
            mmxPassword: credentials.password,
            launchOptions: { headless: true },
        });
        browser = opened.browser;
        const { page } = opened;
        await page.goto(LABOUR_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await scraper.selectStoreOnPage(page, store, { waitMs: 900 });

        const today = melbourneTodayIso();
        const missingDates = [];
        for (let offset = 1; offset <= daysBack; offset += 1) {
            missingDates.push(addDaysToIso(today, -offset));
        }
        const scraped = await scraper.scrapeMissingHistoricalDays(page, missingDates, {
            timeZone: process.env.DASHBOARD_TIME_ZONE || 'Australia/Melbourne',
        });
        for (const data of scraped) {
            const iso = data.dateIso;
            if (!iso) continue;
            const actualRaw = data.actual || [];
            if (sumHourly(actualRaw) <= 0) continue;
            recordForecastHistoryDay(
                store,
                iso,
                {
                    actualRaw,
                    actualFormat: 'raw-mmx',
                    openHour: options.openHour,
                    closeHour: options.closeHour,
                },
                { source: 'mmx-backfill', finalized: true, force: Boolean(options.force) }
            );
            imported += 1;
        }
        return { storeNumber: store, imported };
    } finally {
        await scraper.closeBrowserQuietly(browser, 'forecast backfill');
    }
}

module.exports = {
    CHANGE_STORE_URL,
    FORECASTING_URL,
    isoToMmxDate,
    mmxDateToIso,
    formatHourLabel,
    waitForForecastGrid,
    readDisplayedForecastDate,
    clickForecastDayNav,
    setForecastPageDateByCalendar,
    setForecastPageDate,
    fillForecastHourlyInputs,
    clickForecastSave,
    writeForecastPlanToSpa,
    writeForecastPlanToMmx,
    backfillStoreHistoryFromMmx,
};
