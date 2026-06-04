const { GOTO_OPTS } = require('./mmx-browser');
const { withPageContextRetry } = require('./mmx-context-retry');
const { setReportStartDate, setReportEndDate } = require('./mmx-rad-date-picker');
const { resolveReportDate } = require('./util-dates');
const { getStoreConfig } = require('../storeList');
const { selectStoreOnPage } = require('../macromatixScraper');
const log = require('./util-logging');

async function openReportSelectionPage(page, reportNav, navTimeoutMs) {
    log.info(`Opening Report Selection: ${reportNav.url}`);
    await page.goto(reportNav.url, { ...GOTO_OPTS, timeout: navTimeoutMs });
    await page.waitForTimeout(reportNav.waitAfterNavigateMs || 2000);
}

async function setGroupDropdown(page, groupName) {
    const set = await page.evaluate((group) => {
        const want = group.toLowerCase();
        for (const sel of document.querySelectorAll('select')) {
            const ctx = ((sel.closest('tr, td, div') || sel).innerText || '').toLowerCase();
            if (!ctx.includes('group') && !Array.from(sel.options).some((o) => o.text.toLowerCase().includes('supply'))) {
                continue;
            }
            for (const opt of sel.options) {
                if ((opt.textContent || '').trim().toLowerCase().includes(want)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return opt.textContent.trim();
                }
            }
        }
        for (const sel of document.querySelectorAll('select')) {
            for (const opt of sel.options) {
                if ((opt.textContent || '').trim().toLowerCase().includes(want)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return opt.textContent.trim();
                }
            }
        }
        return null;
    }, groupName);

    if (!set) throw new Error(`Group dropdown: could not select "${groupName}"`);
    log.info(`Group set to: ${set}`);
    const settleMs = Number(process.env.MMX_REPORT_GROUP_SETTLE_MS || 3000);
    await page.waitForTimeout(settleMs);
}

async function listReportOptions(page, opts = {}) {
    const loose = Boolean(opts.loose);
    return page.evaluate((looseMode) => {
        const out = [];
        for (const sel of document.querySelectorAll('select')) {
            const label = ((sel.closest('tr, td') || sel).innerText || '').slice(0, 120);
            const hasInventory = Array.from(sel.options).some((o) => /inventory|special event/i.test(o.text));
            const hasScm = Array.from(sel.options).some((o) => /scm|items on/i.test(o.text));
            if (!looseMode && !label.toLowerCase().includes('report') && !hasScm) continue;
            if (looseMode && !label.toLowerCase().includes('report') && !hasInventory && !hasScm) continue;
            const options = Array.from(sel.options)
                .map((o) => (o.textContent || '').trim())
                .filter(Boolean);
            if (options.length) out.push({ label, options: options.slice(0, 12) });
        }
        return out;
    }, loose);
}

async function waitForReportInList(page, reportName, opts = {}) {
    const loose = Boolean(opts.loose);
    const timeoutMs = Number(process.env.MMX_REPORT_LIST_WAIT_MS || 25000);
    try {
        await page.waitForFunction(
            (name, looseMode) => {
                const want = name.toLowerCase();
                for (const sel of document.querySelectorAll('select')) {
                    const label = ((sel.closest('tr, td') || sel).innerText || '').toLowerCase();
                    const hasInventory = Array.from(sel.options).some((o) => /inventory|special event/i.test(o.text));
                    const hasScm = Array.from(sel.options).some((o) => /scm|items on/i.test(o.text));
                    if (!looseMode && !label.includes('report') && !hasScm) continue;
                    if (looseMode && !label.includes('report') && !hasInventory && !hasScm) continue;
                    for (const opt of sel.options) {
                        const t = (opt.textContent || '').trim();
                        if (t.toLowerCase().includes(want) || want.includes(t.toLowerCase())) return true;
                    }
                }
                return false;
            },
            { timeout: timeoutMs },
            reportName,
            loose
        );
    } catch (err) {
        const lists = await listReportOptions(page, opts).catch(() => []);
        log.warn(`Report list never showed "${reportName}" (${timeoutMs}ms). Visible lists:`, JSON.stringify(lists));
        throw err;
    }
}

