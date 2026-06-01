const log = require('../mmxReports/util-logging');

function isOlapReportPage(url) {
    return /mdxview\.aspx|\/olap\//i.test(String(url || ''));
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
                const rows = table.querySelectorAll('tr').length;
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

/**
 * MdxView toolbar: #tdShowExport opens a menu (ShowExport) — pick Excel (not Excel Pivot).
 */
async function clickOlapExcelExport(page, cfg = {}) {
    const menuLabel = String(cfg.olapExportMenuLabel || 'Excel').trim();
    const want = menuLabel.toLowerCase();

    const exportSelectors = [
        '#tdShowExport',
        'button[onclick*="ShowExport"]',
        'button[data-original-title="Export"]',
        'button[title="Export"]',
    ];

    let opened = false;
    for (const sel of exportSelectors) {
        try {
            await page.waitForSelector(sel, { timeout: 8000, visible: true });
            await page.click(sel);
            opened = true;
            break;
        } catch (_) {
            /* try next selector */
        }
    }

    if (!opened) {
        opened = await page.evaluate(() => {
            const btn =
                document.querySelector('#tdShowExport') ||
                document.querySelector('button[onclick*="ShowExport"]');
            if (!btn) return false;
            btn.click();
            return true;
        });
    }

    if (!opened) {
        const viaFn = await page.evaluate(() => {
            try {
                if (typeof ShowExport === 'function') {
                    ShowExport({ preventDefault: () => {}, stopPropagation: () => {} });
                    return true;
                }
            } catch (_) {
                /* ignore */
            }
            return false;
        });
        opened = viaFn;
    }

    if (!opened) {
        throw new Error(
            'Export toolbar button (#tdShowExport / ShowExport) not found on MdxView.'
        );
    }

    await page.waitForTimeout(700);

    const picked = await page.evaluate(
        (labelWant) => {
            function isElementVisible(el) {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return false;
                const s = window.getComputedStyle(el);
                return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
            }

            const candidates = [];
            const nodes = document.querySelectorAll(
                'a, button, li, span, div[role="menuitem"], .dropdown-menu *'
            );

            for (const el of nodes) {
                if (!isElementVisible(el)) continue;
                const text = (el.textContent || '').trim();
                if (!text) continue;
                const t = text.toLowerCase();
                if (t.includes('pivot')) continue;
                if (t === labelWant) {
                    candidates.push({ el, score: 100, text });
                } else if (t === 'excel' && labelWant === 'excel') {
                    candidates.push({ el, score: 90, text });
                } else if (t.startsWith('excel') && t.length <= 12) {
                    candidates.push({ el, score: 50, text });
                }
            }

            candidates.sort((a, b) => b.score - a.score);
            if (!candidates.length) return null;

            candidates[0].el.click();
            return candidates[0].text;
        },
        want
    );

    if (!picked) {
        throw new Error(
            `Export menu opened but "${menuLabel}" option not found (check olapExportMenuLabel in config/upselling.json).`
        );
    }

    return picked;
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
