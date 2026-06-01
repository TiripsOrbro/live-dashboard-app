const { GOTO_OPTS } = require('../mmxReports/mmx-browser');
const log = require('../mmxReports/util-logging');

/** Business Intelligence / Power BI report portal (MenuCustomItemID=227). */
const DEFAULT_BI_ENTRY_URL =
    'https://tacobellau.macromatix.net/MMS_System_ReportPortal.aspx?MenuCustomItemID=227';

/** Direct Upsell by Cashier report (requires portal session cookie after login). */
const DEFAULT_BI_REPORT_URL =
    'https://tacobellau.macromatix.net/reportportal5/Proxy.aspx?reportId=317';

function findReportTreeFrame(page) {
    return page.frames().find((f) => /reportTree\.aspx/i.test(String(f.url() || '')));
}

async function treeSnapshot(frame) {
    return frame.evaluate(() => {
        const labels = [...document.querySelectorAll('.rtIn, .rtOut, span, a')]
            .map((el) => (el.textContent || '').trim())
            .filter((t) => t.length > 1 && t.length < 80);
        return {
            hasSearch: Boolean(document.querySelector('input[type="text"]')),
            spanCount: document.querySelectorAll('span').length,
            body: (document.body.innerText || '').slice(0, 120),
            hasUpsell: labels.some((t) => /upsell/i.test(t) && /cashier/i.test(t)),
            hasVic: labels.some((t) => /^vic$/i.test(t)),
            hasAsh: labels.some((t) => /^ash$/i.test(t)),
        };
    });
}

/**
 * Wait for Report Portal tree iframe; full label list can take 10–40s after login.
 */
async function waitForReportTreeFrame(page, timeoutMs = 60000) {
    const start = Date.now();
    let frame = null;

    while (Date.now() - start < timeoutMs) {
        frame = findReportTreeFrame(page);
        if (frame) {
            const snap = await treeSnapshot(frame).catch(() => null);
            if (snap) {
                const basicReady =
                    /reports/i.test(snap.body) ||
                    snap.hasVic ||
                    snap.hasUpsell ||
                    (snap.hasSearch && snap.spanCount > 40);
                if (basicReady) return frame;
            }
        }
        await page.waitForTimeout(1000);
    }

    if (frame) return frame;
    throw new Error(
        'Report Portal tree did not load. Open ' +
            DEFAULT_BI_ENTRY_URL +
            ' after logging into Macromatix.'
    );
}

/** Poll until Upsell by Cashier (or search box + large tree) is available. */
async function waitForTreeLabels(page, frame, reportName, timeoutMs = 45000) {
    const want = String(reportName || 'Upsell by Cashier').trim().toLowerCase();
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        const current = findReportTreeFrame(page) || frame;
        const snap = await treeSnapshot(current).catch(() => ({}));
        if (snap.hasUpsell) return current;
        const found = await current
            .evaluate((reportWant) => {
                for (const el of document.querySelectorAll('span, a, .rtIn')) {
                    const t = (el.textContent || '').trim().toLowerCase();
                    if (t.includes(reportWant)) return true;
                }
                return false;
            }, want)
            .catch(() => false);
        if (found) return current;
        if (snap.hasSearch && snap.spanCount > 80) return current;
        await page.waitForTimeout(1500);
    }

    return findReportTreeFrame(page) || frame;
}

async function expandTreeFolder(frame, folderName) {
    const ok = await frame.evaluate((name) => {
        const want = String(name).trim().toLowerCase();
        for (const el of document.querySelectorAll('.rtIn, .rtOut, .rtMid')) {
            const t = (el.textContent || '').trim().toLowerCase();
            if (t !== want) continue;
            const row = el.closest('.rtLI, li');
            const plus = row && row.querySelector('.rtPlus');
            if (plus) {
                plus.click();
                return true;
            }
            return false;
        }
        return false;
    }, folderName);
    if (!ok) {
        log.warn(`[Upselling] Tree folder not found: ${folderName}`);
    }
    return ok;
}

async function searchReportInTree(frame, reportName, page) {
    const typed = await frame.evaluate((q) => {
        const input = document.querySelector('input[type="text"]');
        if (!input) return false;
        input.focus();
        input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        return true;
    }, reportName);
    if (!typed) return null;
    await page.waitForTimeout(2000);
    return openReportInTree(frame, reportName);
}

/**
 * Open a report leaf by partial name (e.g. "Upsell by Cashier" matches "! NEW" suffix).
 */
async function openReportInTree(frame, reportName) {
    const want = String(reportName).trim().toLowerCase();
    const clicked = await frame.evaluate((reportWant) => {
        const nodes = [...document.querySelectorAll('.rtIn, .rtOut, .rtMid, span, a')];
        const matches = nodes
            .filter((el) => {
                const t = (el.textContent || '').trim().toLowerCase();
                if (!t || t.length > 80) return false;
                if (/^reports\d/i.test(t)) return false;
                return t.includes(reportWant);
            })
            .sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);

        for (const el of matches) {
            const t = (el.textContent || '').trim().toLowerCase();
            if (t === reportWant || t.startsWith(reportWant)) {
                el.click();
                return (el.textContent || '').trim();
            }
        }
        if (matches[0]) {
            matches[0].click();
            return (matches[0].textContent || '').trim();
        }
        return null;
    }, want);

    if (!clicked) {
        throw new Error(`Could not open BI report "${reportName}" in Report Portal tree`);
    }
    return clicked;
}

