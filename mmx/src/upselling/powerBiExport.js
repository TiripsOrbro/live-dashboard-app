const fs = require('fs');
const path = require('path');
const log = require('../mmxReports/util-logging');

const PBI_FRAME_RE =
    /powerbi\.com|analysis\.windows\.net|pbidedicated|reportportal|proxy\.aspx|viewframe/i;

function isPbiRelatedFrame(url) {
    return PBI_FRAME_RE.test(String(url || ''));
}

function collectContexts(page) {
    const contexts = [{ name: 'main', ctx: page }];
    for (const frame of page.frames()) {
        const url = frame.url();
        if (frame === page.mainFrame()) continue;
        if (isPbiRelatedFrame(url)) {
            contexts.push({ name: url.slice(-80), ctx: frame });
        }
    }
    return contexts;
}

async function snapshotExportControls(ctx) {
    return ctx
        .evaluate(() => {
            const out = [];
            for (const el of document.querySelectorAll(
                'button, a, [role="menuitem"], [role="button"], [aria-label], [title]'
            )) {
                const label = (
                    el.getAttribute('aria-label') ||
                    el.getAttribute('title') ||
                    el.textContent ||
                    el.value ||
                    ''
                )
                    .trim()
                    .slice(0, 100);
                if (!label) continue;
                if (/export|excel|download|share|more options/i.test(label)) {
                    out.push({ tag: el.tagName, label });
                }
            }
            return out.slice(0, 40);
        })
        .catch((err) => [{ tag: 'error', label: err.message }]);
}

async function waitForPowerBiFrame(page, timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        for (const frame of page.frames()) {
            const url = String(frame.url() || '').toLowerCase();
            if (url.includes('powerbi.com') || url.includes('analysis.windows.net')) {
                return frame;
            }
        }
        await page.waitForTimeout(500);
    }
    return null;
}

/** Wait until report UI has interactive controls in any frame (or timeout). */
async function waitForReportInteractive(page, timeoutMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const contexts = collectContexts(page);
        for (const { ctx } of contexts) {
            const ready = await ctx
                .evaluate(() => {
                    const buttons = document.querySelectorAll(
                        'button, [role="menuitem"], [role="button"], a'
                    ).length;
                    const visuals = document.querySelectorAll(
                        '[class*="visual"], [class*="report"], iframe, table, [role="grid"]'
                    ).length;
                    const loading = document.body?.innerText?.includes('Loading report');
                    return buttons >= 3 && visuals >= 1 && !loading;
                })
                .catch(() => false);
            if (ready) return true;
        }
        await page.waitForTimeout(1000);
    }
    return false;
}

async function clickByLabels(ctx, labels, opts = {}) {
    const wants = (labels || []).map((l) => String(l).trim().toLowerCase()).filter(Boolean);
    const partial = opts.partial !== false;
    return ctx.evaluate(
        (labelList, allowPartial) => {
            const elements = Array.from(
                document.querySelectorAll(
                    'button, a, [role="menuitem"], [role="button"], span, div, li, input, [aria-label], [title]'
                )
            );
            for (const el of elements) {
                const raw = (
                    el.getAttribute('aria-label') ||
                    el.getAttribute('title') ||
                    el.textContent ||
                    el.value ||
                    ''
                )
                    .trim()
                    .toLowerCase();
                if (!raw) continue;
                for (const want of labelList) {
                    if (allowPartial ? raw.includes(want) : raw === want) {
                        el.click();
                        return raw;
                    }
                }
            }
            return null;
        },
        wants,
        partial
    );
}

async function expandMatrixRows(ctx) {
    for (let pass = 0; pass < 8; pass++) {
        const expanded = await ctx.evaluate(() => {
            let count = 0;
            const selectors = [
                '[aria-label*="Expand"]',
                '[title*="Expand"]',
                'button[aria-expanded="false"]',
            ];
            for (const sel of selectors) {
                for (const el of document.querySelectorAll(sel)) {
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
        await new Promise((r) => setTimeout(r, 350));
    }
}

function writeExportDebug(page, cfg, detail) {
    try {
        const store = '3811';
        const dir = path.join(require('../../../src/paths').dashboard.data, 'upselling', store);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'export-debug.json'), JSON.stringify(detail, null, 2), 'utf8');
        log.warn(`[Upselling] Wrote export-debug.json (${detail.frames?.length || 0} frames)`);
    } catch (_) {
        /* ignore */
    }
}

/**
 * Export embedded Power BI report to Excel — scans main page and all related iframes.
 */
async function exportPowerBiToExcel(page, cfg = {}) {
    const settleMs = Number(cfg.reportReadyTimeoutMs) || 90000;

    log.info('[Upselling] Waiting for Power BI report to finish loading…');
    const interactive = await waitForReportInteractive(page, settleMs);
    if (!interactive) {
        log.warn('[Upselling] Report UI slow to load — attempting export anyway');
    }

    const pbiFrame = await waitForPowerBiFrame(page, 15000);
    const contexts = collectContexts(page);
    if (!pbiFrame) {
        log.warn(
            `[Upselling] No powerbi.com iframe (${contexts.length} contexts) — scanning portal frames for Export`
        );
    }

    const debug = {
        at: new Date().toISOString(),
        pageUrl: page.url(),
        frames: page.frames().map((f) => f.url()),
        controls: {},
    };

    for (const { name, ctx } of contexts) {
        await expandMatrixRows(ctx);
        debug.controls[name] = await snapshotExportControls(ctx);
    }

    const exportLabels = cfg.powerBiExportMenuLabels || [
        'export',
        'download',
        'share',
        'more options',
    ];
    const excelLabels = cfg.powerBiExcelLabels || [
        'microsoft excel',
        'excel (.xlsx)',
        'excel',
        'summarized data',
        'underlying data',
        'data with current layout',
        '.xlsx',
    ];

    let exportClicked = null;
    let exportContext = null;
    for (const { name, ctx } of contexts) {
        exportClicked = await clickByLabels(ctx, exportLabels, { partial: true });
        if (exportClicked) {
            exportContext = name;
            break;
        }
    }

    if (!exportClicked) {
        writeExportDebug(page, cfg, debug);
        throw new Error(
            'Power BI Export menu not found in any frame. See data/upselling/3811/export-debug.json and set powerBiExportMenuLabels in config/upselling.json.'
        );
    }

    log.info(`[Upselling] Clicked Export (${exportContext}): "${exportClicked}"`);
    await page.waitForTimeout(1500);

    let excelClicked = null;
    for (const { name, ctx } of contexts) {
        excelClicked = await clickByLabels(ctx, excelLabels, { partial: true });
        if (excelClicked) {
            log.info(`[Upselling] Excel option (${name}): "${excelClicked}"`);
            break;
        }
    }

    if (!excelClicked) {
        debug.afterExportMenu = {};
        for (const { name, ctx } of contexts) {
            debug.afterExportMenu[name] = await snapshotExportControls(ctx);
        }
        writeExportDebug(page, cfg, debug);
        throw new Error(
            'Power BI Excel export option not found after opening Export. See export-debug.json.'
        );
    }

    await page.waitForTimeout(2000);
    return { exportClicked, excelClicked, usedFrame: Boolean(pbiFrame), exportContext };
}

module.exports = {
    waitForPowerBiFrame,
    waitForReportInteractive,
    collectContexts,
    snapshotExportControls,
    exportPowerBiToExcel,
    expandMatrixRows,
};
