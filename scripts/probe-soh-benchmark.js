#!/usr/bin/env node
/**
 * Concurrent SOH / build-to report timing benchmark.
 *
 * Usage:
 *   node scripts/probe-soh-benchmark.js 3811
 *   node scripts/probe-soh-benchmark.js 3811 --workers 3 --runs 6
 *   node scripts/probe-soh-benchmark.js 3811 --workers 2 --runs 4 --all-reports
 */
const path = require('path');
const fs = require('fs');
require('../src/loadEnv').loadEnv();

const { openMacromatixBrowser, closeBrowserQuietly } = require('../src/services/macromatixScraper');
const { loadPipelineConfig, REPORTS_DIR } = require('../src/services/mmxReportDownloader');
const { getStoreConfig } = require('../src/services/storeList');
const { downloadReports, configureDownloadPath } = require('../src/services/mmxReports/pipeline-download-reports');
const { isSupplyChainReport } = require('../src/services/mmxReports/pipeline-supply-chain-reports');
const { ensureDir } = require('../src/services/mmxReports/util-files');

function reportsForStore(pipeline, store) {
    const label =
        store.storeNumber && store.storeName
            ? `${store.storeNumber} ${store.storeName}`
            : store.storeName || store.storeNumber;
    return (pipeline.reports || []).map((report) => {
        const scm = isSupplyChainReport(report);
        return {
            ...report,
            storeNumber: store.storeNumber,
            storeName: label,
            scmTreeStoreNumber: scm ? store.storeNumber : undefined,
            skipStoreSelection: !scm,
            outputBasename:
                report.outputBasename ||
                { report1: 'stock-on-hand', report2: 'stock-on-order', report3: 'inventory-special-event' }[
                    report.id
                ] ||
                report.id,
        };
    });
}

function parseArgs(argv) {
    const args = argv.slice(2);
    let storeNumber = '';
    let workers = 2;
    let runs = 4;
    let allReports = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--workers' && args[i + 1]) {
            workers = Math.max(1, Number(args[i + 1]) || 2);
            i++;
        } else if (args[i] === '--runs' && args[i + 1]) {
            runs = Math.max(1, Number(args[i + 1]) || 4);
            i++;
        } else if (args[i] === '--all-reports') allReports = true;
        else if (/^\d{4}$/.test(args[i])) storeNumber = args[i];
    }
    return { storeNumber, workers, runs, allReports };
}

function stepKey(label) {
    const s = String(label || '').trim();
    if (/opening report/i.test(s)) return 'open_report_page';
    if (/choosing supply chain|choosing store reports|group/i.test(s)) return 'set_group';
    if (/selecting scm|selecting inventory|selecting report/i.test(s)) return 'select_report';
    if (/choosing export|format/i.test(s)) return 'set_format';
    if (/setting start date/i.test(s)) return 'set_start_date';
    if (/setting end date/i.test(s)) return 'set_end_date';
    if (/selecting store.*in tree/i.test(s)) return 'scm_tree';
    if (/selecting store/i.test(s)) return 'select_store';
    if (/clicking generate/i.test(s)) return 'click_generate';
    if (/waiting for file/i.test(s)) return 'file_download';
    if (/downloading stock on hand/i.test(s)) return 'report_soh_start';
    if (/downloaded stock on hand/i.test(s)) return 'report_soh_done';
    if (/downloading stock on order/i.test(s)) return 'report_soo_start';
    if (/downloaded stock on order/i.test(s)) return 'report_soo_done';
    if (/downloading inventory/i.test(s)) return 'report_ise_start';
    if (/downloaded inventory/i.test(s)) return 'report_ise_done';
    return s.slice(0, 48) || 'other';
}

function stats(nums) {
    if (!nums.length) return { n: 0, min: 0, max: 0, avg: 0, p50: 0, p90: 0 };
    const sorted = [...nums].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
    return {
        n: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: sum / sorted.length,
        p50: pct(50),
        p90: pct(90),
    };
}

function fmtSec(n) {
    return `${Number(n).toFixed(1)}s`;
}

