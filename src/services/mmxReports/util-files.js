const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function copyFileSafe(src, dest) {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
}

function timestampSlug() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function listFiles(dir, ext = '.xlsx') {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(ext))
        .map((f) => path.join(dir, f));
}

/**
 * Wait until a new file matching ext appears in dir (or size stabilizes).
 */
async function waitForNewDownload(dir, opts = {}) {
    const ext = opts.ext || '.xlsx';
    const timeoutMs = opts.timeoutMs || 120000;
    const pollMs = opts.pollMs || 500;
    const before = new Set(listFiles(dir, ext));
    const start = Date.now();
    const touchEveryMs = Number(opts.touchEveryMs || 0);
    let lastTouch = start;

    while (Date.now() - start < timeoutMs) {
        if (touchEveryMs > 0 && typeof opts.onPoll === 'function' && Date.now() - lastTouch >= touchEveryMs) {
            try {
                opts.onPoll();
            } catch {
                /* ignore */
            }
            lastTouch = Date.now();
        }
        const now = listFiles(dir, ext);
        for (const f of now) {
            if (!before.has(f)) {
                const stat1 = fs.statSync(f);
                if (stat1.size === 0) {
                    await sleep(pollMs);
                    continue;
                }
                await sleep(pollMs);
                const stat2 = fs.statSync(f);
                if (stat2.size === stat1.size && stat2.size > 0) {
                    return f;
                }
            }
        }
        await sleep(pollMs);
    }
    throw new Error(`Timed out waiting for download in ${dir} (${timeoutMs}ms)`);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function archiveFile(filePath, archiveDir) {
    ensureDir(archiveDir);
    const base = path.basename(filePath);
    const dest = path.join(archiveDir, `${timestampSlug()}-${base}`);
    fs.renameSync(filePath, dest);
    return dest;
}

const CHROME_PROFILE_LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

/** Remove stale Chromium lock files (e.g. after crash, scp copy, or interrupted login). */
/** Ephemeral folder for Macromatix report downloads (removed after merge). */
function createReportDownloadDir(workDir) {
    const dir = path.join(workDir, 'out', 'tmp-report-downloads', timestampSlug());
    ensureDir(dir);
    return dir;
}

/** Delete downloaded report files and optionally remove the whole temp download directory. */
function cleanupReportDownloads(reportPaths, downloadDir) {
    let removed = 0;
    for (const p of Object.values(reportPaths || {})) {
        try {
            if (p && fs.existsSync(p)) {
                fs.unlinkSync(p);
                removed++;
            }
        } catch (e) {
            // File may already be gone or locked briefly during browser shutdown.
        }
    }
    if (downloadDir && fs.existsSync(downloadDir)) {
        try {
            fs.rmSync(downloadDir, { recursive: true, force: true });
        } catch (e) {
            // Best effort — individual files were already unlinked.
        }
    }
    return removed;
}

function clearChromeProfileSingletonLocks(userDataDir) {
    if (!userDataDir) return [];
    const removed = [];
    for (const name of CHROME_PROFILE_LOCK_FILES) {
        const lockPath = path.join(userDataDir, name);
        try {
            if (fs.existsSync(lockPath)) {
                fs.unlinkSync(lockPath);
                removed.push(name);
            }
        } catch {
            /* profile may be in use by another live Chromium */
        }
    }
    return removed;
}

module.exports = {
    ensureDir,
    copyFileSafe,
    timestampSlug,
    listFiles,
    waitForNewDownload,
    sleep,
    archiveFile,
    clearChromeProfileSingletonLocks,
    createReportDownloadDir,
    cleanupReportDownloads,
};
