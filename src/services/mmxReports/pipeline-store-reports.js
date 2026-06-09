const { withPageContextRetry } = require('./mmx-context-retry');
const { resolveReportDate } = require('./util-dates');
const {
    openReportSelectionPage,
    setGroupDropdown,
    selectReportInList,
    setReportFormat,
    setStartDate,
    selectStoreForStoreReport,
    clickGenerate,
} = require('./pipeline-supply-chain-reports');

function dateOpts(report) {
    return { timeZone: report.timeZone, dateOnly: Boolean(report.dateOnly) };
}

async function triggerStoreSelectionReload(page) {
    // MMX sometimes requires focus to leave the store combo to trigger postback/reload.
    await page.evaluate(() => {
        try {
            if (document.activeElement && typeof document.activeElement.blur === 'function') {
                document.activeElement.blur();
            }
        } catch (e) {
            /* ignore */
        }
        const clickTarget =
            document.querySelector('#ctl00_ph_UpdatePanel1') ||
            document.querySelector('form') ||
            document.body;
        clickTarget?.click();
    });
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 25000 }).catch(() => {});

    // Force a full refresh so the selected store context is fully committed.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(Number(process.env.MMX_STORE_REPORT_POST_STORE_SETTLE_MS || 3500));
}

async function configureAndGenerateStoreReport(page, report, reportNav) {
    await openReportSelectionPage(page, reportNav, report.navTimeoutMs || 45000);
    await setGroupDropdown(page, report.group || 'Store Reports');
    await selectReportInList(page, report.reportName, { loose: true });
    await page.waitForTimeout(2000);

    if (report.storeName) {
        await selectStoreForStoreReport(page, report.storeName, {
            storeNumber: report.storeNumber,
            waitMs: 1500,
            optional: false,
        });
        await triggerStoreSelectionReload(page);
    }

    // After store-triggered reload settles, apply date first.
    const startDate = resolveReportDate(report.startDate || 'yesterday', dateOpts(report));
    await setStartDate(page, startDate);
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(Number(process.env.MMX_STORE_REPORT_POST_DATE_SETTLE_MS || 600));

    // Finally set report format/type so all report controls are in final state before generate.
    await setReportFormat(page, report.format || 'CSV');
    await page.waitForTimeout(Number(process.env.MMX_STORE_REPORT_POST_FORMAT_MS || 350));

    await clickGenerate(page, report.generateButtonText || 'Generate');
}

async function runStoreReport(page, report, settings) {
    const reportNav = settings.pipeline.reportNavigation;
    if (!reportNav?.url) {
        throw new Error('pipeline.reportNavigation.url is required');
    }

    const cfg = {
        ...report,
        navTimeoutMs: settings.navTimeoutMs,
    };

    await withPageContextRetry(page, `store report ${report.id}`, async () => {
        await configureAndGenerateStoreReport(page, cfg, reportNav);
    });
}

function isStoreReport(report) {
    return report.type === 'storeReports';
}

module.exports = {
    configureAndGenerateStoreReport,
    runStoreReport,
    isStoreReport,
};
