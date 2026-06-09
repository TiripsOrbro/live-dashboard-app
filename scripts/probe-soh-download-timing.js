#!/usr/bin/env node
/**
 * Time Stock On Hand (report1) download including SCM tree + file save.
 *
 * Usage:
 *   node scripts/probe-soh-download-timing.js 3811
 *   node scripts/probe-soh-download-timing.js 3811 --runs 3
 *   node scripts/probe-soh-download-timing.js 3811 --tree-only
 */
const path = require('path');
require('../src/loadEnv').loadEnv();

const { openMacromatixBrowser, closeBrowserQuietly } = require('../src/services/macromatixScraper');
const { loadPipelineConfig, REPORTS_DIR } = require('../src/services/mmxReportDownloader');
const { getStoreConfig } = require('../src/services/storeList');
const { downloadReports, configureDownloadPath } = require('../src/services/mmxReports/pipeline-download-reports');
const {
    openReportSelectionPage,
    setGroupDropdown,
    selectReportInList,
    setReportFormat,
    setStartDate,
    selectScmStoreCheckboxInTree,
    clickGenerate,
} = require('../src/services/mmxReports/pipeline-supply-chain-reports');
const { resolveReportDate } = require('../src/services/mmxReports/util-dates');
const { waitForNewDownload } = require('../src/services/mmxReports/util-files');
const { ensureDir, timestampSlug } = require('../src/services/mmxReports/util-files');
const fs = require('fs');

function parseArgs(argv) {
    const args = argv.slice(2);
    let storeNumber = '';
    let runs = 1;
    let treeOnly = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--runs' && args[i + 1]) {
            runs = Math.max(1, Number(args[i + 1]) || 1);
            i++;
        } else if (args[i] === '--tree-only') treeOnly = true;
        else if (/^\d{4}$/.test(args[i])) storeNumber = args[i];
    }
    return { storeNumber, runs, treeOnly };
}

function msSince(t0) {
    return `${((Date.now() - t0) / 1000).toFixed(1)}s`;
}

async function timeTreeAndGenerate(page, report, nav, storeNumber, storeName) {
    const steps = [];
    const mark = (label) => steps.push({ label, at: Date.now() });
    const t0 = Date.now();
    mark('start');

    await openReportSelectionPage(page, nav, 45000);
    mark('report page open');

    await setGroupDropdown(page, report.group || 'Supply Chain');
    mark('group set');

    await selectReportInList(page, report.reportName);
    mark('report selected');

    await setReportFormat(page, report.format || 'Excel Data Only');
    mark('format set');

    const startDate = resolveReportDate(report.startDate || 'tomorrow', {
        timeZone: report.timeZone,
        dateOnly: Boolean(report.dateOnly),
    });
    await setStartDate(page, startDate);
    mark('start date set');

    await selectScmStoreCheckboxInTree(page, storeNumber, storeName, { skipDateWait: true });
    mark('store tree checked');

    await clickGenerate(page, report.generateButtonText || 'Generate');
    mark('generate clicked');

    const deltas = [];
    for (let i = 1; i < steps.length; i++) {
        deltas.push({
            step: steps[i].label,
            sec: ((steps[i].at - steps[i - 1].at) / 1000).toFixed(1),
        });
    }
    return { totalSec: ((Date.now() - t0) / 1000).toFixed(1), deltas, tGenerate: Date.now() };
}

