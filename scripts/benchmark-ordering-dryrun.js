#!/usr/bin/env node
/**
 * Dry-run benchmark for the MMX ordering pipeline.
 *
 * Drives the REAL report-download orchestration (downloadBuildToReportsParallel) but
 * stubs the Macromatix-touching seams (browser open + the actual report download) with
 * a configurable simulated MMX latency. This lets us prove, without a live Macromatix
 * login or store:
 *   1. The three build-to reports download concurrently (wall time approximately the
 *      slowest single report, not the sum of all three).
 *   2. Our own orchestration overhead (locking, fs, promotion) is negligible - i.e. the
 *      only real wait is Macromatix generating the reports.
 *   3. The stage-timing instrumentation works.
 *
 * Usage:
 *   node scripts/benchmark-ordering-dryrun.js
 *   SIM_MMX_MS=1200 OVERHEAD_BUDGET_MS=600 node scripts/benchmark-ordering-dryrun.js
 *
 * Exit code 0 = all checks passed, 1 = a check failed.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');

// Simulated time Macromatix takes to "generate + deliver" one report.
const SIM_MMX_MS = Number(process.env.SIM_MMX_MS || 800);
// How much non-MMX overhead we tolerate on top of the slowest single report.
const OVERHEAD_BUDGET_MS = Number(process.env.OVERHEAD_BUDGET_MS || 750);
// How close to "1x slowest report" the parallel wall time must be to count as concurrent.
const CONCURRENCY_MAX_FACTOR = Number(process.env.CONCURRENCY_MAX_FACTOR || 1.8);

// Isolate report output to a throwaway dir so we never touch real Reports/.
const TMP_REPORTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mmx-dryrun-'));
process.env.VENDOR_REPORTS_DIR = TMP_REPORTS_DIR;
process.env.PROJECT_ROOT = REPO_ROOT;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pre-populate the require cache so a module resolves to our stub WITHOUT executing the real file. */
function stubModule(relPath, exports) {
    const resolved = require.resolve(path.join(REPO_ROOT, relPath));
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports,
    };
    return resolved;
}

// Track every simulated download so we can verify they overlapped in time.
const downloadCalls = [];

// Stub the browser seam: no real Puppeteer/Chrome, just a page that satisfies
// configureDownloadPath's CDP call (which our download stub does not even use).
stubModule('mmx/src/macromatixScraper.js', {
    openMacromatixBrowser: async () => ({
        browser: { close: async () => {} },
        page: {
            target: () => ({ createCDPSession: async () => ({ send: async () => {} }) }),
        },
    }),
    closeBrowserQuietly: async () => {},
    resolveStoreOnCurrentPage: async () => null,
});

// Stub the actual download: sleep the simulated MMX latency, then write a placeholder file.
stubModule('mmx/src/mmxReports/pipeline-download-reports.js', {
    configureDownloadPath: async () => {},
    normalizeMacromatixExportsForStore: () => ({}),
    downloadReports: async (page, settings) => {
        const reports = (settings.pipeline && settings.pipeline.reports) || [];
        const ids = reports.map((r) => r.id);
        const startedAt = Date.now();
        downloadCalls.push({ ids, startedAt, endedAt: null });
        const call = downloadCalls[downloadCalls.length - 1];

        await sleep(SIM_MMX_MS);

        const out = {};
        const dir = settings.reportDownloadDir;
        fs.mkdirSync(dir, { recursive: true });
        for (const report of reports) {
            const file = path.join(dir, `sim-${report.id}${report.downloadExt || '.csv'}`);
            fs.writeFileSync(file, 'simulated report');
            out[report.id] = file;
        }
        call.endedAt = Date.now();
        return out;
    },
});

// Now require the real downloader - it will capture our stubs.
const { downloadBuildToReportsParallel, parallelReportDownloadEnabled } = require(
    path.join(REPO_ROOT, 'mmx/src/mmxReportDownloader.js')
);
const { timeStage, formatTimings } = require(path.join(REPO_ROOT, 'mmx/src/mmxStageTimer.js'));

