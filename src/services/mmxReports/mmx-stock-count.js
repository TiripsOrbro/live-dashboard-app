const fs = require('fs');
const path = require('path');
const log = require('./util-logging');
const { GOTO_OPTS } = require('./mmx-browser');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'mmx-stock-count.json');
const EXAMPLE_PATH = path.join(PROJECT_ROOT, 'config', 'mmx-stock-count.json.example');

/** Macromatix Key Item Count location tabs (left to right on the count screen). */
const MMX_COUNT_TABS = [
    'FREEZER',
    'CARRY OVER',
    'FRIDGE',
    'ON FLOOR - IN USE - THAW',
    'DRY',
    'SOFT DRINKS',
    'COUNT AS 0',
];

const DEFAULT_CONFIG = {
    url: 'https://tacobellau.macromatix.net/MMS_Stores_StockCount.aspx?MenuCustomItemID=156',
    countTypeValue: '0',
    countTypeText: 'Key Item Count',
    /** Dashboard storage location → MMX tab label. */
    locationTabMap: {
        Freezer: 'FREEZER',
        Carryover: 'CARRY OVER',
        'Carry Over': 'CARRY OVER',
        Fridge: 'FRIDGE',
        'In Use': 'ON FLOOR - IN USE - THAW',
        Dry: 'DRY',
        'Soft Drinks': 'SOFT DRINKS',
        'Count As 0': 'COUNT AS 0',
    },
    createCountButtonId: 'ctl00_ph_ButtonOK_input',
    countTypeSelectId: 'ctl00_ph_DropDownListCount',
    inProgressCountSelectId: 'ctl00_ph_DropDownListCounts',
    batchNumberInputId: 'ctl00_ph_TextBoxCountNo',
    statusInputId: 'ctl00_ph_TextBoxStatus',
    saveButtonIds: ['ctl00_ph_ButtonUpdate2_input', 'ctl00_ph_ButtonUpdate_input'],
    continueButtonIds: ['ctl00_ph_ButtonContinue_input', 'ctl00_ph_ButtonContinue2_input'],
    applyButtonId: 'ctl00_ph_ButtonApply',
};

function loadMmxStockCountConfig() {
    const file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_PATH;
    if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function mmxTabForLocation(cfg, locationName) {
    const map = cfg.locationTabMap || {};
    return map[locationName] || String(locationName || '').toUpperCase();
}

function normalizeItemCode(code) {
    return String(code || '')
        .trim()
        .toUpperCase()
        .replace(/^0+/, '');
}

async function clickRadTab(page, tabLabel) {
    const want = String(tabLabel || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    const clicked = await page.evaluate((label) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const candidates = [];
        for (const el of document.querySelectorAll('.rtsLink, .rtsTxt, a.rtsLink, li.rtsLI, .rtsUL li')) {
            const t = norm(el.textContent);
            if (!t) continue;
            candidates.push({ el, t });
        }
        const clickEl = (entry) => {
            (entry.el.querySelector('.rtsLink, a, span') || entry.el).click();
            return entry.t;
        };
        for (const entry of candidates) {
            if (entry.t === label) return clickEl(entry);
        }
        for (const entry of candidates) {
            if (entry.t.startsWith(label) || label.startsWith(entry.t)) return clickEl(entry);
        }
        return null;
    }, want);
    if (!clicked) throw new Error(`MMX tab not found: ${tabLabel}`);
    log.info(`Opened MMX tab: ${clicked}`);
    await page.waitForTimeout(1500);
    return clicked;
}

async function clickMainTab(page, tabLabel) {
    const want = String(tabLabel || '').trim().toLowerCase();
    const clicked = await page.evaluate((label) => {
        for (const el of document.querySelectorAll('a, span, li')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t === label) {
                el.click();
                return t;
            }
        }
        return null;
    }, want);
    if (!clicked) throw new Error(`Main tab not found: ${tabLabel}`);
    await page.waitForTimeout(1500);
    return clicked;
}