async function runOnce(storeNumber, treeOnly) {
    const cfg = getStoreConfig(storeNumber);
    const storeName = cfg ? `${storeNumber} ${cfg.storeName}` : storeNumber;
    const pipeline = loadPipelineConfig();
    const report = pipeline.reports.find((r) => r.id === 'report1');
    const nav = pipeline.reportNavigation;
    if (!report) throw new Error('report1 missing from config/reports-pipeline.json');

    const storeDir = path.join(REPORTS_DIR, storeNumber);
    ensureDir(storeDir);

    let browser;
    let page;
    const runT0 = Date.now();
    try {
        ({ browser, page } = await openMacromatixBrowser({ headless: process.env.SCRAPER_HEADLESS !== 'false' }));
        await configureDownloadPath(page, storeDir);

        if (treeOnly) {
            const timing = await timeTreeAndGenerate(page, report, nav, storeNumber, storeName);
            console.log(`\n[run] tree+generate total ${timing.totalSec}s`);
            for (const d of timing.deltas) console.log(`  +${d.sec}s  ${d.step}`);
            return { ok: true, mode: 'tree-only', ...timing };
        }

        const steps = [];
        const onReportStep = async (label) => {
            steps.push({ label, at: Date.now() });
            console.log(`  · ${label}`);
        };

        const storePipeline = {
            reportNavigation: nav,
            reports: [
                {
                    ...report,
                    storeNumber,
                    storeName,
                    scmTreeStoreNumber: storeNumber,
                    skipStoreSelection: false,
                    outputBasename: 'stock-on-hand',
                },
            ],
        };
        const settings = {
            navTimeoutMs: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
            downloadWaitMs: Number(process.env.MMX_DOWNLOAD_WAIT_MS || 120000),
            reportDownloadDir: storeDir,
            pipeline: storePipeline,
            onReportStep,
        };

        const tDl = Date.now();
        const paths = await downloadReports(page, settings);
        const file = paths.report1;
        const elapsed = ((Date.now() - runT0) / 1000).toFixed(1);
        const downloadSec = ((Date.now() - tDl) / 1000).toFixed(1);

        if (!file || !fs.existsSync(file)) {
            throw new Error('report1 path missing after download');
        }
        const stat = fs.statSync(file);
        console.log(`\n[run] OK in ${elapsed}s (downloadReports ${downloadSec}s) → ${path.basename(file)} (${stat.size} bytes)`);
        return { ok: true, elapsed, file, size: stat.size, steps };
    } finally {
        await closeBrowserQuietly(browser, 'probe-soh');
    }
}

async function main() {
    const { storeNumber, runs, treeOnly } = parseArgs(process.argv);
    if (!storeNumber) {
        console.error('Usage: node scripts/probe-soh-download-timing.js <store> [--runs N] [--tree-only]');
        process.exit(1);
    }

    console.log(`[probe-soh] store ${storeNumber}, runs=${runs}, mode=${treeOnly ? 'tree-only' : 'full SOH'}`);
    const results = [];
    for (let i = 1; i <= runs; i++) {
        console.log(`\n========== Run ${i}/${runs} ==========`);
        try {
            const r = await runOnce(storeNumber, treeOnly);
            results.push(r);
        } catch (err) {
            console.error(`[run ${i}] FAILED:`, err.message);
            results.push({ ok: false, error: err.message });
        }
    }

    const ok = results.filter((r) => r.ok);
    const fail = results.filter((r) => !r.ok);
    console.log(`\n========== Summary ==========`);
    console.log(`Passed: ${ok.length}/${runs}`);
    if (fail.length) {
        for (const f of fail) console.log(`  FAIL: ${f.error}`);
    }
    if (ok.length && ok[0].deltas) {
        const keys = ok[0].deltas.map((d) => d.step);
        console.log('\nAverage step times (tree-only runs):');
        for (const key of keys) {
            const vals = ok
                .filter((r) => r.deltas)
                .map((r) => Number(r.deltas.find((d) => d.step === key)?.sec || 0));
            const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
            console.log(`  ${key}: ${avg.toFixed(1)}s avg`);
        }
    }
    if (ok.length && ok[0].elapsed) {
        const times = ok.map((r) => Number(r.elapsed));
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        console.log(`Full download avg: ${avg.toFixed(1)}s`);
    }

    process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
    console.error('[probe-soh]', e.message);
    process.exit(1);
});
