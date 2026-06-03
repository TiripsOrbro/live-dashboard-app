const fs = require('fs');
const path = require('path');
const log = require('../mmxReports/util-logging');
const { upsellingRootDir } = require('./upsellingConfig');

function isOlapReportPage(url) {
    return /mdxview\.aspx|\/olap\//i.test(String(url || ''));
}

async function pageHasOlapReport(page) {
    if (isOlapReportPage(page.url())) return true;
    for (const frame of page.frames()) {
        if (isOlapReportPage(frame.url())) return true;
        const hasExport = await frame.$('#tdShowExport').catch(() => null);
        if (hasExport) return true;
    }
    return false;
}

function collectOlapContexts(page) {
    const contexts = [];
    const seen = new Set();
    for (const frame of page.frames()) {
        const key = String(frame.url() || frame.name() || contexts.length);
        if (seen.has(key)) continue;
        seen.add(key);
        contexts.push({ name: key.slice(-100), ctx: frame });
    }
    return contexts;
}

async function findExportButtonFrame(page) {
    for (const { ctx } of collectOlapContexts(page)) {
        const found = await ctx.$('#tdShowExport').catch(() => null);
        if (found) return ctx;
    }
    return null;
}

async function clickSelectExport(ctx, format = 'csv') {
    const fmt = String(format || 'csv').trim().toLowerCase();
    return ctx.evaluate((formatWant) => {
        for (const el of document.querySelectorAll('div.MenuItem, .MenuItem')) {
            const onclick = String(el.getAttribute('onclick') || '');
            if (onclick.includes(`SelectExport('${formatWant}')`) || onclick.includes(`SelectExport("${formatWant}")`)) {
                el.click();
                return 'MenuItem';
            }
            const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (new RegExp(`^${formatWant}$`, 'i').test(text)) {
                el.click();
                return text;
            }
        }
        try {
            if (typeof SelectExport === 'function') {
                SelectExport(formatWant);
                return 'SelectExport';
            }
        } catch (_) {
            /* ignore */
        }
        try {
            if (typeof parent !== 'undefined' && typeof parent.SelectExport === 'function') {
                parent.SelectExport(formatWant);
                return 'parent.SelectExport';
            }
        } catch (_) {
            /* ignore */
        }
        return null;
    }, fmt);
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

function writeOlapExportDebug(page, _storeNumber, detail) {
    try {
        const dir = upsellingRootDir();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'export-menu-debug.json'), JSON.stringify(detail, null, 2), 'utf8');
        log.warn('[Upselling] Wrote data/upselling/export-menu-debug.json');
    } catch (_) {
        /* ignore */
    }
}