async function selectCountType(page, cfg) {
    const selId = cfg.countTypeSelectId;
    await page.evaluate(
        ({ id, value, text }) => {
            const sel = document.getElementById(id);
            if (!sel) throw new Error(`Count type select missing: ${id}`);
            let idx = -1;
            for (let i = 0; i < sel.options.length; i++) {
                const o = sel.options[i];
                if (String(o.value) === String(value) || (o.textContent || '').trim() === text) {
                    idx = i;
                    break;
                }
            }
            if (idx < 0) throw new Error(`Count type option not found: ${text}`);
            sel.selectedIndex = idx;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
        },
        { id: selId, value: cfg.countTypeValue, text: cfg.countTypeText }
    );
    await page.waitForTimeout(800);
}

async function clickButtonById(page, id) {
    const selector = `#${String(id).replace(/:/g, '\\:')}`;
    const handle = await page.$(selector);
    if (!handle) throw new Error(`Button not found: #${id}`);
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
        handle.click(),
    ]);
    await page.waitForTimeout(2000);
}

async function clickEnabledSave(page, cfg) {
    const ids = cfg.saveButtonIds || ['ctl00_ph_ButtonUpdate_input'];
    for (const id of ids) {
        const enabled = await page.evaluate((btnId) => {
            const el = document.getElementById(btnId);
            return el && !el.disabled && el.offsetParent !== null;
        }, id);
        if (!enabled) continue;
        log.info(`Saving stock count tab via #${id}`);
        await clickButtonById(page, id);
        return id;
    }
    throw new Error('No enabled Save button on stock count tab');
}

async function readCountStatus(page, cfg = {}) {
    const statusId = cfg.statusInputId || DEFAULT_CONFIG.statusInputId;
    return page.evaluate((id) => {
        const status = document.getElementById(id);
        return (status?.value || status?.textContent || '').replace(/\s+/g, ' ').trim();
    }, statusId);
}

async function readBatchNumber(page, cfg = {}) {
    const batchId = cfg.batchNumberInputId || DEFAULT_CONFIG.batchNumberInputId;
    return page.evaluate((id) => {
        const batch = document.getElementById(id);
        return (batch?.value || batch?.textContent || '').replace(/\s+/g, ' ').trim();
    }, batchId);
}

async function readSelectedCountTitle(page, cfg = {}) {
    const selId = cfg.inProgressCountSelectId || DEFAULT_CONFIG.inProgressCountSelectId;
    return page.evaluate((id) => {
        const sel = document.getElementById(id);
        return (sel?.options?.[sel.selectedIndex]?.textContent || '').replace(/\s+/g, ' ').trim();
    }, selId);
}

async function listInProgressCountOptions(page, cfg = {}) {
    const selId = cfg.inProgressCountSelectId || DEFAULT_CONFIG.inProgressCountSelectId;
    return page.evaluate((id) => {
        const sel = document.getElementById(id);
        if (!sel) return [];
        return [...sel.options].map((o) => ({
            value: o.value,
            text: (o.textContent || '').replace(/\s+/g, ' ').trim(),
        }));
    }, selId);
}

async function selectInProgressCountOption(page, cfg, optionValue) {
    const selId = cfg.inProgressCountSelectId || DEFAULT_CONFIG.inProgressCountSelectId;
    const alreadySelected = await page.evaluate(
        ({ id, value }) => document.getElementById(id)?.value === String(value),
        { id: selId, value: optionValue }
    );
    if (alreadySelected) return;

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
        page.evaluate(
            ({ id, value }) => {
                const sel = document.getElementById(id);
                if (!sel) throw new Error(`In-progress count select missing: ${id}`);
                sel.value = String(value);
                sel.dispatchEvent(new Event('change', { bubbles: true }));
            },
            { id: selId, value: optionValue }
        ),
    ]);
    await page.waitForTimeout(2000);
}

function isKeyItemCountOption(cfg, optionText) {
    const want = String(cfg.countTypeText || DEFAULT_CONFIG.countTypeText).trim().toLowerCase();
    return String(optionText || '')
        .trim()
        .toLowerCase()
        .includes(want);
}