async function selectReportInList(page, reportName, opts = {}) {
    const loose = Boolean(opts.loose);
    await waitForReportInList(page, reportName, opts);
    const picked = await page.evaluate(
        (name, looseMode) => {
        const want = name.toLowerCase();
        for (const sel of document.querySelectorAll('select')) {
            const label = ((sel.closest('tr, td') || sel).innerText || '').toLowerCase();
            const hasInventory = Array.from(sel.options).some((o) => /inventory|special event/i.test(o.text));
            const hasScm = Array.from(sel.options).some((o) => /scm|items on/i.test(o.text));
            if (
                !looseMode &&
                !label.includes('report') &&
                !hasScm
            ) {
                continue;
            }
            if (looseMode && !label.includes('report') && !hasInventory && !hasScm) {
                continue;
            }
            for (const opt of sel.options) {
                const t = (opt.textContent || '').trim();
                if (t.toLowerCase().includes(want) || want.includes(t.toLowerCase())) {
                    if (sel.multiple) {
                        for (const o of sel.options) o.selected = false;
                    }
                    opt.selected = true;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    sel.dispatchEvent(new Event('click', { bubbles: true }));
                    return t;
                }
            }
        }
        return null;
    },
        reportName,
        loose
    );

    if (!picked) {
        const lists = await listReportOptions(page, opts).catch(() => []);
        log.warn(`Reports list: could not select "${reportName}". Visible lists:`, JSON.stringify(lists));
        throw new Error(`Reports list: could not select "${reportName}"`);
    }
    log.info(`Report selected: ${picked}`);
    await page.waitForTimeout(2000);
}

function formatNeedles(formatText) {
    const want = String(formatText || '').trim().toLowerCase();
    const needles = new Set([want]);
    if (want === 'csv') {
        needles.add('comma');
        needles.add('delimited');
        needles.add('separated');
    }
    if (want.includes('excel')) {
        needles.add('excel data only');
        needles.add('data only');
    }
    return [...needles];
}

async function pickFormatInPage(page, needles) {
    return page.evaluate((needlesArr) => {
        const matches = (text) => {
            const t = String(text || '').trim().toLowerCase();
            return needlesArr.some((n) => t.includes(n) || (n.length > 3 && t === n));
        };
        for (const sel of document.querySelectorAll('select')) {
            const near = (sel.closest('tr, td, div') || sel).innerText || '';
            if (
                !/excel|format|report|csv|comma/i.test(near) &&
                !Array.from(sel.options).some((o) => /excel|csv|comma/i.test(o.text))
            ) {
                continue;
            }
            for (const opt of sel.options) {
                if (matches(opt.textContent)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return opt.textContent.trim();
                }
            }
        }
        for (const sel of document.querySelectorAll('select')) {
            for (const opt of sel.options) {
                if (matches(opt.textContent)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return opt.textContent.trim();
                }
            }
        }
        for (const inp of document.querySelectorAll('input[type="radio"]')) {
            const label =
                (inp.id && document.querySelector(`label[for="${inp.id}"]`)?.textContent) ||
                inp.parentElement?.textContent ||
                '';
            if (matches(label)) {
                inp.click();
                return label.trim().slice(0, 80);
            }
        }
        return null;
    }, needles);
}