async function waitForOlapReportReady(page, timeoutMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        for (const { ctx } of collectOlapContexts(page)) {
            const ready = await ctx
                .evaluate(() => {
                    const body = document.body?.innerText || '';
                    const loading = /\bloading\.{0,3}\b/i.test(body);
                    const title = /upsell by cashier/i.test(body);
                    const table =
                        document.querySelector('table') ||
                        document.querySelector('[id*="grid"], [class*="grid"], [role="grid"]');
                    const rows = table?.querySelectorAll('tr').length || 0;
                    const hasExport = Boolean(document.querySelector('#tdShowExport'));
                    return !loading && (title || hasExport) && table && rows >= 3;
                })
                .catch(() => false);
            if (ready) return true;
        }
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
    const exportFrame = await findExportButtonFrame(page);
    const ctx = exportFrame || page;

    try {
        await ctx.waitForSelector('#tdShowExport', { timeout: 20000, visible: true });
        await ctx.click('#tdShowExport');
        return ctx;
    } catch (_) {
        /* fall through */
    }

    const opened = await ctx.evaluate(() => {
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
    return ctx;
}

async function clickMenuOptionInContext(ctx, menuLabel, format = 'excel') {
    const want = String(menuLabel || (format === 'csv' ? 'CSV' : 'Excel')).trim().toLowerCase();
    const fmt = String(format || 'excel').trim().toLowerCase();
    return ctx.evaluate((labelWant, formatWant) => {
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
            else if (formatWant === 'csv' && /^csv$/i.test(text)) score = 95;
            else if (formatWant === 'csv' && onclick.includes("selectexport('csv')")) score = 90;
            else if (formatWant === 'csv' && onclick.includes('csv')) score = 70;
            else if (formatWant === 'excel' && /^excel$/i.test(text)) score = 95;
            else if (formatWant === 'excel' && t.startsWith('excel') && t.length <= 16) score = 70;
            else if (formatWant === 'excel' && onclick.includes('excel') && !onclick.includes('pivot')) score = 60;
            else if (formatWant === 'excel' && /\bexcel\b/i.test(text) && t.length <= 24) score = 40;

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
    }, want, fmt);
}

async function tryXPathExportClick(page, format = 'excel') {
    const isCsv = String(format || '').toLowerCase() === 'csv';
    const xpaths = isCsv
        ? [
              "//div[contains(@class,'MenuItem') and normalize-space(.)='CSV']",
              "//*[self::a or self::span or self::div or self::td][normalize-space(.)='CSV']",
              "//div[contains(translate(@onclick,'CSV','csv'),\"selectexport('csv')\")]",
              "//a[contains(translate(@onclick,'CSV','csv'),'csv')]",
          ]
        : [
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
 * MdxView toolbar: #tdShowExport opens a menu (ShowExport) — pick CSV or Excel.
 */
async function clickOlapExportOption(page, cfg = {}) {
    const format = String(cfg.olapExportFormat || 'excel').trim().toLowerCase();
    const menuLabel = String(
        cfg.olapExportMenuLabel || (format === 'csv' ? 'CSV' : 'Excel')
    ).trim();
    const storeNumber = String(cfg.syncStoreNumber || '3811').trim();

    const exportFrame = await openOlapExportMenu(page);

    const waitSteps = [300, 600, 1000, 1500];
    let picked = null;

    for (const waitMs of waitSteps) {
        await page.waitForTimeout(waitMs);

        picked = await clickSelectExport(exportFrame, format);
        if (picked) {
            log.info(`[Upselling] OLAP export (${exportFrame.url?.().slice(-60) || 'frame'}): ${menuLabel} via ${picked}`);
            return menuLabel;
        }

        const contexts = collectOlapContexts(page);
        for (const { name, ctx } of contexts) {
            picked = await clickSelectExport(ctx, format);
            if (picked) {
                log.info(`[Upselling] OLAP export menu (${name}): "${menuLabel}" via ${picked}`);
                return menuLabel;
            }
            picked = await clickMenuOptionInContext(ctx, menuLabel, format);
            if (picked) {
                log.info(`[Upselling] OLAP export menu (${name}): "${picked}"`);
                return picked;
            }
        }

        picked = await tryXPathExportClick(page, format);
        if (picked) {
            log.info(`[Upselling] OLAP export menu (xpath): ${format.toUpperCase()}`);
            return format.toUpperCase();
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
    writeOlapExportDebug(page, storeNumber, debug);

    const sample = Object.values(debug.menuLabels)
        .flat()
        .map((x) => x.label)
        .slice(0, 12)
        .join(', ');
    throw new Error(
        `Export menu opened but "${menuLabel}" option not found (visible: ${sample || 'none'}). See data/upselling/${storeNumber}/export-menu-debug.json`
    );
}

async function exportOlapReportToFile(page, cfg = {}) {
    const timeout = Number(cfg.reportReadyTimeoutMs) || 90000;

    log.info('[Upselling] OLAP report (MdxView) — waiting for grid…');
    const ready = await waitForOlapReportReady(page, timeout);
    if (!ready) {
        log.warn('[Upselling] OLAP grid slow to load — trying export anyway');
    }

    await expandOlapCategories(page);
    await page.waitForTimeout(800);

    const format = String(cfg.olapExportFormat || 'excel').trim().toLowerCase();
    log.info(`[Upselling] Opening Export menu → ${format.toUpperCase()}…`);
    const label = await clickOlapExportOption(page, cfg);
    log.info(`[Upselling] OLAP export menu choice: ${label}`);
    await page.waitForTimeout(2000);
    return { exportClicked: label, mode: 'olap', format };
}

module.exports = {
    isOlapReportPage,
    pageHasOlapReport,
    waitForOlapReportReady,
    expandOlapCategories,
    clickOlapExportOption,
    exportOlapReportToFile,
};