async function findOpenKeyItemCount(page, cfg) {
    const options = await listInProgressCountOptions(page, cfg);
    if (!options.length) return null;

    const keyItemOptions = options.filter((opt) => isKeyItemCountOption(cfg, opt.text));
    if (!keyItemOptions.length) return null;

    for (const opt of keyItemOptions) {
        await selectInProgressCountOption(page, cfg, opt.value);
        const status = await readCountStatus(page, cfg);
        if (!/^open$/i.test(status)) continue;

        return {
            batch: await readBatchNumber(page, cfg),
            status,
            countTitle: opt.text,
        };
    }

    return null;
}

async function ensureKeyItemCountEditable(page, cfg) {
    await clickMainTab(page, 'count in progress');

    const openCount = await findOpenKeyItemCount(page, cfg);
    if (openCount) {
        log.info(
            `Using in-progress Key Item Count batch ${openCount.batch} (status: ${openCount.status}) — ${openCount.countTitle}`
        );
        return { mode: 'in-progress', ...openCount };
    }

    log.info('No open Key Item Count found — starting new count');
    await clickMainTab(page, 'new count');
    await selectCountType(page, cfg);
    await clickButtonById(page, cfg.createCountButtonId);

    const created = {
        mode: 'created',
        batch: await readBatchNumber(page, cfg),
        status: await readCountStatus(page, cfg),
        countTitle: await readSelectedCountTitle(page, cfg),
    };
    log.info(
        `Created Key Item Count batch ${created.batch || '(pending)'} (status: ${created.status || 'open'})`
    );
    return created;
}

async function scrapeCountGrid(page) {
    return page.evaluate(() => {
        const normCode = (s) =>
            String(s || '')
                .trim()
                .toUpperCase()
                .replace(/^0+(?=\d)/, '');

        const extractCodesFromContext = (ctx) => {
            const codes = new Set();
            const text = String(ctx || '').replace(/\s+/g, ' ').trim();
            if (!text) return [];

            const numMatch = text.match(/\b(\d{3,6}[A-Z]?)\b/i);
            if (numMatch) codes.add(normCode(numMatch[1]));

            const leadMatch = text.match(/^([A-Z0-9]{2,12})\b/i);
            if (leadMatch) codes.add(normCode(leadMatch[1]));

            return [...codes];
        };

        const byRow = new Map();

        for (const inp of document.querySelectorAll('input[id*="tbOH"]')) {
            const slotMatch = inp.id.match(/tbOH([123])$/i);
            if (!slotMatch) continue;
            const tr = inp.closest('tr');
            const ctx = (tr?.innerText || '').replace(/\s+/g, ' ').trim();
            const rowKey = tr?.rowIndex ?? inp.id;
            if (!byRow.has(rowKey)) {
                const codes = extractCodesFromContext(ctx);
                byRow.set(rowKey, {
                    itemCode: codes[0] || '',
                    codes,
                    ctx: ctx.slice(0, 120),
                    slots: {},
                });
            }
            const row = byRow.get(rowKey);
            row.slots[Number(slotMatch[1])] = inp.id;
            if (!row.codes.length) {
                row.codes = extractCodesFromContext(ctx);
                row.itemCode = row.codes[0] || '';
            }
        }

        return [...byRow.values()].filter((r) => r.codes.length && Object.keys(r.slots).length);
    });
}

function buildGridLookup(grid) {
    const byCode = new Map();
    for (const row of grid) {
        for (const code of row.codes || []) {
            const key = normalizeItemCode(code);
            if (key && !byCode.has(key)) byCode.set(key, row);
        }
        if (row.itemCode) {
            const key = normalizeItemCode(row.itemCode);
            if (key && !byCode.has(key)) byCode.set(key, row);
        }
    }
    return byCode;
}

