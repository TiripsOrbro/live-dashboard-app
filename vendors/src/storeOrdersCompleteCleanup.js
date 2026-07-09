const fs = require('fs');
const path = require('path');
const { destroySessionsForStore } = require('../../mmx/src/mmxCountSession');
const paths = require('../../src/paths');
const { clearStoreReportFilesPreservingStockLevels } = require('./reportReader');
const REPORTS_DIR = paths.vendors.reports;
const TMP_DOWNLOADS_ROOT = path.join(paths.root, 'out', 'tmp-report-downloads');

function removeMatchingFiles(dir, pattern) {
    if (!dir || !fs.existsSync(dir)) return 0;
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
        const fp = path.join(dir, name);
        try {
            const stat = fs.statSync(fp);
            if (stat.isFile() && pattern.test(name)) {
                fs.unlinkSync(fp);
                removed++;
            }
        } catch {
            /* file may already be gone */
        }
    }
    return removed;
}

function deleteStoreReportFiles(storeNumber) {
    const { removed } = clearStoreReportFilesPreservingStockLevels(storeNumber, REPORTS_DIR);
    return removed.length;
}

function deleteTempReportDownloadDirs() {
    if (!fs.existsSync(TMP_DOWNLOADS_ROOT)) return 0;
    let removed = 0;
    for (const name of fs.readdirSync(TMP_DOWNLOADS_ROOT)) {
        const fp = path.join(TMP_DOWNLOADS_ROOT, name);
        try {
            if (fs.statSync(fp).isDirectory()) {
                fs.rmSync(fp, { recursive: true, force: true });
                removed++;
            }
        } catch {
            /* best effort */
        }
    }
    return removed;
}

/**
 * After confirmed empty scheduled orders for a store today: drop ISE and temp downloads,
 * keep SOH/SOO for stock-levels download, and clear any open MMX count browser session.
 */
async function runStoreOrdersCompleteCleanup(storeNumber, dateKey) {
    const label = String(storeNumber || '').trim() || '(default)';
    try {
        const { markStoreOrdersComplete } = require('./orderingDayState');
        markStoreOrdersComplete(storeNumber, dateKey, 'orders_pipeline');
    } catch (err) {
        console.warn(`[Macromatix] Store ${label} ordering day mark-complete failed:`, err.message);
    }
    const reportFiles = deleteStoreReportFiles(storeNumber);
    const tempDirs = deleteTempReportDownloadDirs();
    await destroySessionsForStore(storeNumber, 'orders-complete');

    const summary = {
        storeNumber: label,
        dateKey,
        reportFilesRemoved: reportFiles,
        tempDownloadDirsRemoved: tempDirs,
    };

    console.log(
        `[Macromatix] Store ${label} orders complete for ${dateKey} - cleanup: ` +
            `${reportFiles} report file(s), ${tempDirs} temp download folder(s), MMX count session cleared`
    );

    return summary;
}

module.exports = {
    runStoreOrdersCompleteCleanup,
    deleteStoreReportFiles,
    deleteTempReportDownloadDirs,
};
