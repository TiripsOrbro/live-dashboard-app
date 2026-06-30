const MMX_SPA_BASE = 'https://m-tacobellau.macromatix.net/';
const CHANGE_STORE_URL = `${MMX_SPA_BASE}#/Administration/ChangeStore?metric=sales`;
const FORECASTING_URL = `${MMX_SPA_BASE}#/Forecasting/Edit?metric=sales`;
const SPA_GOTO_OPTS = { waitUntil: 'load', timeout: 60000 };
const GRID_WAIT_MS = 20000;

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
const FILL_CELL_SETTLE_MS = 25;
const VERIFY_READ_MS = 120;
const VERIFY_POLL_MS = 80;
const VERIFY_TIMEOUT_MS = 2500;
const POST_DATE_GRID_MS = 350;
const GRID_SETTLE_MS = 100;
const DATE_CHANGE_MS = 6000;
const SAVE_SETTLE_MS = 2500;
const SAVE_APPEAR_MS = 700;

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

async function waitForForecastSaveSettled(page, timeoutMs = SAVE_SETTLE_MS) {
    await page
        .waitForFunction(
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
        )
        .catch(() => {});
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
    await page.waitForTimeout(150);
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
        await page.waitForTimeout(120);
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
    await waitForForecastGrid(page, { settleMs: GRID_SETTLE_MS });
    const current = await readDisplayedForecastDate(page);
    if (current === displayStr) {
        return { ok: true, method: 'calendar-pick', previous, display: displayStr };
    }
    return { ok: false, current, reason: 'verify-failed' };
}

async function setForecastPageDateByAdjacentDay(page, isoDate) {
    const displayStr = isoToMmxDate(isoDate);
    const currentIso = mmxDateToIso(await readDisplayedForecastDate(page));
    const diff = dayDiffIso(currentIso, isoDate);
    if (Math.abs(diff) !== 1) return { ok: false };

    const dir = diff > 0 ? 'next' : 'prev';
    const clicked = await clickForecastDayNav(page, dir);
    if (!clicked) return { ok: false };

    await waitForDisplayedForecastDate(page, displayStr);
    await waitForForecastGrid(page, { settleMs: GRID_SETTLE_MS });
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
        await waitForForecastGrid(page, { settleMs: GRID_SETTLE_MS });
    }
    return { ok: false };
}

