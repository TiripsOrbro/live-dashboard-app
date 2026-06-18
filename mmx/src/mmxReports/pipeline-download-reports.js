const path = require('path');
const fs = require('fs');
const { GOTO_OPTS } = require('./mmx-browser');
const { withPageContextRetry } = require('./mmx-context-retry');
const { ensureDir, waitForNewDownload, timestampSlug } = require('./util-files');
const log = require('./util-logging');
const { navigateToSupplyChainReports } = require('./mmx-navigation');
const { refreshScrapePauseTimeout } = require('../mmxResourceGate');
const { runSupplyChainReport, isSupplyChainReport } = require('./pipeline-supply-chain-reports');
const { runStoreReport, isStoreReport } = require('./pipeline-store-reports');
const { filterSpreadsheetByStoreColumn, logIseSpotCheck } = require('../../../vendors/src/reportReader');

const DOWNLOAD_EXTS = ['.xls', '.xlsx', '.csv'];

function reportsConfigured(reports) {
    return (reports || []).every((r) => {
        if (isSupplyChainReport(r) || isStoreReport(r)) return Boolean(r.reportName);
        return r.url && !r.url.includes('REPLACE');
    });
}

function getReportDownloadDir(settings) {
    return settings.reportDownloadDir || settings.downloadDir;
}

async function configureDownloadPath(page, downloadDir) {
    ensureDir(downloadDir);
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
    });
}

async function clickExportExcelDataOnly(page, report = {}) {
    if (report.exportButtonSelector) {
        await page.waitForSelector(report.exportButtonSelector, { timeout: 30000 });
        await page.click(report.exportButtonSelector);
        await page.waitForTimeout(400);
    }

    if (report.exportLinkText) {
        const clicked = await page.evaluate((text) => {
            const want = String(text).toLowerCase();
            for (const el of document.querySelectorAll('a, button, input, span')) {
                const label = (el.textContent || el.value || '').trim().toLowerCase();
                if (label.includes(want) || label === want) {
                    el.click();
                    return true;
                }
            }
            return false;
        }, report.exportLinkText);
        if (!clicked) {
            log.warn(`Export link "${report.exportLinkText}" not found; trying generic Excel link`);
            await page.evaluate(() => {
                for (const el of document.querySelectorAll('a')) {
                    const t = (el.textContent || '').toLowerCase();
                    if (t.includes('excel') && (t.includes('data') || t.includes('only'))) {
                        el.click();
                        return;
                    }
                }
            });
        }
    }
}

async function scrapeReportPageDiagnostics(page) {
    try {
        return await page.evaluate(() => {
            const chunks = [];
            for (const el of document.querySelectorAll(
                '.rgErr, .error, .ValidationSummary, [id*="ErrorLabel"], [id*="lblError"]'
            )) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (t && t.length < 400) chunks.push(t);
            }
            const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
            const m = body.match(
                /(?:error|failed|unable to|no data|timed out)[^.]{0,180}\./gi
            );
            if (m) chunks.push(...m.slice(0, 3));
            return [...new Set(chunks)].slice(0, 4).join(' | ') || '';
        });
    } catch {
        return '';
    }
}

function buildDownloadDest(report, settings, downloaded) {
    const ext = path.extname(downloaded) || report.downloadExt || '.xls';
    const dir = getReportDownloadDir(settings);
    const slug = timestampSlug();
    const base = report.outputBasename || report.id || 'report';
    return path.join(dir, `${slug}-${base}${ext}`);
}

async function waitForReportDownload(downloadDir, timeoutMs, preferredExt, pollHooks = {}) {
    const order = preferredExt
        ? [preferredExt, ...DOWNLOAD_EXTS.filter((e) => e !== preferredExt)]
        : DOWNLOAD_EXTS;
    let lastError = null;
    for (let i = 0; i < order.length; i++) {
        const ext = order[i];
        const attemptMs = i === 0 ? timeoutMs : Math.min(8000, Math.floor(timeoutMs / 8));
        try {
            return await waitForNewDownload(downloadDir, {
                timeoutMs: attemptMs,
                ext,
                touchEveryMs: Number(process.env.MMX_DOWNLOAD_EXPORT_RETRY_MS || 30000),
                onPoll: async () => {
                    refreshScrapePauseTimeout();
                    if (typeof pollHooks.onPoll === 'function') {
                        await pollHooks.onPoll();
                    }
                },
            });
        } catch (e) {
            lastError = e;
            if (i === order.length - 1) break;
        }
    }
    throw lastError || new Error('No download received');
}

