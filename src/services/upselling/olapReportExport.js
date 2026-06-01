const fs = require('fs');
const path = require('path');
const log = require('../mmxReports/util-logging');

function isOlapReportPage(url) {
    return /mdxview\.aspx|\/olap\//i.test(String(url || ''));
}

function collectOlapContexts(page) {
    const contexts = [{ name: 'main', ctx: page }];
    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        contexts.push({ name: String(frame.url() || '').slice(-100), ctx: frame });
    }
    return contexts;
}

async function snapshotMenuLabels(ctx) {
    return ctx
        .evaluate(() => {
            const out = [];
            for (const el of document.querySelectorAll(
                'a, button, li, span, div, td, [role="menuitem"], [aria-label], [title]'
            )) {
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                const label = (
                    el.getAttribute('aria-label') ||
                    el.getAttribute('title') ||
                    el.getAttribute('data-original-title') ||
                    el.textContent ||
                    ''
                )
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 80);
                if (!label || label.length > 60) continue;
                if (/excel|csv|pdf|html|export|pivot|odc/i.test(label)) {
                    out.push({ tag: el.tagName, label });
                }
            }
            return out.slice(0, 50);
        })
        .catch((err) => [{ tag: 'error', label: err.message }]);
}

function writeOlapExportDebug(page, storeNumber, detail) {
    try {
        const store = String(storeNumber || '3811').trim() || '3811';
        const dir = path.join(__dirname, '..', '..', '..', 'data', 'upselling', store);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'export-menu-debug.json'), JSON.stringify(detail, null, 2), 'utf8');
        log.warn(`[Upselling] Wrote export-menu-debug.json (${detail.frames?.length || 0} frames)`);
    } catch (_) {
        /* ignore */
    }
}

async function waitForOlapReportReady(page, timeoutMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ready = await page
            .evaluate(() => {
                const title = (document.body?.innerText || '').includes('Upsell by Cashier');
                const table =
                    document.querySelector('table') ||
                    document.querySelector('[id*="grid"], [class*="grid"], [role="grid"]');
                const rows = table?.querySelectorAll('tr').length || 0;
                return title && table && rows >= 3;
            })
            .catch(() => false);
        if (ready) return true;
        await page.waitForTimeout(1000);
    }
    return false;
}

/** Expand OLAP category columns (BOX_MEALS, DESSERTS, etc.) before export. */
async function expandOlapCategories(page) {
    for (let pass = 0; pass < 6; pass++) {
        const expanded = await page.evaluate(() => {
            let count = 0;
            for (const el of document.querySelectorAll('a, span, button, td')) {
                const t = (el.textContent || el.getAttribute('title') || '').trim();
                if (/^expand\b/i.test(t)) {
                    try {
                        el.click();
                        count++;
                    } catch (_) {
                        /* ignore */
                    }
                }
            }
            return count;
        });
        if (!expanded) break;
        await page.waitForTimeout(600);
    }
}

async function openOlapExportMenu(page) {
    const exportSelectors = [
        '#tdShowExport',
        '#tdShowExport button',
        'button[onclick*="ShowExport"]',
        'button[data-original-title="Export"]',
        'button[title="Export"]',
    ];

    for (const sel of exportSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 8000 });
            await page.click(sel);
            return true;
        } catch (_) {
            /* try next */
        }
    }

    const opened = await page.evaluate(() => {
        try {
            if (typeof ShowExport === 'function') {
                ShowExport({ preventDefault: () => {}, stopPropagation: () => {} });
                return true;
            }
        } catch (_) {
            /* ignore */
        }
        const btn =
            document.querySelector('#tdShowExport') ||
            document.querySelector('button[onclick*="ShowExport"]');
        if (!btn) return false;
        btn.click();
        return true;
    });

    if (!opened) {
        throw new Error(
            'Export toolbar button (#tdShowExport / ShowExport) not found on MdxView.'
        );
    }
    return true;
}