function findGridRow(byCode, grid, item) {
    const candidates = [
        normalizeItemCode(item.itemCode),
        normalizeItemCode(item.key),
    ].filter(Boolean);

    for (const code of candidates) {
        const row = byCode.get(code);
        if (row) return row;
    }

    const nameNeedle = String(item.name || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    if (!nameNeedle) return null;

    return (
        grid.find((row) => {
            const ctx = String(row.ctx || '').toLowerCase();
            return ctx.includes(nameNeedle);
        }) || null
    );
}

function countsToSlotValues(catalogItem, counts) {
    // MMX columns: slot 1 = Closing Box (tbOH1), 2 = Closing Inner (tbOH2), 3 = Closing Unit (tbOH3).
    const slots = catalogItem.unitSlots || [];
    const values = {};
    let slotIndex = 1;
    for (const slot of slots.slice(0, 3)) {
        if (slot.na) {
            slotIndex++;
            continue;
        }
        const val = counts?.[slot.key];
        if (val != null && Number(val) >= 0) {
            values[slotIndex] = String(val);
        }
        slotIndex++;
    }
    return values;
}

function parseClosingNum(raw) {
    if (raw == null || raw === '' || raw === '—' || raw === '-') return null;
    const n = Number(String(raw).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : null;
}

function filledItemKey(item) {
    return `${item.vendorSlug || ''}:${item.key || ''}:${item.locationName || ''}`;
}

function scoreVarianceToFilledItem(variance, filled) {
    const slotValues = countsToSlotValues(filled, filled.counts || {});
    const vSlots = [
        parseClosingNum(variance.closingBox),
        parseClosingNum(variance.closingInner),
        parseClosingNum(variance.closingUnit),
    ];
    let score = 0;
    let comparisons = 0;
    for (let i = 0; i < 3; i++) {
        const vVal = vSlots[i];
        const fVal = slotValues[i + 1] != null ? Number(slotValues[i + 1]) : null;
        if (vVal == null && fVal == null) continue;
        if (vVal != null && fVal != null) {
            comparisons++;
            if (Math.abs(vVal - fVal) < 0.015) score += 50;
            else score -= 20;
        }
    }
    if (!comparisons) return 0;

    const code = normalizeItemCode(variance.itemCode);
    if (code && normalizeItemCode(filled.itemCode) === code) score += 30;

    return score;
}

function findFilledItemForVariance(variance, filledItems, usedKeys) {
    const code = normalizeItemCode(variance.itemCode);
    let candidates = filledItems.filter((item) => !usedKeys.has(filledItemKey(item)));

    if (code) {
        const byCode = candidates.filter((item) => normalizeItemCode(item.itemCode) === code);
        if (byCode.length === 1) return byCode[0];
        if (byCode.length > 1) candidates = byCode;
    }

    let best = null;
    let bestScore = 0;
    for (const item of candidates) {
        const score = scoreVarianceToFilledItem(variance, item);
        if (score > bestScore) {
            bestScore = score;
            best = item;
        }
    }
    return bestScore >= 45 ? best : null;
}

function enrichVariancesWithFilledItems(variances, filledItems) {
    if (!filledItems.length) return variances;
    const usedKeys = new Set();
    return variances.map((variance) => {
        const match = findFilledItemForVariance(variance, filledItems, usedKeys);
        if (!match) return variance;
        usedKeys.add(filledItemKey(match));
        return {
            ...variance,
            vendorSlug: match.vendorSlug,
            catalogKey: match.key,
            catalogName: match.name,
            matchedItemCode: match.itemCode || '',
        };
    });
}

async function typeIntoInput(page, inputId, value) {
    const selector = `#${inputId.replace(/:/g, '\\:')}`;
    const handle = await page.$(selector);
    if (!handle) return false;
    await handle.click({ clickCount: 3 });
    await handle.focus();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(String(value), { delay: 15 });
    await page.keyboard.press('Tab');
    await handle.dispose();
    await page.waitForTimeout(60);
    return true;
}

async function fillLocationTab(page, cfg, catalog, locationName, itemsAtLocation) {
    const mmxTab = mmxTabForLocation(cfg, locationName);
    await clickRadTab(page, mmxTab.toLowerCase());

    const grid = await scrapeCountGrid(page);
    const byCode = buildGridLookup(grid);
    let filled = 0;
    const missed = [];

    for (const item of itemsAtLocation) {
        const counts = item.counts || {};
        const hasAny = Object.values(counts).some((v) => Number(v) > 0);
        if (!hasAny) continue;

        const row = findGridRow(byCode, grid, item);
        if (!row) {
            missed.push(item.itemCode || item.key || item.name);
            continue;
        }

        const slotValues = countsToSlotValues(item, counts);
        for (const [slot, val] of Object.entries(slotValues)) {
            const inputId = row.slots[Number(slot)];
            if (!inputId || val === '') continue;
            await typeIntoInput(page, inputId, val);
        }
        filled++;
    }

    if (missed.length) {
        log.info(`MMX ${mmxTab}: could not match ${missed.length} item(s): ${missed.join(', ')}`);
    }

    await clickEnabledSave(page, cfg);
    return { locationName, mmxTab, filled, missed };
}

function dashboardLocationOrder(cfg) {
    const map = cfg.locationTabMap || DEFAULT_CONFIG.locationTabMap;
    const tabToLocation = new Map();
    for (const [location, tab] of Object.entries(map)) {
        const key = String(tab || '').trim().toUpperCase();
        if (!tabToLocation.has(key)) tabToLocation.set(key, location);
    }
    const ordered = [];
    for (const tab of MMX_COUNT_TABS) {
        const loc = tabToLocation.get(tab);
        if (loc && !ordered.includes(loc)) ordered.push(loc);
    }
    return ordered;
}

function mergeVendorEntriesByLocation(vendorEntries) {
    const byLocation = new Map();

    for (const entry of vendorEntries) {
        const { catalog, draftLocations } = entry;
        if (!catalog || !draftLocations) continue;

        for (const locationName of catalog.locations) {
            const locData = draftLocations[locationName];
            if (!locData || typeof locData !== 'object') continue;

            const itemsAtLocation = catalog.items
                .filter((item) => item.locations.includes(locationName))
                .map((item) => ({
                    key: item.key,
                    itemCode: item.itemCode,
                    name: item.name,
                    unitSlots: item.unitSlots,
                    counts: locData[item.key] || {},
                    vendorLabel: catalog.label,
                    vendorSlug: entry.slug,
                }))
                .filter((item) => Object.values(item.counts).some((v) => Number(v) > 0));

            if (!itemsAtLocation.length) continue;

            if (!byLocation.has(locationName)) byLocation.set(locationName, []);
            byLocation.get(locationName).push(...itemsAtLocation);
        }
    }

    return byLocation;
}

async function clickButtonByValue(page, label) {
    const want = String(label || '').trim().toLowerCase();
    const clicked = await page.evaluate((text) => {
        for (const el of document.querySelectorAll('input[type="button"], input[type="submit"], button, a')) {
            const t = (el.value || el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t !== text || el.disabled || el.offsetParent === null) continue;
            el.click();
            return t;
        }
        return null;
    }, want);
    if (!clicked) return false;
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
        page.waitForTimeout(500),
    ]);
    await page.waitForTimeout(2000);
    return true;
}