async function downloadSupplyChainReport(page, report, settings) {
    const scope = report.scmTreeStoreNumber
        ? ` (tree checkbox: ${report.scmTreeStoreNumber})`
        : report.skipStoreSelection
          ? ' (no store tree; split/filter after download)'
          : '';
    log.info(`Downloading: ${report.label || report.id} (${report.reportName})${scope}`);
    await runSupplyChainReport(page, report, settings);

    if (typeof settings.onReportStep === 'function') {
        const reportLabel = report.label || report.reportName || report.id || 'report';
        await settings.onReportStep(`${reportLabel}: waiting for file download…`);
    }

    const downloadWaitMs = Number(report.downloadWaitMs || settings.downloadWaitMs);
    let exportLinkAttempts = 0;
    const downloaded = await waitForReportDownload(
        getReportDownloadDir(settings),
        downloadWaitMs,
        report.downloadExt,
        {
            onPoll: async () => {
                exportLinkAttempts++;
                if (exportLinkAttempts % 2 !== 0) return;
                const clicked = await page.evaluate(() => {
                    for (const el of document.querySelectorAll('a, button, input')) {
                        const t = (el.textContent || el.value || '').trim().toLowerCase();
                        if (
                            (t.includes('excel') && (t.includes('data') || t.includes('only'))) ||
                            t === 'export' ||
                            t.includes('download')
                        ) {
                            el.click();
                            return t;
                        }
                    }
                    return null;
                });
                if (clicked) {
                    log.info(`${report.label || report.id}: clicked export link "${clicked}" while waiting for download`);
                }
            },
        }
    ).catch(async (err) => {
        const diag = await scrapeReportPageDiagnostics(page);
        const url = page.url();
        if (diag) {
            log.warn(`${report.label || report.id}: page diagnostics after timeout: ${diag}`);
        }
        log.warn(`${report.label || report.id}: page URL at timeout: ${url}`);
        const hint = diag ? ` Macromatix page: ${diag}` : '';
        throw new Error(`${err.message}.${hint}`);
    });
    const dest = buildDownloadDest(report, settings, downloaded);
    if (downloaded !== dest) {
        fs.renameSync(downloaded, dest);
    }

    if (report.storeNumber && (report.id === 'report1' || report.id === 'report2')) {
        const filterResult = filterSpreadsheetByStoreColumn(dest, report.storeNumber, 2);
        if (filterResult.skipped) {
            log.warn(`${report.label || report.id}: no rows for store ${report.storeNumber} in ${path.basename(dest)}`);
        } else if (filterResult.removed) {
            log.info(
                `${report.label || report.id} filtered to store ${report.storeNumber}: ${filterResult.kept} row(s) kept, ${filterResult.removed} removed`
            );
        }
    }

    log.info(`Saved ${report.id} → ${path.basename(dest)}`);
    if (typeof settings.onReportStep === 'function') {
        const reportLabel = report.label || report.reportName || report.id || 'report';
        await settings.onReportStep(`Downloaded ${reportLabel} → ${path.basename(dest)}`);
    }
    if (settings.chainSession) {
        settings.chainSession.hubOpen = false;
    }
    refreshScrapePauseTimeout();
    return dest;
}

