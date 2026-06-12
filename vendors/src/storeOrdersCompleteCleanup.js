const fs = require('fs');
const path = require('path');
const { destroySessionsForStore } = require('../../mmx/src/mmxCountSession');
const paths = require('../../src/paths');
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
    const storeDir = path.join(REPORTS_DIR, String(storeNumber));
    return removeMatchingFiles(storeDir, /\.(csv|xls|xlsx)$/i);
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
 * After confirmed empty scheduled orders for a store today: drop downloaded reports,
 * temp download folders, and any open MMX count browser session for that store.
 */
async function runStoreOrdersCompleteCleanup(storeNumber, dateKey) {
    const label = String(storeNumber || '').trim() || '(default)';
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
        `[Macromatix] Store ${label} orders complete for ${dateKey} — cleanup: ` +
            `${reportFiles} report file(s), ${tempDirs} temp download folder(s), MMX count session cleared`
    );

    return summary;
}

module.exports = {
    runStoreOrdersCompleteCleanup,
    deleteStoreReportFiles,
    deleteTempReportDownloadDirs,
};
