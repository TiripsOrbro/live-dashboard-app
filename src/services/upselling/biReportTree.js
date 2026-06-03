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

async function findBestTreeFrame(page) {
    let best = { frame: findReportTreeFrame(page), names: [], score: 0 };
    for (const frame of page.frames()) {
        const names = await listTreeFolderNames(frame);
        let score = names.length;
        if (names.some((n) => /vic/i.test(n))) score += 50;
        if (names.some((n) => /upsell/i.test(n))) score += 80;
        if (names.some((n) => /^reports/i.test(n))) score += 20;
        if (score > best.score) {
            best = { frame, names, score };
        }
    }
    return best;
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
        'Report Portal tree did not load after opening Business Intelligence in the sidebar.'
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

async function getTreeContexts(page) {
    const contexts = [];
    const seen = new Set();
    for (const frame of page.frames()) {
        const key = String(frame.url() || frame.name() || contexts.length);
        if (seen.has(key)) continue;
        seen.add(key);
        contexts.push({ name: key.slice(-80), ctx: frame });
    }
    return contexts;
}

async function expandTreeFolderAnywhere(page, folderName) {
    for (const { name, ctx } of await getTreeContexts(page)) {
        const ok = await expandTreeFolder(ctx, folderName, { quiet: true });
        if (ok) {
            log.info(`[Upselling] Expanded ${folderName} (${name})`);
            return true;
        }
    }
    const visible = await listTreeFolderNames((await findBestTreeFrame(page)).frame);
    log.warn(
        `[Upselling] Tree folder not found: ${folderName}` +
            (visible.length ? ` (visible: ${visible.slice(0, 8).join(', ')})` : '')
    );
    return false;
}

async function openReportInTreeAnywhere(page, reportName) {
    for (const { name, ctx } of await getTreeContexts(page)) {
        try {
            const opened = await openReportInTree(ctx, reportName);
            log.info(`[Upselling] Opened report in ${name}`);
            return opened;
        } catch (_) {
            /* try next frame */
        }
    }
    throw new Error(`Could not open BI report "${reportName}" in Report Portal tree`);
}

async function writeTreeDebug(page) {
    const debug = { frames: [] };
    for (const { name, ctx } of await getTreeContexts(page)) {
        const labels = await listTreeFolderNames(ctx);
        debug.frames.push({ name, labels, url: ctx.url?.() || '' });
    }
    try {
        const fs = require('fs');
        const path = require('path');
        const { upsellingRootDir } = require('./upsellingConfig');
        const dir = upsellingRootDir();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'tree-debug.json'), JSON.stringify(debug, null, 2), 'utf8');
        log.warn('[Upselling] Wrote data/upselling/tree-debug.json');
    } catch (_) {
        /* ignore */
    }
    return debug;
}

async function listTreeFolderNames(frame) {
    return frame
        .evaluate(() =>
            [...document.querySelectorAll('.rtIn, .rtOut, .rtMid, .rtSp, .rtTxt, [class*="rtIn"], [class*="rtOut"]')]
                .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
                .filter((t) => t.length > 0 && t.length < 50)
                .slice(0, 40)
        )
        .catch(() => []);
}

async function expandMmxSidebarSection(page, sectionName) {
    const expanded = await page.evaluate((name) => {
        const want = String(name).trim().toLowerCase();
        for (const el of document.querySelectorAll('.rpLink, .rpText, .rpbItem')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t !== want) continue;
            const row = el.closest('.rpbItem, li');
            const toggle = row?.querySelector('.rpExpandHandle');
            if (toggle) {
                toggle.click();
                return (el.textContent || '').trim();
            }
            return null;
        }
        return null;
    }, sectionName);
    if (expanded) {
        log.info(`[Upselling] Expanded sidebar: ${expanded}`);
    }
    return Boolean(expanded);
}

async function isSidebarLinkVisible(page, labelText) {
    return page.evaluate((label) => {
        const want = String(label).trim().toLowerCase();
        for (const el of document.querySelectorAll('a, span, li')) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            if (t !== want) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return true;
        }
        return false;
    }, labelText);
}

async function clickMmxSidebarLink(page, labelText, options = {}) {
    const hrefHints = options.hrefHints || [];
    const clicked = await page.evaluate(
        (label, hints) => {
            const want = String(label).trim().toLowerCase();
            function pick(el) {
                return (el.textContent || '').replace(/\s+/g, ' ').trim();
            }
            for (const a of document.querySelectorAll('a[href]')) {
                if (pick(a).toLowerCase() === want) {
                    a.click();
                    return pick(a);
                }
            }
            for (const a of document.querySelectorAll('a[href]')) {
                const href = a.getAttribute('href') || '';
                if (hints.some((h) => href.includes(h))) {
                    a.click();
                    return pick(a) || label;
                }
            }
            for (const el of document.querySelectorAll('a, span, li')) {
                if (pick(el).toLowerCase() === want) {
                    el.click();
                    return pick(el);
                }
            }
            return null;
        },
        labelText,
        hrefHints
    );
    return clicked;
}

/**
 * After login: Reports → Business Intelligence (sidebar), not a direct portal URL.
 */
async function navigateToBusinessIntelligence(page, cfg) {
    const menuLabel = String(cfg.biMenuLinkText || 'Business Intelligence').trim();
    const parentSection = String(cfg.biMenuParentText || 'Reports').trim();

    log.info(`[Upselling] Navigating sidebar: ${parentSection} → ${menuLabel}`);

    if (!(await isSidebarLinkVisible(page, menuLabel))) {
        await expandMmxSidebarSection(page, parentSection);
        await page.waitForTimeout(600);
    }

    const clicked = await clickMmxSidebarLink(page, menuLabel, {
        hrefHints: ['ReportPortal', 'MenuCustomItemID=227', 'BusinessIntelligence'],
    });
    if (!clicked) {
        throw new Error(
            `Could not find "${menuLabel}" under ${parentSection} in the Macromatix sidebar`
        );
    }
    log.info(`[Upselling] Opened: ${clicked}`);

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
}