async function clickContinueToConfirm(page, cfg) {
    const ids = cfg.continueButtonIds || ['ctl00_ph_ButtonContinue_input'];
    for (const id of ids) {
        const enabled = await page.evaluate((btnId) => {
            const el = document.getElementById(btnId);
            return el && !el.disabled && el.offsetParent !== null;
        }, id);
        if (!enabled) continue;
        log.info(`Continuing to confirm count via #${id}`);
        await clickButtonById(page, id);
        return id;
    }
    if (await clickButtonByValue(page, 'Continue')) {
        log.info('Continuing to confirm count via Continue button');
        return 'Continue';
    }
    throw new Error('Continue button not found on stock count page.');
}

async function waitForContinueEnabled(page, cfg, timeoutMs = 20000) {
    const ids = cfg.continueButtonIds || DEFAULT_CONFIG.continueButtonIds;
    await page
        .waitForFunction(
            (btnIds) =>
                btnIds.some((btnId) => {
                    const el = document.getElementById(btnId);
                    return el && !el.disabled && el.offsetParent !== null;
                }),
            { timeout: timeoutMs },
            ids
        )
        .catch(() => {});
}

/**
 * MMX only enables Continue while viewing a location tab that has saved counts.
 */
async function clickContinueFromFilledTab(page, cfg, filledTabs) {
    const tabsWithCounts = (filledTabs || []).filter((tab) => tab.filled > 0);
    if (!tabsWithCounts.length) {
        throw new Error(
            'No Macromatix location tabs received counts — nothing to continue to confirm count.'
        );
    }

    const target = tabsWithCounts[tabsWithCounts.length - 1];
    log.info(`Opening ${target.mmxTab} tab before Continue (${target.filled} item(s) saved)`);
    await clickRadTab(page, target.mmxTab.toLowerCase());
    await waitForContinueEnabled(page, cfg);

    const enabled = await page.evaluate((btnIds) => {
        return btnIds.some((btnId) => {
            const el = document.getElementById(btnId);
            return el && !el.disabled && el.offsetParent !== null;
        });
    }, cfg.continueButtonIds || DEFAULT_CONFIG.continueButtonIds);

    if (!enabled) {
        throw new Error(
            `Continue is still disabled on ${target.mmxTab} — save counts on a location tab first.`
        );
    }

    return clickContinueToConfirm(page, cfg);
}

