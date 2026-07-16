#!/usr/bin/env node
/**
 * Measure real Macromatix ASP.NET postback settle times + evaluate-after-change races.
 *
 * Usage:
 *   node scripts/probe-mmx-postback-settle.js 3811
 *   node scripts/probe-mmx-postback-settle.js 3811 --quiet-ms 350
 *   node scripts/probe-mmx-postback-settle.js 3811 --loops 3
 *
 * Env:
 *   MMX_DOCUMENT_QUIET_MS — quiet window used by waitForDocumentStable (default 350)
 *   SCRAPER_HEADLESS=false — watch the browser
 */
const path = require('path');
const fs = require('fs');
require('../src/loadEnv').loadEnv();

const { openMacromatixBrowser, closeBrowserQuietly } = require('../src/services/macromatixScraper');
const { loadPipelineConfig } = require('../src/services/mmxReportDownloader');
const { getStoreConfig } = require('../src/services/storeList');
const {
    openReportSelectionPage,
    setGroupDropdown,
    selectReportInList,
} = require('../src/services/mmxReports/pipeline-supply-chain-reports');
const {
    waitForDocumentStable,
    isContextDestroyedError,
} = require('../src/services/mmxReports/mmx-postback');
const {
    openScheduledOrders,
} = require('../src/services/mmxReports/mmx-scheduled-orders');

function parseArgs(argv) {
    const args = argv.slice(2);
    let storeNumber = '3811';
    let quietMs = Number(process.env.MMX_DOCUMENT_QUIET_MS || 350);
    let loops = 2;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--quiet-ms' && args[i + 1]) {
            quietMs = Math.max(0, Number(args[i + 1]) || 0);
            i++;
        } else if (args[i] === '--loops' && args[i + 1]) {
            loops = Math.max(1, Number(args[i + 1]) || 1);
            i++;
        } else if (/^\d{4}$/.test(args[i])) storeNumber = args[i];
    }
    return { storeNumber, quietMs, loops };
}

async function sleep(page, ms) {
    if (page && typeof page.waitForTimeout === 'function') await page.waitForTimeout(ms);
    else await new Promise((r) => setTimeout(r, ms));
}

/** Poll until page.evaluate works; return ms and failures along the way. */
async function measureUntilEvaluateWorks(page, label, timeoutMs = 20000) {
    const t0 = Date.now();
    let failures = 0;
    let lastErr = null;
    while (Date.now() - t0 < timeoutMs) {
        try {
            const ready = await page.evaluate(() => document.readyState);
            if (ready === 'complete') {
                return {
                    label,
                    ok: true,
                    msToEvaluate: Date.now() - t0,
                    failures,
                };
            }
        } catch (e) {
            failures++;
            lastErr = String(e && e.message ? e.message : e).slice(0, 120);
            if (!isContextDestroyedError(e) && !/Protocol error/i.test(lastErr)) {
                return { label, ok: false, msToEvaluate: Date.now() - t0, failures, error: lastErr };
            }
        }
        await sleep(page, 50);
    }
    return {
        label,
        ok: false,
        msToEvaluate: Date.now() - t0,
        failures,
        error: lastErr || 'timeout',
    };
}

/** Trigger a change WITHOUT waiting, then measure settle. */
async function rawPostbackAfterChange(page, changeFn, label) {
    const t0 = Date.now();
    await changeFn();
    const untilEval = await measureUntilEvaluateWorks(page, `${label}:first-eval`);
    const tStable0 = Date.now();
    await waitForDocumentStable(page, { timeoutMs: 25000, quietMs: Number(process.env.MMX_DOCUMENT_QUIET_MS || 350) });
    const stableMs = Date.now() - tStable0;
    const totalMs = Date.now() - t0;
    return {
        label,
        changeToFirstEvalMs: untilEval.msToEvaluate,
        evalFailuresBeforeOk: untilEval.failures,
        firstEvalOk: untilEval.ok,
        stableWaitMs: stableMs,
        totalMs,
        error: untilEval.error,
    };
}

async function probeReportSelectionRaces(page, report, nav, quietMs, loops) {
    const results = [];
    process.env.MMX_DOCUMENT_QUIET_MS = String(quietMs);

    for (let i = 1; i <= loops; i++) {
        console.log(`\n=== report-selection loop ${i}/${loops} quietMs=${quietMs} ===`);
        await openReportSelectionPage(page, nav, 45000);

        // Instrumented path using production helpers (includes waits)
        const tGroup = Date.now();
        await setGroupDropdown(page, report.group || 'Supply Chain');
        const groupMs = Date.now() - tGroup;
        console.log(`[timing] setGroupDropdown: ${groupMs}ms`);

        const tReport = Date.now();
        let reportErr = null;
        try {
            await selectReportInList(page, report.reportName);
        } catch (e) {
            reportErr = String(e && e.message ? e.message : e);
        }
        const reportMs = Date.now() - tReport;
        console.log(`[timing] selectReportInList: ${reportMs}ms${reportErr ? ` ERR=${reportErr}` : ''}`);

        // Immediate evaluate stress right after production wait — should succeed if quiet is enough
        const afterWait = await measureUntilEvaluateWorks(page, 'after-selectReport-wait', 5000);
        console.log(
            `[timing] evaluate after select wait: ${afterWait.msToEvaluate}ms failures=${afterWait.failures} ok=${afterWait.ok}`
        );

        // Raw race: change report again (or re-select) without waiter attachment timing
        const raw = await rawPostbackAfterChange(
            page,
            async () => {
                await page.evaluate((name) => {
                    const want = String(name || '').toLowerCase();
                    for (const sel of document.querySelectorAll('select')) {
                        const hasScm = Array.from(sel.options).some((o) => /scm|items on/i.test(o.text || ''));
                        if (!hasScm) continue;
                        for (const opt of sel.options) {
                            const t = (opt.textContent || '').trim();
                            if (t.toLowerCase().includes(want)) {
                                opt.selected = true;
                                sel.dispatchEvent(new Event('change', { bubbles: true }));
                                return t;
                            }
                        }
                    }
                    return null;
                }, report.reportName);
            },
            'raw-reselect-report'
        );
        console.log(
            `[timing] raw reselect: firstEval=${raw.changeToFirstEvalMs}ms fails=${raw.evalFailuresBeforeOk} stable=${raw.stableWaitMs}ms total=${raw.totalMs}ms`
        );

        results.push({
            loop: i,
            quietMs,
            setGroupDropdownMs: groupMs,
            selectReportInListMs: reportMs,
            selectReportError: reportErr,
            afterWait,
            raw,
        });
    }
    return results;
}

