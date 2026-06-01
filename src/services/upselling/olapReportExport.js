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
 * Click the Report Portal OLAP toolbar Excel export (icon row above the grid).
 */
async function clickOlapExcelExport(page, cfg = {}) {
    const wantText = String(cfg.exportLinkText || 'excel').toLowerCase();

    const clicked = await page.evaluate((excelWant) => {
        const candidates = [];

        const add = (el, score, labelHint) => {
            if (!el) return;
            candidates.push({ el, score, labelHint });
        };

        const scoreElement = (el) => {
            const title = (el.getAttribute('title') || el.getAttribute('alt') || '').trim().toLowerCase();
            const text = (el.textContent || el.value || '').trim().toLowerCase();
            const href = (el.getAttribute('href') || '').toLowerCase();
            const src = (el.getAttribute('src') || '').toLowerCase();
            const onclick = (el.getAttribute('onclick') || '').toLowerCase();
            const id = (el.getAttribute('id') || '').toLowerCase();
            const name = (el.getAttribute('name') || '').toLowerCase();
            const label = `${title} ${text} ${href} ${src} ${onclick} ${id} ${name}`;

            if (/pdf|word|xml|csv only/i.test(label) && !/excel|\.xls/i.test(label)) return null;
            if (
                !label.includes(excelWant) &&
                !/\.xls|excel|spreadsheet|exporttoexcel|export.*excel/i.test(label)
            ) {
                return null;
            }

            let score = 0;
            if (/export.*excel|excel.*export|exporttoexcel/i.test(label)) score += 20;
            if (title.includes(excelWant) || text.includes(excelWant)) score += 10;
            if (/excel/i.test(title) || /excel/i.test(alt)) score += 8;
            if (/\.xls/i.test(href) || /excel/i.test(href) || /excel/i.test(onclick)) score += 6;
            if (el.tagName === 'INPUT' && el.type === 'image') score += 4;
            if (/toolbar|export/i.test(id) || /toolbar|export/i.test(name)) score += 3;
            return { score, label: title || text || id || 'excel' };
        };

        const selectors =
            'a, button, input[type="image"], input[type="button"], img, span[onclick], area[onclick]';
        for (const el of document.querySelectorAll(selectors)) {
            const hit = scoreElement(el);
            if (hit) add(el, hit.score, hit.label);
            if (el.tagName === 'IMG' && el.parentElement) {
                const parentHit = scoreElement(el.parentElement);
                if (parentHit) add(el.parentElement, parentHit.score + 1, parentHit.label);
            }
        }

        candidates.sort((a, b) => b.score - a.score);
        if (!candidates.length) return null;

        candidates[0].el.click();
        return candidates[0].labelHint || 'excel';
    }, wantText);

    if (!clicked) {
        throw new Error(
            'OLAP Excel export button not found on MdxView toolbar. Set exportLinkText in config/upselling.json or use --scrape for headed debugging.'
        );
    }

    return clicked;
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

    const label = await clickOlapExcelExport(page, cfg);
    log.info(`[Upselling] OLAP export clicked: ${label}`);
    await page.waitForTimeout(2000);
    return { exportClicked: label, mode: 'olap' };
}

module.exports = {
    isOlapReportPage,
    waitForOlapReportReady,
    expandOlapCategories,
    exportOlapReportToExcel,
};