async function runBenchmarkJob(jobId, storeNumber, allReports) {
    const cfg = getStoreConfig(storeNumber);
    const storeName = cfg ? `${storeNumber} ${cfg.storeName}` : storeNumber;
    const pipeline = loadPipelineConfig();
    const nav = pipeline.reportNavigation;
    const store = { storeNumber, storeName, ...cfg };
    const reports = reportsForStore(pipeline, store).filter((r) =>
        allReports ? true : r.id === 'report1'
    );

    const storeDir = path.join(REPORTS_DIR, storeNumber, '_bench');
    ensureDir(storeDir);

    const marks = [{ key: 'job_start', at: Date.now() }];
    const mark = (key) => marks.push({ key, at: Date.now() });

    let browser;
    let page;
    const t0 = Date.now();
    try {
        const tLogin = Date.now();
        ({ browser, page } = await openMacromatixBrowser({
            headless: process.env.SCRAPER_HEADLESS !== 'false',
        }));
        mark('login_done');
        const loginMs = Date.now() - tLogin;

        await configureDownloadPath(page, storeDir);

        let lastStepAt = Date.now();
        const onReportStep = async (label) => {
            const key = stepKey(label);
            marks.push({ key, label, at: Date.now(), deltaMs: Date.now() - lastStepAt });
            lastStepAt = Date.now();
        };

        const settings = {
            navTimeoutMs: Number(process.env.MMX_NAV_TIMEOUT_MS || 45000),
            downloadWaitMs: Number(process.env.MMX_DOWNLOAD_WAIT_MS || 120000),
            reportDownloadDir: storeDir,
            pipeline: { reportNavigation: nav, reports },
            onReportStep,
        };

        const tDl = Date.now();
        const paths = await downloadReports(page, settings);
        mark('download_done');

        const totalMs = Date.now() - t0;
        const downloadMs = Date.now() - tDl;
        const expectedIds = reports.map((r) => r.id);
        const missing = expectedIds.filter((id) => !paths[id] || !fs.existsSync(paths[id]));
        if (missing.length) {
            throw new Error(`Missing downloads: ${missing.join(', ')}`);
        }

        const stepDeltas = {};
        for (let i = 1; i < marks.length; i++) {
            const cur = marks[i];
            if (!cur.key || cur.key === 'job_start') continue;
            const ms = cur.deltaMs != null ? cur.deltaMs : cur.at - marks[i - 1].at;
            const key = cur.key;
            if (!stepDeltas[key]) stepDeltas[key] = [];
            stepDeltas[key].push(ms);
        }

        return {
            ok: true,
            jobId,
            totalMs,
            loginMs,
            downloadMs,
            stepDeltas,
            files: Object.keys(paths).length,
            paths,
        };
    } catch (err) {
        return {
            ok: false,
            jobId,
            error: err.message,
            totalMs: Date.now() - t0,
        };
    } finally {
        await closeBrowserQuietly(browser, `bench-${jobId}`);
    }
}

async function runPool(storeNumber, workers, totalRuns, allReports) {
    let nextJob = 0;
    const results = [];

    async function worker(workerId) {
        while (true) {
            const jobId = nextJob++;
            if (jobId >= totalRuns) return;
            const started = Date.now();
            console.log(`[w${workerId}] job ${jobId + 1}/${totalRuns} starting…`);
            const r = await runBenchmarkJob(jobId, storeNumber, allReports);
            const wall = ((Date.now() - started) / 1000).toFixed(1);
            if (r.ok) {
                console.log(
                    `[w${workerId}] job ${jobId + 1} OK ${wall}s wall - login ${fmtSec(r.loginMs / 1000)}, pipeline ${fmtSec(r.downloadMs / 1000)}, total ${fmtSec(r.totalMs / 1000)}`
                );
            } else {
                console.log(`[w${workerId}] job ${jobId + 1} FAIL ${wall}s - ${r.error}`);
            }
            results.push(r);
        }
    }

    const t0 = Date.now();
    await Promise.all(Array.from({ length: workers }, (_, i) => worker(i + 1)));
    const poolMs = Date.now() - t0;
    return { results, poolMs };
}

function aggregateStepStats(results) {
    const byKey = {};
    for (const r of results.filter((x) => x.ok)) {
        for (const [key, arr] of Object.entries(r.stepDeltas || {})) {
            if (!byKey[key]) byKey[key] = [];
            byKey[key].push(...arr);
        }
    }
    const rows = Object.entries(byKey)
        .map(([key, ms]) => ({ key, ...stats(ms.map((m) => m / 1000)) }))
        .sort((a, b) => b.avg - a.avg);
    return rows;
}

function printTable(rows) {
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`\n${pad('Step', 22)} ${pad('avg', 8)} ${pad('p50', 8)} ${pad('p90', 8)} ${pad('min', 8)} ${pad('max', 8)} n`);
    console.log('-'.repeat(72));
    for (const r of rows) {
        console.log(
            `${pad(r.key, 22)} ${pad(fmtSec(r.avg), 8)} ${pad(fmtSec(r.p50), 8)} ${pad(fmtSec(r.p90), 8)} ${pad(fmtSec(r.min), 8)} ${pad(fmtSec(r.max), 8)} ${r.n}`
        );
    }
}