async function clickExcelInContext(ctx, menuLabel) {
    const want = String(menuLabel || 'Excel').trim().toLowerCase();
    return ctx.evaluate((labelWant) => {
        function labelOf(el) {
            const parts = [
                el.getAttribute('aria-label'),
                el.getAttribute('title'),
                el.getAttribute('data-original-title'),
                el.textContent,
            ];
            for (const img of el.querySelectorAll?.('img') || []) {
                parts.push(img.alt, img.title);
            }
            return parts
                .filter(Boolean)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
        }

        function isVisible(el) {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const s = window.getComputedStyle(el);
            return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
        }

        const candidates = [];
        const nodes = document.querySelectorAll(
            'a, button, li, span, div, td, [role="menuitem"], .dropdown-menu *, [class*="menu"] *'
        );

        for (const el of nodes) {
            if (!isVisible(el)) continue;
            const text = labelOf(el);
            if (!text) continue;
            const t = text.toLowerCase();
            if (t.includes('pivot')) continue;

            const onclick = String(el.getAttribute('onclick') || '').toLowerCase();
            if (onclick.includes('pivot')) continue;

            let score = 0;
            if (t === labelWant) score = 100;
            else if (labelWant === 'excel' && /^excel$/i.test(text)) score = 95;
            else if (labelWant === 'excel' && t.startsWith('excel') && t.length <= 16) score = 70;
            else if (onclick.includes('excel') && !onclick.includes('pivot')) score = 60;
            else if (labelWant === 'excel' && /\bexcel\b/i.test(text) && t.length <= 24) score = 40;

            if (score > 0) candidates.push({ el, score, text });
        }

        candidates.sort((a, b) => b.score - a.score);
        if (!candidates.length) return null;

        try {
            candidates[0].el.click();
            return candidates[0].text;
        } catch (_) {
            return null;
        }
    }, want);
}

async function tryXPathExcelClick(page) {
    const xpaths = [
        "//a[normalize-space(.)='Excel' and not(contains(translate(., 'PIVOT', 'pivot'), 'pivot'))]",
        "//li[contains(translate(., 'EXCEL', 'excel'), 'excel') and not(contains(translate(., 'PIVOT', 'pivot'), 'pivot'))]//a",
        "//*[self::a or self::span or self::td][normalize-space(.)='Excel']",
        "//a[contains(translate(@onclick,'EXCEL','excel'),'excel') and not(contains(translate(@onclick,'PIVOT','pivot'),'pivot'))]",
    ];
    for (const xp of xpaths) {
        try {
            const handles = await page.$x(xp);
            for (const handle of handles) {
                const box = await handle.boundingBox();
                if (!box || box.width <= 0) continue;
                await handle.click();
                return 'xpath';
            }
        } catch (_) {
            /* try next xpath */
        }
    }
    return null;
}

/**
 * MdxView toolbar: #tdShowExport opens a menu (ShowExport) — pick Excel (not Excel Pivot).
 */
async function clickOlapExcelExport(page, cfg = {}) {
    const menuLabel = String(cfg.olapExportMenuLabel || 'Excel').trim();
    const storeNumber = String(cfg.syncStoreNumber || '3811').trim();

    await openOlapExportMenu(page);

    const waitSteps = [400, 800, 1200, 1800];
    let picked = null;
    let lastDebug = null;

    for (const waitMs of waitSteps) {
        await page.waitForTimeout(waitMs);

        const contexts = collectOlapContexts(page);
        for (const { name, ctx } of contexts) {
            picked = await clickExcelInContext(ctx, menuLabel);
            if (picked) {
                log.info(`[Upselling] OLAP export menu (${name}): "${picked}"`);
                return picked;
            }
        }

        picked = await tryXPathExcelClick(page);
        if (picked) {
            log.info('[Upselling] OLAP export menu (xpath): Excel');
            return 'Excel';
        }
    }

    const contexts = collectOlapContexts(page);
    const debug = {
        at: new Date().toISOString(),
        pageUrl: page.url(),
        frames: page.frames().map((f) => f.url()),
        menuLabels: {},
    };
    for (const { name, ctx } of contexts) {
        debug.menuLabels[name] = await snapshotMenuLabels(ctx);
    }
    lastDebug = debug;
    writeOlapExportDebug(page, storeNumber, lastDebug);

    const sample = Object.values(debug.menuLabels)
        .flat()
        .map((x) => x.label)
        .slice(0, 12)
        .join(', ');
    throw new Error(
        `Export menu opened but "${menuLabel}" option not found (visible: ${sample || 'none'}). See data/upselling/${storeNumber}/export-menu-debug.json`
    );
}

async function exportOlapReportToExcel(page, cfg = {}) {
    const timeout = Number(cfg.reportReadyTimeoutMs) || 90000;

    log.info('[Upselling] OLAP report (MdxView) — waiting for grid…');
    const ready = await waitForOlapReportReady(page, timeout);
    if (!ready) {
        log.warn('[Upselling] OLAP grid slow to load — trying export anyway');
    }

    await expandOlapCategories(page);
    await page.waitForTimeout(800);

    log.info('[Upselling] Opening Export menu → Excel…');
    const label = await clickOlapExcelExport(page, cfg);
    log.info(`[Upselling] OLAP export menu choice: ${label}`);
    await page.waitForTimeout(2000);
    return { exportClicked: label, mode: 'olap' };
}

module.exports = {
    isOlapReportPage,
    waitForOlapReportReady,
    expandOlapCategories,
    clickOlapExcelExport,
    exportOlapReportToExcel,
};