async function probeScheduledOrders(page, storeNumber, storeName, quietMs) {
    process.env.MMX_DOCUMENT_QUIET_MS = String(quietMs);
    console.log(`\n=== scheduled-orders quietMs=${quietMs} store=${storeNumber} ===`);
    const t0 = Date.now();
    let err = null;
    try {
        await openScheduledOrders(
            page,
            null,
            45000,
            { scheduledOrdersDate: 'tomorrow' },
            { storeNumber, storeName }
        );
    } catch (e) {
        err = String(e && e.message ? e.message : e);
    }
    const ms = Date.now() - t0;
    console.log(`[timing] openScheduledOrders: ${ms}ms${err ? ` ERR=${err}` : ''}`);
    return { quietMs, openScheduledOrdersMs: ms, error: err };
}

function summarize(reportResults, scheduled) {
    const group = reportResults.map((r) => r.setGroupDropdownMs);
    const select = reportResults.map((r) => r.selectReportInListMs);
    const rawFirst = reportResults.map((r) => r.raw.changeToFirstEvalMs);
    const rawFails = reportResults.map((r) => r.raw.evalFailuresBeforeOk);
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
    const max = (a) => (a.length ? Math.max(...a) : 0);
    return {
        quietMs: reportResults[0]?.quietMs,
        groupAvgMs: Math.round(avg(group)),
        groupMaxMs: max(group),
        selectAvgMs: Math.round(avg(select)),
        selectMaxMs: max(select),
        rawFirstEvalAvgMs: Math.round(avg(rawFirst)),
        rawFirstEvalMaxMs: max(rawFirst),
        rawContextFailsAvg: Number(avg(rawFails).toFixed(1)),
        rawContextFailsMax: max(rawFails),
        selectErrors: reportResults.filter((r) => r.selectReportError).length,
        scheduledOrdersMs: scheduled?.openScheduledOrdersMs,
        scheduledOrdersError: scheduled?.error || null,
        recommendation:
            max(rawFirst) > Number(reportResults[0]?.quietMs || 0) * 2
                ? `Raise MMX_DOCUMENT_QUIET_MS above ${Math.ceil(max(rawFirst) * 0.5)} (raw first-eval max ${max(rawFirst)}ms)`
                : `quietMs=${reportResults[0]?.quietMs} looks adequate for this run (raw first-eval max ${max(rawFirst)}ms)`,
    };
}

async function main() {
    const { storeNumber, quietMs, loops } = parseArgs(process.argv);
    process.env.MMX_DOCUMENT_QUIET_MS = String(quietMs);

    const cfg = getStoreConfig(storeNumber);
    const storeName = cfg ? `${storeNumber} ${cfg.storeName}` : storeNumber;
    const pipeline = loadPipelineConfig();
    const report = pipeline.reports.find((r) => r.id === 'report1') || pipeline.reports[0];
    const nav = pipeline.reportNavigation;
    if (!report || !nav?.url) throw new Error('reports-pipeline.json missing report1 / reportNavigation');

    console.log(`[probe] store=${storeNumber} quietMs=${quietMs} loops=${loops}`);
    console.log(`[probe] report=${report.reportName}`);

    let browser;
    let page;
    try {
        ({ browser, page } = await openMacromatixBrowser({
            storeNumber,
            headless: process.env.SCRAPER_HEADLESS !== 'false',
        }));

        const reportResults = await probeReportSelectionRaces(page, report, nav, quietMs, loops);
        const scheduled = await probeScheduledOrders(page, storeNumber, storeName, quietMs);
        const summary = summarize(reportResults, scheduled);

        const outDir = path.join(__dirname, '../data/out');
        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(
            outDir,
            `postback-settle-${storeNumber}-q${quietMs}-${Date.now()}.json`
        );
        const payload = { storeNumber, quietMs, loops, summary, reportResults, scheduled };
        fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));

        console.log('\n=== SUMMARY ===');
        console.log(JSON.stringify(summary, null, 2));
        console.log(`[probe] wrote ${outFile}`);

        if (summary.selectErrors || summary.scheduledOrdersError) process.exitCode = 2;
    } catch (err) {
        console.error('[probe] FAILED:', err && err.message ? err.message : err);
        process.exitCode = 1;
    } finally {
        await closeBrowserQuietly(browser);
    }
}

main();