function suggestCuts(rows, okResults) {
    const tips = [];
    const top = rows.slice(0, 6);
    const login = stats(okResults.map((r) => r.loginMs / 1000));
    const total = stats(okResults.map((r) => r.totalMs / 1000));

    if (login.avg >= 3) {
        tips.push(
            `Login averages ${fmtSec(login.avg)} per browser - reuse one MMX session for all 3 reports instead of reopening (stock count already does this).`
        );
    }
    for (const r of top) {
        if (r.key === 'set_format' && r.avg >= 4) {
            tips.push(
                `Format selection ~${fmtSec(r.avg)} - often retries waiting for dropdown; trim MMX_REPORT_FORMAT_ATTEMPTS or skip wait when Excel is already selected.`
            );
        }
        if (r.key === 'open_report_page' && r.avg >= 2) {
            tips.push(
                `Report page navigation ~${fmtSec(r.avg)} per report - chain SOH→SOO→ISE without full page.goto between reports (change report dropdown only).`
            );
        }
        if (r.key === 'set_start_date' && r.avg >= 2) {
            tips.push(
                `Start date ~${fmtSec(r.avg)} - skip re-entry when value already matches tomorrow (partially implemented).`
            );
        }
        if (r.key === 'scm_tree' && r.avg >= 3) {
            tips.push(`SCM tree ~${fmtSec(r.avg)} - area expand postback; tune MMX_SCM_TREE_AREA_POSTBACK_MS if stable.`);
        }
        if (r.key === 'file_download' && r.avg >= 5) {
            tips.push(
                `File download ~${fmtSec(r.avg)} - Macromatix server time; not much to cut client-side.`
            );
        }
        if (r.key === 'select_store' && r.avg >= 5) {
            tips.push(
                `ISE store reload ~${fmtSec(r.avg)} - triggerStoreSelectionReload does full page.reload; investigate lighter postback.`
            );
        }
    }
    tips.push(`End-to-end avg ${fmtSec(total.avg)} (p90 ${fmtSec(total.p90)}) with ${okResults.length} successful run(s).`);
    return tips;
}

async function main() {
    const { storeNumber, workers, runs, allReports } = parseArgs(process.argv);
    if (!storeNumber) {
        console.error(
            'Usage: node scripts/probe-soh-benchmark.js <store> [--workers N] [--runs N] [--all-reports]'
        );
        process.exit(1);
    }

    console.log(
        `[bench] store=${storeNumber} workers=${workers} runs=${runs} mode=${allReports ? 'ISE+SOH+SOO' : 'SOH only'}`
    );
    console.log(`[bench] launching ${workers} concurrent browser(s)…\n`);

    const { results, poolMs } = await runPool(storeNumber, workers, runs, allReports);
    const ok = results.filter((r) => r.ok);
    const fail = results.filter((r) => !r.ok);

    console.log(`\n========== Pool summary ==========`);
    console.log(`Passed: ${ok.length}/${runs} in ${fmtSec(poolMs / 1000)} wall (${workers} workers)`);
    if (fail.length) {
        for (const f of fail) console.log(`  FAIL job ${f.jobId + 1}: ${f.error}`);
    }

    if (ok.length) {
        const login = stats(ok.map((r) => r.loginMs / 1000));
        const pipeline = stats(ok.map((r) => r.downloadMs / 1000));
        const total = stats(ok.map((r) => r.totalMs / 1000));
        console.log(`\nPer-run totals (n=${ok.length}):`);
        console.log(`  login:    avg ${fmtSec(login.avg)}  p90 ${fmtSec(login.p90)}`);
        console.log(`  pipeline: avg ${fmtSec(pipeline.avg)}  p90 ${fmtSec(pipeline.p90)}`);
        console.log(`  total:    avg ${fmtSec(total.avg)}  p90 ${fmtSec(total.p90)}`);

        const rows = aggregateStepStats(results);
        console.log('\n========== Step breakdown (sorted by avg) ==========');
        printTable(rows);

        console.log('\n========== Where to cut time ==========');
        for (const tip of suggestCuts(rows, ok)) {
            console.log(`• ${tip}`);
        }
    }

    process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
    console.error('[bench]', e.message);
    process.exit(1);
});