async function setForecastPageDateByKeyboard(page, displayStr) {
    const picker = await page.$(`${DATE_PICKER_SEL} .mx-date-picker-selected-date`);
    if (!picker) return { ok: false };
    await picker.click();
    await page.waitForTimeout(400);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type(displayStr, { delay: 35 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const current = await readDisplayedForecastDate(page);
    if (current === displayStr) {
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

async function waitForForecastGrid(page, { settleMs = GRID_SETTLE_MS } = {}) {
    await page
        .waitForFunction(
            () =>
                document.querySelectorAll('tr.mx-fg-hour').length > 0 ||
                document.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]') ||
                document.querySelector('table.forecastGrid'),
            { timeout: GRID_WAIT_MS }
        )
        .catch(() => {});
    if (settleMs > 0) await page.waitForTimeout(settleMs);
}

/** Wait until manager-forecast hour rows are present (grid finished reloading after date change). */
async function waitForForecastHourRows(page, { minRows = 8, timeoutMs = GRID_WAIT_MS } = {}) {
    await page
        .waitForFunction(
            (min) => {
                const rows = [...document.querySelectorAll('tr.mx-fg-hour')].filter((tr) =>
                    tr.querySelector('[id*="managerforecast"], td.mx-grid-column-input')
                );
                return rows.length >= min;
            },
            { timeout: timeoutMs },
            minRows
        )
        .catch(() => {});
    await page.waitForTimeout(POST_DATE_GRID_MS);
}

async function dismissForecastOverrideEditor(page) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => {
        const inp = document.querySelector('#overrideInput');
        if (inp) inp.blur();
        const header = document.querySelector('#ForecastGridHeader, .mx-grid-header-container');
        header?.click();
    });
    await page.waitForTimeout(40);
}

async function ensureManagerForecastDollarMode(page, { skipWait = false } = {}) {
    await page.evaluate(() => {
        for (const btn of document.querySelectorAll('#ForecastGridHeader button.mx-panel-button')) {
            if ((btn.textContent || '').trim() !== '$') continue;
            if (!btn.classList.contains('btn-success')) btn.click();
            break;
        }
    });
    if (!skipWait) await page.waitForTimeout(80);
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
    if (read == null) return wanted === 0;
    return read === wanted;
}

function normalizeHourlySlots(hourly) {
    return (hourly || []).map((slot) => ({
        hour: slot.hour,
        label: formatHourLabel(slot.hour),
        forecast: Math.round(Number(slot.forecast) || 0),
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

/** Click hour row Manager Forecast cell, fill #overrideInput (MMX inline editor). */
async function fillForecastHourCell(page, wantLabel, forecast) {
    const wanted = Math.round(Number(forecast) || 0);
    await dismissForecastOverrideEditor(page);

    const existing = await readManagerForecastCell(page, wantLabel);
    if (forecastValuesMatch(existing, wanted)) {
        return 'already';
    }

    const clicked = await page.evaluate((label) => {
        for (const tr of document.querySelectorAll('tr.mx-fg-hour')) {
            const labelSpan = tr.querySelector('[id^="mx-forecast-grid-interval-directive-list-hour-"]');
            const rowLabel = (labelSpan?.textContent || '').replace(/\s+/g, ' ').trim();
            if (rowLabel !== label) continue;
            const cell =
                tr.querySelector('[id*="managerforecast"]') ||
                tr.querySelector('td.mx-grid-column-input') ||
                tr.querySelector('td:last-child');
            if (!cell) return false;
            cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            cell.click();
            return true;
        }
        return false;
    }, wantLabel);
    if (!clicked) return false;

    try {
        await page.waitForSelector(MANAGER_OVERRIDE_INPUT, { visible: true, timeout: 3500 });
    } catch {
        const afterClick = await readManagerForecastCell(page, wantLabel);
        return forecastValuesMatch(afterClick, wanted) ? 'already' : false;
    }

    const value = String(wanted);
    const ok = await page.evaluate(
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
        value
    );
    if (!ok) return false;
    await dismissForecastOverrideEditor(page);
    await page.waitForTimeout(FILL_CELL_SETTLE_MS);
    return true;
}

async function enterAndVerifyForecastSlot(page, slot, onProgress, { retry = false } = {}) {
    const preRead = await readManagerForecastCell(page, slot.label);
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
    });

    const filled = await fillForecastHourCell(page, slot.label, slot.forecast);
    if (!filled) {
        emitSlotProgress(onProgress, {
            type: 'hour-failed',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            reason: 'Could not open forecast cell',
        });
        return { ok: false, reason: 'no-fill' };
    }

    emitSlotProgress(onProgress, {
        type: 'hour-verifying',
        hour: slot.hour,
        label: slot.label,
        forecast: slot.forecast,
    });

    const verified = await waitForManagerForecastValue(page, slot.label, slot.forecast);
    if (!verified.ok) {
        if (!retry) {
            return enterAndVerifyForecastSlot(page, slot, onProgress, { retry: true });
        }
        emitSlotProgress(onProgress, {
            type: 'hour-failed',
            hour: slot.hour,
            label: slot.label,
            forecast: slot.forecast,
            read: verified.read,
            reason:
                verified.read == null
                    ? 'Could not read cell after entry'
                    : `Read $${verified.read}, expected $${slot.forecast}`,
        });
        return { ok: false, reason: 'mismatch', read: verified.read };
    }

    emitSlotProgress(onProgress, {
        type: 'hour-confirmed',
        hour: slot.hour,
        label: slot.label,
        forecast: slot.forecast,
        read: verified.read,
    });
    return { ok: true, read: verified.read };
}

/** Fill each hour, verify read-back, retry once on mismatch. */
async function fillForecastHourlyInputs(page, hourly, options = {}) {
    if (!options.skipDollarMode) await ensureManagerForecastDollarMode(page, { skipWait: true });

    const slots = normalizeHourlySlots(hourly);
    const onProgress = options.onProgress;
    let confirmed = 0;
    const missed = [];
    const failed = [];

    for (const slot of slots) {
        const result = await enterAndVerifyForecastSlot(page, slot, onProgress);
        if (result.ok) {
            confirmed += 1;
        } else {
            missed.push(slot.label);
            failed.push({ ...slot, read: result.read, reason: result.reason });
        }
    }

    const out = { touched: confirmed, confirmed, missed, failed, slotCount: slots.length };
    if (!out.confirmed) {
        throw new Error(
            `No Manager Forecast cells matched (${out.missed?.join(', ') || 'no slots'}). Check Macromatix grid layout.`
        );
    }
    return out;
}

/** Second pass: read every hour on the page; re-enter any that do not match. */
async function verifyForecastDay(page, hourly, options = {}) {
    const slots = normalizeHourlySlots(hourly);
    const onProgress = options.onProgress;
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

        const readText = await readManagerForecastCell(page, slot.label);
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

        const fix = await enterAndVerifyForecastSlot(page, slot, onProgress, { retry: false });
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

async function commitForecastDaySave(page) {
    const savedAs = await clickForecastSave(page, { timeoutMs: SAVE_APPEAR_MS });
    return savedAs || 'unchanged';
}

async function clickForecastSave(page, { timeoutMs = SAVE_APPEAR_MS } = {}) {
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
        await waitForForecastSaveSettled(page);
        await waitForForecastGrid(page, { settleMs: GRID_SETTLE_MS });
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
        await page.waitForTimeout(80);
    }
    await waitForForecastGrid(page, { settleMs: options.fast ? 0 : GRID_SETTLE_MS });

    const already = await readDisplayedForecastDate(page);
    if (already === displayStr) {
        return { ok: true, method: 'already-set', date: isoDate, display: displayStr, previous: already };
    }

    const currentIso = mmxDateToIso(already);
    const diff = dayDiffIso(currentIso, isoDate);

    let result = { ok: false };
    if (Math.abs(diff) === 1) result = await setForecastPageDateByAdjacentDay(page, isoDate);
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

    await waitForForecastGrid(page, { settleMs: GRID_SETTLE_MS });
    await waitForForecastHourRows(page, { minRows: 1 });

    return { date: isoDate, display: displayStr, ...result };
}

async function writeForecastPlanToSpa(page, storeNumber, plan, options = {}) {
    const sssg = getSssgScraper();
    const store = String(storeNumber || '').trim();
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
            await page.waitForTimeout(250);
        }
        await sssg.selectStoreOnSpa(page, store, { quick: true });
        await page.goto(FORECASTING_URL, SPA_GOTO_OPTS);
    }

    await waitForForecastGrid(page);
    await ensureManagerForecastDollarMode(page, { skipWait: true });

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
        await waitForForecastHourRows(page, { minRows: Math.min(8, hourly.length) });
        await dismissForecastOverrideEditor(page);
        emit({ type: 'day-filling', date: day.date });

        await ensureManagerForecastDollarMode(page, { skipWait: true });
        const slotProgress = (evt) => emit({ date: day.date, ...evt });
        const fillResult = await fillForecastHourlyInputs(page, hourly, {
            skipDollarMode: true,
            onProgress: slotProgress,
        });

        emit({ type: 'day-verifying', date: day.date });
        const verifyResult = await verifyForecastDay(page, hourly, { onProgress: slotProgress });
        if (!verifyResult.ok) {
            const labels = verifyResult.failed.map((row) => row.label).join(', ');
            throw new Error(
                `Forecast verify failed for ${day.date} (${verifyResult.confirmed}/${verifyResult.slotCount} hours confirmed). Failed: ${labels || 'unknown'}`
            );
        }

        emit({ type: 'day-saving', date: day.date, fill: fillResult, verify: verifyResult });

        await page.waitForTimeout(120);
        const savedAs = await commitForecastDaySave(page);

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
        for (let offset = 1; offset <= daysBack; offset += 1) {
            const iso = addDaysToIso(today, -offset);
            const [y, m, d] = iso.split('-').map(Number);
            await scraper.setScheduledOrdersToYmd(page, y, m, d);
            const data = await scraper.openDayViewAndReadSales(page, false);
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