async function scrapeConfirmCountVariances(page) {
    await page
        .waitForFunction(
            () =>
                /review your inventory variances|expected variance/i.test(document.body?.innerText || ''),
            { timeout: 45000 }
        )
        .catch(() => {});

    return page.evaluate(() => {
        const parseNum = (raw) => {
            const s = String(raw ?? '')
                .replace(/[$,]/g, '')
                .trim();
            if (!s || s === '—' || s === '-') return null;
            const n = Number(s);
            return Number.isFinite(n) ? n : null;
        };

        const parseRgb = (bg) => {
            const m = String(bg || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
            if (!m) return null;
            return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
        };

        const highlightFromElement = (el) => {
            if (!el) return 'none';
            const nodes = [el, el.querySelector('input'), el.querySelector('span')].filter(Boolean);
            for (const node of nodes) {
                const inline = (node.getAttribute('style') || '').toLowerCase();
                if (/background[^;]*(red|#f00|#ff0000|pink|#ffc)/i.test(inline)) return 'red';
                const rgb = parseRgb(window.getComputedStyle(node).backgroundColor);
                if (!rgb) continue;
                const { r, g, b } = rgb;
                if (r > 240 && g > 240 && b > 240) continue;
                if (g > r + 25 && g > b + 25) return 'green';
                if (r > g + 15 && r > b + 15 && r > 160) return 'red';
            }
            return 'none';
        };

        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

        const isVarianceHeaderRow = (cells) => {
            if (cells.length < 5 || cells.length > 16) return false;
            const mashed = cells.some(
                (c) => c.includes('expected variance') && c.includes('stock on hand') && c.length > 40
            );
            if (mashed) return false;
            return (
                cells.some((c) => c === 'item') &&
                cells.some((c) => c.includes('expected variance')) &&
                cells.some((c) => c.includes('variance value')) &&
                cells.some((c) => c.includes('stock on hand'))
            );
        };

        let headerRow = null;
        let headerCells = null;
        let table = null;
        for (const tbl of document.querySelectorAll('table')) {
            for (const tr of tbl.querySelectorAll('tr')) {
                const cells = [...tr.querySelectorAll('th, td')];
                const texts = cells.map((c) => norm(c.textContent));
                if (!isVarianceHeaderRow(texts)) continue;
                headerRow = texts;
                headerCells = cells;
                table = tbl;
                break;
            }
            if (table) break;
        }

        if (!table || !headerRow) return [];

        const col = (label) => headerRow.findIndex((c) => c.includes(label));
        const itemIdx = headerRow.findIndex((c) => c === 'item');
        const nameIdx = itemIdx >= 0 ? itemIdx + 1 : -1;
        const unitColIdx = headerRow.findIndex((c) => c === 'unit');
        const boxIdx = headerRow.findIndex((c) => c.startsWith('closing box'));
        const innerIdx = headerRow.findIndex((c) => c.startsWith('closing inner'));
        const unitIdx = headerRow.findIndex((c) => c.startsWith('closing unit'));
        const stockIdx = headerRow.findIndex((c) => c.includes('stock on hand'));
        const varianceQtyIdx = col('expected variance');
        const varianceValueIdx = col('variance value');

        const rows = [];
        for (const tr of table.querySelectorAll('tr')) {
            const cells = [...tr.querySelectorAll('td')];
            if (!cells.length || cells.length < 4) continue;

            const getText = (idx) => {
                if (idx < 0 || !cells[idx]) return '';
                const cell = cells[idx];
                const input = cell.querySelector('input, textarea');
                const raw =
                    input && String(input.value || '').trim()
                        ? input.value
                        : cell.textContent;
                return String(raw).replace(/\s+/g, ' ').trim();
            };
            const getCell = (idx) => (idx >= 0 ? cells[idx] : null);

            const itemCodeText = getText(itemIdx);
            if (!/^\d{3,6}[A-Z]?$/i.test(itemCodeText)) continue;

            const itemName = getText(nameIdx) || itemCodeText;
            const varianceQtyCell = getCell(varianceQtyIdx);
            const varianceValueCell = getCell(varianceValueIdx);
            const qtyHighlight = highlightFromElement(varianceQtyCell);
            const valueHighlight = highlightFromElement(varianceValueCell);
            const isRed = qtyHighlight === 'red' || valueHighlight === 'red';
            if (!isRed) continue;

            const stockCounted = parseNum(getText(stockIdx));
            const varianceQty = parseNum(getText(varianceQtyIdx));
            const varianceValue = parseNum(getText(varianceValueIdx));
            let stockExpected = null;
            if (stockCounted != null && varianceQty != null) {
                stockExpected = stockCounted - varianceQty;
            }

            rows.push({
                itemCode: itemCodeText,
                itemName,
                unit: getText(unitColIdx) || getText(unitIdx) || '',
                closingBox: getText(boxIdx) || '—',
                closingInner: getText(innerIdx) || '—',
                closingUnit: getText(unitIdx) || '—',
                stockCounted,
                stockExpected,
                varianceQty,
                varianceValue,
                isRed: true,
            });
        }

        return rows;
    });
}

async function applyKeyItemCount(page, cfg) {
    const applyId = cfg.applyButtonId;
    if (!applyId) throw new Error('Apply button id not configured.');
    const enabled = await page.evaluate((btnId) => {
        const el = document.getElementById(btnId);
        return el && !el.disabled && el.offsetParent !== null;
    }, applyId);
    if (enabled) {
        log.info(`Applying Key Item Count via #${applyId}`);
        await clickButtonById(page, applyId);
        return true;
    }
    if (await clickButtonByValue(page, 'Apply')) {
        log.info('Applying Key Item Count via Apply button');
        return true;
    }
    throw new Error('Apply button not enabled on confirm count screen.');
}

async function applyKeyItemCountIfReady(page, cfg) {
    const applyId = cfg.applyButtonId;
    if (!applyId) return false;

    const enabled = await page.evaluate((btnId) => {
        const el = document.getElementById(btnId);
        return el && !el.disabled && el.offsetParent !== null;
    }, applyId);

    if (!enabled) {
        log.info('Key Item Count apply button not enabled — count saved tab-by-tab only');
        return false;
    }

    log.info(`Applying Key Item Count via #${applyId}`);
    await clickButtonById(page, applyId);
    return true;
}

/**
 * Enter all submitted vendor counts into one Macromatix Key Item Count (tab by tab).
 * @param {object} opts - { page, storeNumber, vendorEntries, navTimeoutMs, selectStore }
 *   vendorEntries: [{ slug, catalog, draftLocations }]
 */
async function enterCombinedStockCount(page, opts) {
    const cfg = loadMmxStockCountConfig();
    const vendorEntries = opts.vendorEntries || [];
    const navTimeoutMs = opts.navTimeoutMs || 45000;

    if (!vendorEntries.length) {
        throw new Error('No vendor counts to send to Macromatix.');
    }

    const byLocation = mergeVendorEntriesByLocation(vendorEntries);
    if (!byLocation.size) {
        throw new Error('No location counts to send to Macromatix.');
    }

    const locationOrder = dashboardLocationOrder(cfg);
    const extraLocations = [...byLocation.keys()].filter((loc) => !locationOrder.includes(loc)).sort();
    const locationsToFill = [...locationOrder.filter((loc) => byLocation.has(loc)), ...extraLocations];

    log.info(
        `Opening stock count page for store ${opts.storeNumber} — ${vendorEntries.length} vendor(s), ${locationsToFill.length} location tab(s)`
    );
    await page.goto(cfg.url, { ...GOTO_OPTS, timeout: navTimeoutMs });
    await page.waitForTimeout(2000);

    if (opts.selectStore) {
        await opts.selectStore(page, opts.storeNumber);
        await page.waitForTimeout(2500);
    }

    const countMode = await ensureKeyItemCountEditable(page, cfg);

    const filledItems = [];
    const results = [];
    for (const locationName of locationsToFill) {
        const itemsAtLocation = byLocation.get(locationName) || [];
        if (!itemsAtLocation.length) continue;

        for (const item of itemsAtLocation) {
            filledItems.push({ ...item, locationName });
        }

        log.info(`Filling ${locationName} (${itemsAtLocation.length} item(s))`);
        const result = await fillLocationTab(page, cfg, null, locationName, itemsAtLocation);
        results.push(result);
    }

    if (!results.length) {
        throw new Error('No location counts to send to Macromatix.');
    }

    if (opts.stopAtConfirm) {
        await clickContinueFromFilledTab(page, cfg, results);
        const rawVariances = await scrapeConfirmCountVariances(page);
        const variances = enrichVariancesWithFilledItems(rawVariances, filledItems);
        log.info(`Confirm count loaded — ${variances.length} red variance row(s)`);
        return {
            mode: 'key-item-count-combined',
            countMode,
            vendorSlugs: vendorEntries.map((e) => e.slug),
            tabs: results,
            variances,
        };
    }

    const applied = await applyKeyItemCountIfReady(page, cfg);

    return {
        mode: 'key-item-count-combined',
        countMode,
        applied,
        vendorSlugs: vendorEntries.map((e) => e.slug),
        tabs: results,
    };
}

/**
 * Enter dashboard stock counts for one vendor into Macromatix Key Item Count.
 * @param {object} opts - { page, storeNumber, catalog, draftLocations, navTimeoutMs }
 */
async function enterVendorStockCount(page, opts) {
    return enterCombinedStockCount(page, {
        storeNumber: opts.storeNumber,
        navTimeoutMs: opts.navTimeoutMs,
        selectStore: opts.selectStore,
        vendorEntries: [
            {
                slug: opts.catalog?.slug,
                catalog: opts.catalog,
                draftLocations: opts.draftLocations,
            },
        ],
    });
}

module.exports = {
    MMX_COUNT_TABS,
    loadMmxStockCountConfig,
    enterCombinedStockCount,
    enterVendorStockCount,
    ensureKeyItemCountEditable,
    scrapeCountGrid,
    buildGridLookup,
    findGridRow,
    scrapeConfirmCountVariances,
    clickContinueFromFilledTab,
    applyKeyItemCount,
    normalizeItemCode,
    mergeVendorEntriesByLocation,
};