async function setReportFormat(page, formatText) {
    const needles = formatNeedles(formatText);

    await page
        .waitForFunction(
            () => {
                for (const sel of document.querySelectorAll('select')) {
                    if (Array.from(sel.options).some((o) => /excel|csv|comma|format/i.test(o.textContent || ''))) {
                        return true;
                    }
                }
                return document.querySelectorAll('input[type="radio"]').length > 0;
            },
            { timeout: 20000 }
        )
        .catch(() => null);
    await page.waitForTimeout(1500);

    let picked = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
        picked = await pickFormatInPage(page, needles);
        if (picked) break;
        log.warn(`Format "${formatText}" not ready (attempt ${attempt}/4), waiting…`);
        await page.waitForTimeout(1500);
    }

    if (!picked) {
        const available = await page.evaluate(() => {
            const out = [];
            for (const sel of document.querySelectorAll('select')) {
                const opts = Array.from(sel.options).map((o) => o.textContent.trim());
                if (opts.some((o) => /excel|csv|format|comma/i.test(o))) out.push(...opts);
            }
            return [...new Set(out)].slice(0, 20).join(' | ');
        });
        throw new Error(
            `Format dropdown: could not select "${formatText}"` +
                (available ? `. Options seen: ${available}` : '')
        );
    }
    log.info(`Report format: ${picked}`);
    await page.waitForTimeout(500);
}

async function setStartDate(page, dateText) {
    return setReportStartDate(page, dateText);
}

async function setEndDate(page, dateText) {
    return setReportEndDate(page, dateText);
}

function storeNeedles(storeName) {
    const s = String(storeName || '').trim();
    const needles = new Set();
    if (s) needles.add(s.toLowerCase());
    const nameOnly = s.replace(/^\d+\s*/, '').trim().toLowerCase();
    if (nameOnly) needles.add(nameOnly);
    const num = s.match(/\b(\d{4})\b/);
    if (num) needles.add(num[1]);
    return [...needles];
}

async function tryStoreDropdown(page, needle) {
    return page.evaluate((want) => {
        const matchesStore = (text) => {
            const t = String(text || '').trim().toLowerCase();
            if (!t) return false;
            if (/^\d+$/.test(want)) {
                const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
            }
            return t.includes(want) || want.includes(t);
        };
        for (const sel of document.querySelectorAll('select')) {
            const ctx = ((sel.closest('tr, td, div, table') || sel).innerText || '').toLowerCase();
            if (!ctx.includes('store') && !Array.from(sel.options).some((o) => /\b\d{4}\b/.test(o.text))) {
                continue;
            }
            for (const opt of sel.options) {
                if (matchesStore(opt.textContent)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return opt.textContent.trim();
                }
            }
        }
        return null;
    }, needle);
}

function storeTreeHints(storeName, storeNumber) {
    const cfg = getStoreConfig(storeNumber) || {};
    const hints = new Set([
        'tba area',
        'collins food',
        'tba market',
        'area 22',
        'area 21',
        'area 1',
        'area 2',
    ]);
    const area = String(cfg.area || '').trim().toLowerCase();
    if (area) hints.add(area);
    const name = String(cfg.storeName || storeName || '')
        .replace(/^\d+\s*/, '')
        .trim()
        .toLowerCase();
    if (name) hints.add(name);
    return [...hints];
}

async function expandStoreTree(page, hints = []) {
    const needles = new Set(hints.map((h) => String(h).toLowerCase()).filter(Boolean));
    await page.evaluate((list) => {
        for (const el of document.querySelectorAll('a, span, label, div, img, td, li')) {
            const t = (el.textContent || el.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t || t.length > 80) continue;
            for (const needle of list) {
                if (t.includes(needle)) {
                    try {
                        el.click();
                    } catch (e) {
                        /* ignore */
                    }
                    break;
                }
            }
        }
        for (const plus of document.querySelectorAll('.rtPlus')) {
            try {
                plus.click();
            } catch (e) {
                /* ignore */
            }
        }
    }, [...needles]);
    await page.waitForTimeout(800);
}