async function downloadStoreReport(page, report, settings) {
    log.info(`Downloading: ${report.label || report.id} (${report.reportName})`);
    await runStoreReport(page, report, settings);

    const downloaded = await waitForReportDownload(
        getReportDownloadDir(settings),
        settings.downloadWaitMs,
        report.downloadExt || '.csv'
    );
    const dest = buildDownloadDest(report, settings, downloaded);
    if (downloaded !== dest) {
        fs.renameSync(downloaded, dest);
    }
    log.info(`Saved ${report.id} → ${path.basename(dest)}`);
    if (report.id === 'report3' && report.storeNumber) {
        logIseSpotCheck(dest, ['37876', '37909', '37609'], (msg) => log.info(msg));
    }
    if (typeof settings.onReportStep === 'function') {
        const reportLabel = report.label || report.reportName || report.id || 'report';
        await settings.onReportStep(`Downloaded ${reportLabel} → ${path.basename(dest)}`);
    }
    refreshScrapePauseTimeout();
    return dest;
}

async function openReportsHub(page, settings) {
    const reportNav = settings.pipeline.reportNavigation;
    if (!reportNav) {
        throw new Error('Missing reportNavigation in config/reports-pipeline.json');
    }
    await navigateToSupplyChainReports(page, reportNav, settings.navTimeoutMs);
}

function chainReportsEnabled(settings) {
    if (settings?.chainReports === false) return false;
    return process.env.MMX_CHAIN_REPORT_DOWNLOAD !== '0';
}

async function downloadReports(page, settings) {
    const reports = settings.pipeline.reports || [];
    const paths = {};

    if (!reports.length) {
        throw new Error('No reports configured in config/reports-pipeline.json');
    }

    if (!reportsConfigured(reports)) {
        log.warn('Reports not fully configured - opening Report Selection only');
        await openReportsHub(page, settings);
        return paths;
    }

    await configureDownloadPath(page, getReportDownloadDir(settings));

    if (chainReportsEnabled(settings) && !settings.chainSession) {
        settings.chainSession = {
            hubOpen: false,
            lastGroup: null,
            lastFormat: null,
            lastStartDate: null,
            lastEndDate: null,
        };
    }

    const failures = [];

    for (const report of reports) {
        if (report.skip) continue;

        try {
            if (typeof settings.onReportStep === 'function') {
                const reportLabel = report.label || report.reportName || report.id || 'report';
                const mmxName = report.reportName ? ` (${report.reportName})` : '';
                await settings.onReportStep(`Downloading ${reportLabel}${mmxName}…`);
            }
            if (isSupplyChainReport(report)) {
                paths[report.id] = await downloadSupplyChainReport(page, report, settings);
                refreshScrapePauseTimeout();
                continue;
            }

            if (isStoreReport(report)) {
                paths[report.id] = await downloadStoreReport(page, report, settings);
                refreshScrapePauseTimeout();
                continue;
            }

            if (!report.url || report.url.includes('REPLACE')) {
                throw new Error(`Report "${report.id || report.label}" URL not configured`);
            }

            log.info(`Downloading: ${report.label || report.id}`);
            await page.goto(report.url, { ...GOTO_OPTS, timeout: settings.navTimeoutMs });
            if (report.waitAfterNavigateMs) {
                await page.waitForTimeout(report.waitAfterNavigateMs);
            }

            await withPageContextRetry(page, `export ${report.id}`, async () => {
                await clickExportExcelDataOnly(page, report);
            });

            const downloaded = await waitForReportDownload(getReportDownloadDir(settings), settings.downloadWaitMs);
            const dest = buildDownloadDest(report, settings, downloaded);
            if (downloaded !== dest) {
                fs.renameSync(downloaded, dest);
            }
            paths[report.id] = dest;
            log.info(`Saved ${report.id} → ${path.basename(dest)}`);
        } catch (err) {
            failures.push({ id: report.id, label: report.label || report.id, error: err.message });
            log.error(`Report ${report.id} (${report.label || report.id}) failed: ${err.message}`);
        }
    }

    if (failures.length) {
        const summary = failures.map((f) => `${f.id}: ${f.error}`).join('; ');
        log.warn(`Reports incomplete (${Object.keys(paths).length} saved): ${summary}`);
    }

    return paths;
}

module.exports = {
    downloadReports,
    openReportsHub,
    reportsConfigured,
    configureDownloadPath,
    clickExportExcelDataOnly,
    waitForReportDownload,
};
