const fs = require('fs');
const path = require('path');
const log = require('./util-logging');
const { GOTO_OPTS } = require('./mmx-browser');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'mmx-stock-count.json');
const EXAMPLE_PATH = path.join(PROJECT_ROOT, 'config', 'mmx-stock-count.json.example');

const DEFAULT_CONFIG = {
    url: 'https://tacobellau.macromatix.net/MMS_Stores_StockCount.aspx?MenuCustomItemID=156',
    countTypeValue: '0',
    countTypeText: 'Key Item Count',
    locationTabMap: {
        Freezer: 'FREEZER',
        Fridge: 'FRIDGE (+ CARRYOVER)',
        Carryover: 'FRIDGE (+ CARRYOVER)',
        'In Use': 'ON FLOOR - IN USE - THAW',
    },
    createCountButtonId: 'ctl00_ph_ButtonOK_input',
    countTypeSelectId: 'ctl00_ph_DropDownListCount',
    saveButtonIds: ['ctl00_ph_ButtonUpdate2_input', 'ctl00_ph_ButtonUpdate_input'],
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
    const want = String(tabLabel || '').trim().toLowerCase();
    const clicked = await page.evaluate((label) => {
        for (const el of document.querySelectorAll('.rtsLink, .rtsTxt, a.rtsLink, li.rtsLI')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t === label || t.includes(label)) {
                (el.querySelector('.rtsLink, a, span') || el).click();
                return t;
            }
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

async function readCountStatus(page) {
    return page.evaluate(() => {
        const status = document.getElementById('ctl00_ph_TextBoxStatus');
        return (status?.value || status?.textContent || '').replace(/\s+/g, ' ').trim();
    });
}

async function ensureKeyItemCountEditable(page, cfg) {
    await clickMainTab(page, 'count in progress');
    const status = await readCountStatus(page).catch(() => '');
    if (status && !/^applied$/i.test(status)) {
        log.info(`Using in-progress Key Item Count (status: ${status || 'open'})`);
        return 'in-progress';
    }

    log.info('Starting new Key Item Count');
    await clickMainTab(page, 'new count');
    await selectCountType(page, cfg);
    await clickButtonById(page, cfg.createCountButtonId);
    return 'created';
}

async function scrapeCountGrid(page) {
    return page.evaluate(() => {
        const normCode = (s) =>
            String(s || '')
                .trim()
                .toUpperCase()
                .replace(/^0+/, '');
        const byRow = new Map();

        for (const inp of document.querySelectorAll('input[id*="tbOH"]')) {
            const slotMatch = inp.id.match(/tbOH([123])$/i);
            if (!slotMatch) continue;
            const tr = inp.closest('tr');
            const ctx = (tr?.innerText || '').replace(/\s+/g, ' ').trim();
            const codeMatch = ctx.match(/\b(\d{3,6}[A-Z]?)\b/i);
            const itemCode = codeMatch ? normCode(codeMatch[1]) : '';
            const rowKey = tr?.rowIndex ?? inp.id;
            if (!byRow.has(rowKey)) {
                byRow.set(rowKey, { itemCode, ctx: ctx.slice(0, 100), slots: {} });
            }
            const row = byRow.get(rowKey);
            if (itemCode && !row.itemCode) row.itemCode = itemCode;
            row.slots[Number(slotMatch[1])] = inp.id;
        }

        return [...byRow.values()].filter((r) => r.itemCode);
    });
}

function countsToSlotValues(catalogItem, counts) {
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
    const byCode = new Map(grid.map((r) => [normalizeItemCode(r.itemCode), r]));
    let filled = 0;
    const missed = [];

    for (const item of itemsAtLocation) {
        const counts = item.counts || {};
        const hasAny = Object.values(counts).some((v) => Number(v) > 0);
        if (!hasAny) continue;

        const code = normalizeItemCode(item.itemCode);
        const row = byCode.get(code);
        if (!row) {
            missed.push(code || item.name);
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

    await clickEnabledSave(page, cfg);
    return { locationName, mmxTab, filled, missed };
}

/**
 * Enter dashboard stock counts for one vendor into Macromatix Key Item Count.
 * @param {object} opts - { page, storeNumber, catalog, draftLocations, navTimeoutMs }
 */
async function enterVendorStockCount(page, opts) {
    const cfg = loadMmxStockCountConfig();
    const catalog = opts.catalog;
    const locations = opts.draftLocations || {};
    const navTimeoutMs = opts.navTimeoutMs || 45000;

    log.info(`Opening stock count page for store ${opts.storeNumber}`);
    await page.goto(cfg.url, { ...GOTO_OPTS, timeout: navTimeoutMs });
    await page.waitForTimeout(2000);

    if (opts.selectStore) {
        await opts.selectStore(page, opts.storeNumber);
        await page.waitForTimeout(2500);
    }

    await ensureKeyItemCountEditable(page, cfg);

    const results = [];
    for (const locationName of catalog.locations) {
        const locData = locations[locationName];
        if (!locData || typeof locData !== 'object') continue;

        const itemsAtLocation = catalog.items
            .filter((item) => item.locations.includes(locationName))
            .map((item) => ({
                itemCode: item.itemCode,
                name: item.name,
                unitSlots: item.unitSlots,
                counts: locData[item.key] || {},
            }))
            .filter((item) => Object.values(item.counts).some((v) => Number(v) > 0));

        if (!itemsAtLocation.length) continue;

        log.info(`Filling ${locationName} (${itemsAtLocation.length} item(s))`);
        const result = await fillLocationTab(page, cfg, catalog, locationName, itemsAtLocation);
        results.push(result);
    }

    if (!results.length) {
        throw new Error('No location counts to send to Macromatix.');
    }

    return { mode: 'key-item-count', tabs: results };
}

module.exports = {
    loadMmxStockCountConfig,
    enterVendorStockCount,
    ensureKeyItemCountEditable,
    scrapeCountGrid,
    normalizeItemCode,
};