async function storeVisibleInTree(page, storeNumber) {
    const want = String(storeNumber || '').replace(/\D/g, '');
    if (!want) return false;
    return page.evaluate((w) => {
        const re = new RegExp(`(^|\\D)${w}(\\D|$)`);
        for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
            const row = cb.closest('tr, div, li, span, label') || cb.parentElement;
            const text = (row?.textContent || '').replace(/\s+/g, ' ');
            if (re.test(text)) return true;
        }
        return false;
    }, want);
}

async function reportHasStoreDropdown(page) {
    return page.evaluate(
        () =>
            Boolean(
                document.querySelector('input[id*="DropDownListStore"]') ||
                document.getElementById('ctl00_ph_DropDownListStore')
            )
    );
}

async function reportUsesStoreTree(page) {
    return page.evaluate(() => {
        for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
            const row = cb.closest('tr, div, li, span, label') || cb.parentElement;
            const text = (row?.textContent || '').replace(/\s+/g, ' ');
            if (/\b\d{4}\b/.test(text)) return true;
        }
        return Boolean(document.querySelector('.RadTreeView, .rtPlus, .rtMinus'));
    });
}

/** SCM flat reports: store tree loads after dates — expand Area nodes until the store row appears. */
async function prepareStoreTreeForSelection(page, storeName, storeNumber, timeoutMs = 45000) {
    const num = String(storeNumber || storeName.match(/\b(\d{4})\b/)?.[1] || '').trim();
    const hints = storeTreeHints(storeName, num);
    const started = Date.now();
    let lastLog = 0;

    while (Date.now() - started < timeoutMs) {
        if (await storeVisibleInTree(page, num)) {
            log.info(`Store ${num} visible in report tree`);
            return true;
        }
        if (Date.now() - lastLog >= 5000) {
            log.info(`Expanding report store tree for ${num || storeName}…`);
            lastLog = Date.now();
        }
        await expandStoreTree(page, hints);
        await page.waitForTimeout(600);
    }

    log.warn(
        `Store ${num || storeName} not visible in report tree after ${Math.round(timeoutMs / 1000)}s — trying selection anyway`
    );
    return false;
}

async function tryStoreTree(page, needle, treeHints = []) {
    await expandStoreTree(page, treeHints);

    return page.evaluate((want) => {
        const matchesStore = (text) => {
            const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t) return false;
            if (/^\d+$/.test(want)) {
                const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
            }
            return t.includes(want);
        };
        for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
            const row = cb.closest('tr, div, li, span, label') || cb.parentElement;
            const text = (row && row.textContent ? row.textContent : '').replace(/\s+/g, ' ').toLowerCase();
            if (matchesStore(text)) {
                row?.scrollIntoView?.({ block: 'center' });
                if (!cb.checked) cb.click();
                return text.trim().slice(0, 80);
            }
        }
        for (const el of document.querySelectorAll('label, span, a, option, td')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (matchesStore(t) && t.length < 60) {
                el.scrollIntoView?.({ block: 'center' });
                const cb = el.querySelector('input[type="checkbox"]') || el.previousElementSibling;
                if (cb && cb.type === 'checkbox') {
                    if (!cb.checked) cb.click();
                    return t;
                }
            }
        }
        return null;
    }, needle);
}

async function tryStoreClickByText(page, needle) {
    const handle = await page.evaluateHandle((want) => {
        const matchesStore = (text) => {
            const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t) return false;
            if (/^\d+$/.test(want)) {
                const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
            }
            return t.includes(want);
        };
        for (const el of document.querySelectorAll('label, span, a, td, div')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!matchesStore(t) || t.length > 70) continue;
            if (el.children.length > 4) continue;
            const cb = el.querySelector('input[type="checkbox"]');
            if (cb) return cb;
            if (/\b\d{4}\b/.test(t)) return el;
        }
        return null;
    }, needle);
    const el = handle.asElement();
    if (!el) return null;
    await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    await el.click();
    const label = await el.evaluate((node) => {
        const row = node.closest('tr, div, li, span, label') || node;
        return (row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    });
    return label || needle;
}