async function expandTreeFolder(frame, folderName, options = {}) {
    const ok = await frame.evaluate((name) => {
        const want = String(name).trim().toLowerCase();
        function folderMatches(text) {
            const raw = String(text || '').trim();
            const t = raw
                .toLowerCase()
                .replace(/\s*\*?\s*\d+\s*$/, '')
                .replace(/\s+\*$/, '');
            if (want === 'reports') {
                return t === 'reports';
            }
            if (t === want) return true;
            if (t.startsWith(want) && t.length <= want.length + 8) return true;
            return false;
        }
        for (const el of document.querySelectorAll(
            '.rtIn, .rtOut, .rtMid, .rtTxt, [class*="rtIn"], [class*="rtOut"]'
        )) {
            const t = (el.textContent || '').trim();
            if (!folderMatches(t)) continue;
            const row = el.closest('.rtLI, li');
            const plus = row && row.querySelector('.rtPlus');
            if (plus) {
                plus.click();
                return (el.textContent || '').trim();
            }
            return (el.textContent || '').trim();
        }
        return null;
    }, folderName);
    if (!ok && !options.quiet) {
        const visible = await listTreeFolderNames(frame);
        log.warn(
            `[Upselling] Tree folder not found: ${folderName}` +
                (visible.length ? ` (visible: ${visible.slice(0, 12).join(', ')})` : '')
        );
        return false;
    }
    if (!ok) return false;
    log.info(`[Upselling] Expanded tree folder: ${ok}`);
    return true;
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
 * Sidebar → Business Intelligence. Report opens by default (no tree clicks unless biFolderPath set).
 */
async function navigateViaReportTree(page, cfg) {
    await navigateToBusinessIntelligence(page, cfg);

    const folderPath = (cfg.biFolderPath || []).map((f) => String(f || '').trim()).filter(Boolean);
    const reportName = cfg.reportName || 'Upsell by Cashier';

    if (folderPath.length) {
        const treeTimeout = Number(cfg.treeReadyTimeoutMs) || 60000;
        let { frame: treeFrame, names: treeNames } = await findBestTreeFrame(page);
        if (!treeFrame || !treeNames.length) {
            treeFrame = await waitForReportTreeFrame(page, treeTimeout);
            ({ frame: treeFrame, names: treeNames } = await findBestTreeFrame(page));
        }
        if (treeNames.length) {
            log.info(`[Upselling] Report tree sample: ${treeNames.slice(0, 8).join(', ')}`);
        }

        treeFrame = await waitForTreeLabels(page, treeFrame, reportName, treeTimeout);

        for (const folder of folderPath) {
            await expandTreeFolderAnywhere(page, folder);
            await page.waitForTimeout(800);
        }

        let opened = null;
        try {
            opened = await openReportInTreeAnywhere(page, reportName);
        } catch (err) {
            log.warn(`[Upselling] Folder path open failed (${err.message}); trying tree search`);
            const fallbackFrame = (await findBestTreeFrame(page)).frame || findReportTreeFrame(page);
            if (fallbackFrame) {
                opened = await searchReportInTree(fallbackFrame, reportName, page);
            }
            if (!opened) {
                await writeTreeDebug(page);
                throw err;
            }
        }
        log.info(`[Upselling] Opened BI report: ${opened}`);
    } else {
        log.info(`[Upselling] ${reportName} loads by default — waiting for report grid…`);
    }

    await waitForReportViewLoaded(page, cfg);
    return { opened: reportName, mode: folderPath.length ? 'tree' : 'sidebar-default' };
}

/** Wait until MdxView report finishes loading (no "Loading..." spinner). */
async function waitForReportViewLoaded(page, cfg = {}) {
    const timeoutMs = Number(cfg.reportReadyTimeoutMs) || 90000;
    const start = Date.now();
    log.info('[Upselling] Waiting for Upsell by Cashier report to finish loading…');

    while (Date.now() - start < timeoutMs) {
        let loading = false;
        let hasExport = false;
        for (const frame of page.frames()) {
            const state = await frame
                .evaluate(() => {
                    const body = document.body?.innerText || '';
                    const isLoading =
                        /\bloading\.{0,3}\b/i.test(body) &&
                        !document.querySelector('table tr td');
                    const exportBtn = document.querySelector('#tdShowExport');
                    const rows = document.querySelectorAll('table tr').length;
                    return {
                        isLoading,
                        hasExport: Boolean(exportBtn),
                        rows,
                        hasTitle: /upsell by cashier/i.test(body),
                    };
                })
                .catch(() => null);
            if (!state) continue;
            if (state.isLoading) loading = true;
            if (state.hasExport) hasExport = true;
            if (state.hasExport && state.rows >= 3 && !state.isLoading) {
                log.info('[Upselling] Report loaded');
                await page.waitForTimeout(1500);
                return true;
            }
        }
        if (!loading && hasExport) {
            log.info('[Upselling] Report toolbar ready');
            await page.waitForTimeout(1500);
            return true;
        }
        await page.waitForTimeout(1000);
    }
    log.warn('[Upselling] Report load wait timed out — continuing');
    return false;
}

/**
 * Navigate to BI report — sidebar Business Intelligence (report loads by default).
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
    navigateToBusinessIntelligence,
    searchReportInTree,
    openReportInTree,
    waitForReportViewLoaded,
    navigateToBiReport,
};