function resolveBiReportUrl(cfg) {
    const url = String(cfg.biReportUrl || '').trim();
    if (url && !url.includes('REPLACE')) return url;
    return '';
}

function resolveBiEntryUrl(cfg) {
    const url = String(cfg.biEntryUrl || '').trim();
    if (url && !url.includes('REPLACE')) return url;
    return DEFAULT_BI_ENTRY_URL;
}

function pageShowsCookieError(page) {
    return page
        .evaluate(() =>
            /reportid or reporttype is not supplied in cookie/i.test(document.body?.innerText || '')
        )
        .catch(() => false);
}

/**
 * Report Portal stores reportId/reportType in cookies only after the BI portal page loads.
 * Opening Proxy.aspx?reportId=… without this step shows the cookie error.
 */
async function establishReportPortalSession(page, cfg) {
    const navTimeout = Number(cfg.navTimeoutMs) || 60000;
    const portalUrl = resolveBiEntryUrl(cfg);
    const navOpts = { ...GOTO_OPTS, waitUntil: 'domcontentloaded', timeout: navTimeout };

    log.info(`[Upselling] BI portal (session cookie): ${portalUrl}`);
    await page.goto(portalUrl, navOpts);

    const sessionTimeout = Math.min(Number(cfg.treeReadyTimeoutMs) || 45000, 60000);
    const start = Date.now();
    while (Date.now() - start < sessionTimeout) {
        if (await pageShowsCookieError(page)) {
            await page.waitForTimeout(1000);
            continue;
        }
        const readyFrame = page.frames().find((f) =>
            /reportTree\.aspx|viewFrame\.aspx|ReportPortal5\/design/i.test(String(f.url() || ''))
        );
        if (readyFrame) {
            log.info('[Upselling] Report Portal session ready');
            await page.waitForTimeout(1500);
            return;
        }
        await page.waitForTimeout(1000);
    }
    log.warn('[Upselling] Portal session wait timed out — continuing to report URL');
}

/** Portal warmup, then Proxy.aspx?reportId=… (no folder tree). */
async function navigateToDirectBiReport(page, cfg) {
    const navTimeout = Number(cfg.navTimeoutMs) || 60000;
    const reportUrl = resolveBiReportUrl(cfg) || DEFAULT_BI_REPORT_URL;
    const navOpts = { ...GOTO_OPTS, waitUntil: 'domcontentloaded', timeout: navTimeout };

    await establishReportPortalSession(page, cfg);

    log.info(`[Upselling] BI report (direct): ${reportUrl}`);
    await page.goto(reportUrl, navOpts);
    await page.waitForTimeout(2500);

    if (await pageShowsCookieError(page)) {
        log.warn('[Upselling] Cookie error after direct URL — retrying via portal');
        await establishReportPortalSession(page, cfg);
        await page.goto(reportUrl, navOpts);
        await page.waitForTimeout(2500);
    }

    if (await pageShowsCookieError(page)) {
        throw new Error(
            'Report Portal cookie missing (ReportId/ReportType). Open Business Intelligence in Macromatix once in this browser, or use biFolderPath tree navigation.'
        );
    }

    return { opened: reportUrl, mode: 'direct' };
}

/**
 * Navigate via tree: portal → expand VIC → Ash → Upsell by Cashier.
 */
async function navigateViaReportTree(page, cfg) {
    const navTimeout = Number(cfg.navTimeoutMs) || 60000;
    const entryUrl = resolveBiEntryUrl(cfg);

    log.info(`[Upselling] BI portal (tree): ${entryUrl}`);
    await page.goto(entryUrl, { ...GOTO_OPTS, timeout: navTimeout });
    await page.waitForTimeout(3000);

    const treeTimeout = Number(cfg.treeReadyTimeoutMs) || 60000;
    let treeFrame = await waitForReportTreeFrame(page, treeTimeout);

    treeFrame = await waitForTreeLabels(
        page,
        treeFrame,
        cfg.reportName || 'Upsell by Cashier',
        treeTimeout
    );

    for (const folder of cfg.biFolderPath || []) {
        await expandTreeFolder(treeFrame, folder);
        await page.waitForTimeout(800);
    }

    const reportName = cfg.reportName || 'Upsell by Cashier';
    let opened = null;
    try {
        opened = await openReportInTree(treeFrame, reportName);
    } catch (err) {
        log.warn(`[Upselling] Folder path open failed (${err.message}); trying tree search`);
        opened = await searchReportInTree(treeFrame, reportName, page);
        if (!opened) throw err;
    }

    log.info(`[Upselling] Opened BI report: ${opened}`);
    await page.waitForTimeout(4000);

    return { treeFrame, opened, mode: 'tree' };
}

/**
 * Navigate to BI report — uses biReportUrl when set, otherwise folder tree.
 */
async function navigateToBiReport(page, cfg) {
    if (resolveBiReportUrl(cfg)) {
        return navigateToDirectBiReport(page, cfg);
    }
    return navigateViaReportTree(page, cfg);
}

module.exports = {
    DEFAULT_BI_ENTRY_URL,
    DEFAULT_BI_REPORT_URL,
    resolveBiReportUrl,
    establishReportPortalSession,
    navigateToDirectBiReport,
    navigateViaReportTree,
    findReportTreeFrame,
    waitForReportTreeFrame,
    waitForTreeLabels,
    expandTreeFolder,
    searchReportInTree,
    openReportInTree,
    navigateToBiReport,
};