const results = [];
function check(name, passed, detail) {
    results.push({ name, passed: Boolean(passed), detail: detail || '' });
    const tag = passed ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${name}${detail ? ` - ${detail}` : ''}`);
}

function callsOverlapped() {
    // Concurrent if any two simulated downloads were in-flight at the same instant.
    for (let i = 0; i < downloadCalls.length; i++) {
        for (let j = i + 1; j < downloadCalls.length; j++) {
            const a = downloadCalls[i];
            const b = downloadCalls[j];
            if (a.startedAt < (b.endedAt || Infinity) && b.startedAt < (a.endedAt || Infinity)) {
                return true;
            }
        }
    }
    return false;
}

async function main() {
    console.log('MMX ordering pipeline - dry-run benchmark');
    console.log(
        `Simulated MMX latency per report: ${SIM_MMX_MS}ms | overhead budget: ${OVERHEAD_BUDGET_MS}ms\n`
    );

    // Check 1: concurrent download is the default policy after WS1.
    check(
        'parallel report download enabled by default',
        parallelReportDownloadEnabled({ onlyReportIds: ['report1', 'report2', 'report3'] }) === true,
        'parallelReportDownloadEnabled() returns true'
    );
    check(
        'parallel download still respects MMX_PARALLEL_BUILD_TO_REPORTS=0 opt-out',
        (() => {
            const prev = process.env.MMX_PARALLEL_BUILD_TO_REPORTS;
            process.env.MMX_PARALLEL_BUILD_TO_REPORTS = '0';
            const v = parallelReportDownloadEnabled({ onlyReportIds: ['report1', 'report2'] });
            if (prev === undefined) delete process.env.MMX_PARALLEL_BUILD_TO_REPORTS;
            else process.env.MMX_PARALLEL_BUILD_TO_REPORTS = prev;
            return v === false;
        })(),
        'env=0 forces sequential'
    );

    // Check 2: instrumentation records wall time.
    let recorded = null;
    await timeStage('self-test', () => sleep(120), (t) => {
        recorded = t.ms;
    });
    check(
        'stage timing instrumentation records duration',
        recorded !== null && recorded >= 100,
        `recorded ${recorded}ms for a ~120ms stage`
    );

    // Check 3: run the real parallel download of all three reports.
    const wallStart = Date.now();
    const out = await timeStage('download-reports (3 parallel)', () =>
        downloadBuildToReportsParallel('1', {
            onlyReportIds: ['report1', 'report2', 'report3'],
        })
    );
    const wallMs = Date.now() - wallStart;

    const producedAll = out && out.files && ['report1', 'report2', 'report3'].every((id) => out.files[id]);
    check('all three reports produced', producedAll, `files: ${Object.keys(out?.files || {}).join(', ')}`);

    check(
        'downloads overlapped in time (true concurrency)',
        callsOverlapped(),
        `${downloadCalls.length} download call(s) recorded`
    );

    const sequentialEstimateMs = SIM_MMX_MS * 3;
    check(
        'parallel wall time near a single report, not the sum',
        wallMs <= SIM_MMX_MS * CONCURRENCY_MAX_FACTOR,
        `wall ${wallMs}ms vs single ${SIM_MMX_MS}ms (sequential would be ~${sequentialEstimateMs}ms)`
    );

    const overheadMs = Math.max(0, wallMs - SIM_MMX_MS);
    check(
        'non-MMX orchestration overhead within budget',
        overheadMs <= OVERHEAD_BUDGET_MS,
        `overhead ${overheadMs}ms (budget ${OVERHEAD_BUDGET_MS}ms)`
    );

    // Timing table.
    console.log('\nTiming summary');
    console.log('  Stage                         Wall (ms)');
    console.log('  ----------------------------  ---------');
    console.log(`  3x report download (parallel)  ${String(wallMs).padStart(8)}`);
    console.log(`  -> if run sequentially (est.)  ${String(sequentialEstimateMs).padStart(8)}`);
    console.log(`  -> orchestration overhead      ${String(overheadMs).padStart(8)}`);
    const speedup = (sequentialEstimateMs / wallMs).toFixed(2);
    console.log(`\n  Speedup vs sequential: ~${speedup}x`);
    console.log(`  ${formatTimings([{ label: 'parallel-download', ms: wallMs }])}`);

    // Cleanup temp dir.
    try {
        fs.rmSync(TMP_REPORTS_DIR, { recursive: true, force: true });
    } catch {
        /* ignore */
    }

    const failed = results.filter((r) => !r.passed);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
        console.error(`FAILED: ${failed.map((f) => f.name).join('; ')}`);
        process.exit(1);
    }
    console.log('All dry-run checks passed.');
}

main().catch((err) => {
    console.error('Benchmark crashed:', err);
    try {
        fs.rmSync(TMP_REPORTS_DIR, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
    process.exit(1);
});