async function tryStoreInFrames(page, needles) {
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        for (const needle of needles) {
            try {
                const picked = await frame.evaluate((want) => {
                    const matchesStore = (text) => {
                        const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        if (!t) return false;
                        if (/^\d+$/.test(want)) {
                            const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
                        }
                        return t.includes(want);
                    };
                    for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
                        const row = cb.closest('tr, div, li, span, label') || cb.parentElement;
                        const text = (row?.textContent || '').replace(/\s+/g, ' ').toLowerCase();
                        if (matchesStore(text)) {
                            if (!cb.checked) cb.click();
                            return text.trim().slice(0, 80);
                        }
                    }
                    for (const sel of document.querySelectorAll('select')) {
                        for (const opt of sel.options) {
                            if (matchesStore(opt.textContent)) {
                                sel.value = opt.value;
                                sel.dispatchEvent(new Event('change', { bubbles: true }));
                                return opt.textContent.trim();
                            }
                        }
                    }
                    return null;
                }, needle);
                if (picked) return picked;
            } catch (e) {
                /* frame detached */
            }
        }
    }
    return null;
}

async function tryStoreReportDropdown(page, storeNumber, storeName) {
    const needles = storeNeedles(storeName || storeNumber);
    const inputSelectors = [
        'input[id*="DropDownListStore_Input"]',
        'input[id*="DropDownListStore"]',
        'input[name*="DropDownListStore"]',
    ];

    let input = null;
    for (const sel of inputSelectors) {
        input = await page.$(sel);
        if (input) break;
    }
    if (!input) return null;

    const matchesStore = (text, want) => {
        const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!t) return false;
        if (/^\d+$/.test(want)) {
            const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
        }
        return t.includes(want) || want.includes(t);
    };

    async function pickFromOpenList(want) {
        return page.evaluate((needle) => {
            const matches = (text) => {
                const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (!t) return false;
                if (/^\d+$/.test(needle)) {
                    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
                }
                return t.includes(needle) || needle.includes(t);
            };
            const nodes = document.querySelectorAll(
                '.rcbList li, .rcbItem, .RadComboBoxDropDown li, [id*="DropDownListStore"] .rcbItem, [role="listbox"] [role="option"]'
            );
            for (const el of nodes) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (matches(t)) {
                    el.click();
                    return t;
                }
            }
            return null;
        }, want);
    }

    async function openDropdown() {
        await input.click();
        await page.waitForTimeout(250);
        await page.evaluate(() => {
            const root =
                document.querySelector('[id*="DropDownListStore"]') ||
                document.getElementById('ctl00_ph_DropDownListStore');
            const arrow = root?.querySelector('.rcbArrowCell a, .rcbArrowCell, a.rcbArrow');
            arrow?.click();
        });
        await page.waitForTimeout(400);
    }

    await openDropdown();
    for (const needle of needles) {
        const picked = await pickFromOpenList(needle);
        if (picked) return picked;
    }

    if (storeNumber) {
        await input.click({ clickCount: 3 });
        await page.waitForTimeout(100);
        await page.keyboard.press('Backspace');
        await page.keyboard.type(String(storeNumber), { delay: 35 });
        await page.waitForTimeout(600);
        for (const needle of needles) {
            const picked = await pickFromOpenList(needle);
            if (picked) return picked;
        }
    }

    const current = await input.evaluate((el) => (el.value || '').trim());
    for (const needle of needles) {
        if (matchesStore(current, needle)) return current;
    }

    return null;
}

async function tryStoreReportTextboxes(page, storeNumber, storeName) {
    return page.evaluate(({ num, name }) => {
        const isStoreContext = (ctx) => /store/i.test(ctx) && !/restore|history|report name|report format|report group/i.test(ctx);
        const candidates = [];

        for (const inp of document.querySelectorAll('input[type="text"], input:not([type])')) {
            const id = (inp.id || '').toLowerCase();
            const ctx = ((inp.closest('tr, td, table, div') || inp.parentElement)?.innerText || '').slice(0, 240);
            if (id.includes('textbox') || isStoreContext(ctx)) {
                candidates.push({ inp, ctx, id });
            }
        }

        for (const { inp, ctx, id } of candidates) {
            if (!id.includes('textbox') && !isStoreContext(ctx)) continue;
            const val = num || name;
            inp.focus();
            inp.value = val;
            inp.dispatchEvent(new Event('input', { bubbles: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            inp.dispatchEvent(new Event('blur', { bubbles: true }));
            return `${id || 'textbox'}=${val}`;
        }
        return null;
    }, { num: storeNumber, name: storeName });
}

async function tryStoreRadCombo(page, needle) {
    const picked = await page.evaluate((want) => {
        const matchesStore = (text) => {
            const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t) return false;
            if (/^\d+$/.test(want)) {
                const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
            }
            return t.includes(want) || want.includes(t);
        };

        for (const inp of document.querySelectorAll('input[id*="RadComboBox"], input.rcbInput')) {
            const ctx = ((inp.closest('tr, td, table, div') || inp.parentElement)?.innerText || '').toLowerCase();
            if (!ctx.includes('store')) continue;
            inp.click();
            return { type: 'combo', id: inp.id };
        }

        for (const sel of document.querySelectorAll('select')) {
            const ctx = ((sel.closest('tr, td, table, div') || sel).innerText || '').toLowerCase();
            if (!ctx.includes('store')) continue;
            for (const opt of sel.options) {
                if (matchesStore(opt.textContent)) {
                    sel.value = opt.value;
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    return { type: 'select', label: opt.textContent.trim() };
                }
            }
        }
        return null;
    }, needle);

    if (!picked) return null;
    if (picked.type === 'select') return picked.label;

    await page.waitForTimeout(400);
    const clicked = await page.evaluate((want) => {
        const matchesStore = (text) => {
            const t = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (!t) return false;
            if (/^\d+$/.test(want)) {
                const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                return new RegExp(`(^|\\D)${escaped}(\\D|$)`).test(t);
            }
            return t.includes(want);
        };
        for (const el of document.querySelectorAll('.rcbList li, .rcbItem, [role="listbox"] [role="option"]')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (matchesStore(t)) {
                el.click();
                return t;
            }
        }
        return null;
    }, needle);
    return clicked;
}

async function waitForStoreReportDropdownReady(page, storeName, storeNumber, timeoutMs = 20000) {
    if (!(await reportHasStoreDropdown(page))) return;

    const started = Date.now();
    const needles = storeNeedles(storeName || storeNumber);
    const numericNeedles = needles.filter((n) => /^\d+$/.test(n));
    let lastLog = 0;

    while (Date.now() - started < timeoutMs) {
        const ready = await page.evaluate(({ numeric, textual }) => {
            const optionNodes = document.querySelectorAll(
                '.rcbList li, .rcbItem, .RadComboBoxDropDown li, [id*="DropDownListStore"] .rcbItem, [role="listbox"] [role="option"]'
            );
            const samples = [];
            for (const node of optionNodes) {
                const t = (node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (t) samples.push(t);
            }

            const input =
                document.querySelector('input[id*="DropDownListStore_Input"]') ||
                document.querySelector('input[id*="DropDownListStore"]') ||
                document.querySelector('input[name*="DropDownListStore"]');
            const inputValue = (input?.value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (inputValue) samples.push(inputValue);

            const hasNeedle = (want) => {
                if (!want) return false;
                if (/^\d+$/.test(want)) {
                    const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const re = new RegExp(`(^|\\D)${escaped}(\\D|$)`);
                    return samples.some((s) => re.test(s));
                }
                return samples.some((s) => s.includes(want) || want.includes(s));
            };

            return numeric.some(hasNeedle) || textual.some(hasNeedle);
        }, { numeric: numericNeedles, textual: needles });

        if (ready) return;
        if (Date.now() - lastLog >= 5000) {
            log.info(`Waiting for store dropdown (${storeNumber || storeName})…`);
            lastLog = Date.now();
        }
        await page.waitForTimeout(1000);
    }

    log.warn(
        `Store dropdown did not fully populate within ${Math.round(timeoutMs / 1000)}s; attempting selection anyway`
    );
}

/** Store Reports → Inventory Special Event uses DropDownListStore (RadCombo). */
async function selectStoreForStoreReport(page, storeName, opts = {}) {
    if (opts.waitMs) await page.waitForTimeout(opts.waitMs);

    const storeNumber = String(opts.storeNumber || storeName.match(/\b(\d{4})\b/)?.[1] || '').trim();
    await waitForStoreReportDropdownReady(page, storeName, storeNumber, opts.dropdownReadyTimeoutMs || 90000);

    const fromDropdown = await tryStoreReportDropdown(page, storeNumber, storeName);
    if (fromDropdown) {
        log.info(`Store selected (report dropdown): ${fromDropdown}`);
        await page.waitForTimeout(500);
        return;
    }

    const needles = storeNeedles(storeName);
    for (const needle of needles) {
        const fromCombo = await tryStoreRadCombo(page, needle);
        if (fromCombo) {
            log.info(`Store selected (combo): ${fromCombo}`);
            await page.waitForTimeout(500);
            return;
        }
    }

    if (opts.optional) {
        log.warn(`Store not found for "${storeName}" — continuing (optional)`);
        return;
    }

    throw new Error(`Store: could not select "${storeName}" in report dropdown (tried: ${needles.join(', ')})`);
}

async function clearStoreTreeSelections(page) {
    await page.evaluate(() => {
        for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
            const row = cb.closest('tr, div, li, span, label') || cb.parentElement;
            const text = (row?.textContent || '').replace(/\s+/g, ' ').toLowerCase();
            if (!/\b\d{4}\b/.test(text) && !text.includes('store')) continue;
            if (cb.checked) cb.click();
        }
    });
    await page.waitForTimeout(300);
}

async function selectStore(page, storeName, opts = {}) {
    const storeNumber = String(opts.storeNumber || storeName.match(/\b(\d{4})\b/)?.[1] || '').trim();
    const treeHints = storeTreeHints(storeName, storeNumber);
    const needles = storeNeedles(storeName);
    const settleMs = Number(opts.waitMs ?? process.env.MMX_REPORT_STORE_SETTLE_MS ?? 2500);
    if (settleMs > 0) await page.waitForTimeout(settleMs);

    log.info(`Selecting store for report: ${storeNumber || storeName}`);

    const [hasTree, hasDropdown] = await Promise.all([
        reportUsesStoreTree(page),
        reportHasStoreDropdown(page),
    ]);

    if (hasDropdown) {
        await waitForStoreReportDropdownReady(
            page,
            storeName,
            storeNumber,
            opts.dropdownReadyTimeoutMs || 20000
        );
    }

    if (hasTree) {
        await prepareStoreTreeForSelection(
            page,
            storeName,
            storeNumber,
            opts.treeReadyTimeoutMs || 45000
        );
        await clearStoreTreeSelections(page);
        for (const needle of needles) {
            const fromTree = await tryStoreTree(page, needle, treeHints);
            if (fromTree) {
                log.info(`Store selected (tree): ${fromTree}`);
                await page.waitForTimeout(500);
                return;
            }
        }
    }

    const fromReportDropdown = await tryStoreReportDropdown(page, storeNumber, storeName);
    if (fromReportDropdown) {
        log.info(`Store selected (report dropdown): ${fromReportDropdown}`);
        await page.waitForTimeout(500);
        return;
    }

    for (const needle of needles) {
        const fromDropdown = await tryStoreDropdown(page, needle);
        if (fromDropdown) {
            log.info(`Store selected (dropdown): ${fromDropdown}`);
            await page.waitForTimeout(500);
            return;
        }
    }

    if (storeNumber) {
        const fromCombo = await selectStoreOnPage(page, storeNumber);
        if (fromCombo) {
            log.info(`Store selected (RadCombo): ${fromCombo}`);
            await page.waitForTimeout(500);
            return;
        }
    }

    const fromTextbox = await tryStoreReportTextboxes(page, storeNumber, storeName);
    if (fromTextbox) {
        log.info(`Store selected (textbox): ${fromTextbox}`);
        await page.waitForTimeout(500);
        return;
    }

    for (const needle of needles) {
        const clicked = await tryStoreClickByText(page, needle);
        if (clicked) {
            log.info(`Store selected (click): ${clicked}`);
            await page.waitForTimeout(500);
            return;
        }
    }

    const fromFrame = await tryStoreInFrames(page, needles);
    if (fromFrame) {
        log.info(`Store selected (frame): ${fromFrame}`);
        await page.waitForTimeout(500);
        return;
    }

    if (opts.optional) {
        log.warn(`Store not found for "${storeName}" — continuing (optional)`);
        return;
    }

    throw new Error(`Store: could not select "${storeName}" (tried: ${needles.join(', ')})`);
}

async function clickGenerate(page, buttonText = 'Generate') {
    const clicked = await page.evaluate((label) => {
        const want = label.toLowerCase();
        for (const el of document.querySelectorAll('input, button, a')) {
            const t = (el.value || el.textContent || '').trim().toLowerCase();
            if (t === want || t.includes(want)) {
                el.click();
                return t || label;
            }
        }
        return null;
    }, buttonText);

    if (!clicked) throw new Error(`Generate button not found`);
    log.info('Clicked Generate');
    await page.waitForTimeout(1000);
}

function dateOpts(report) {
    return { timeZone: report.timeZone, dateOnly: Boolean(report.dateOnly) };
}

async function configureAndGenerateReport(page, report, reportNav) {
    await openReportSelectionPage(page, reportNav, report.navTimeoutMs || 45000);
    await setGroupDropdown(page, report.group || 'Supply Chain');
    await selectReportInList(page, report.reportName);
    await setReportFormat(page, report.format || 'Excel Data Only');
    await page.waitForTimeout(1000);

    const startDate = resolveReportDate(report.startDate || 'lastWeekMonday', dateOpts(report));
    await setStartDate(page, startDate);

    if (report.endDate) {
        const endDate = resolveReportDate(report.endDate, dateOpts(report));
        await setEndDate(page, endDate);
    }

    if (report.storeName && !report.skipStoreSelection) {
        await selectStore(page, report.storeName, {
            storeNumber: report.storeNumber,
        });
    }

    await clickGenerate(page, report.generateButtonText || 'Generate');
}

async function runSupplyChainReport(page, report, settings) {
    const reportNav = settings.pipeline.reportNavigation;
    if (!reportNav?.url) {
        throw new Error('pipeline.reportNavigation.url is required');
    }

    const cfg = {
        ...report,
        navTimeoutMs: settings.navTimeoutMs,
    };

    await withPageContextRetry(page, `supply chain ${report.id}`, async () => {
        await configureAndGenerateReport(page, cfg, reportNav);
    });
}

function isSupplyChainReport(report) {
    return report.type === 'supplyChain';
}

module.exports = {
    openReportSelectionPage,
    setGroupDropdown,
    selectReportInList,
    setReportFormat,
    setStartDate,
    setEndDate,
    selectStore,
    selectStoreForStoreReport,
    clickGenerate,
    configureAndGenerateReport,
    runSupplyChainReport,
    isSupplyChainReport,
};
