#!/usr/bin/env node
/**
 * Backfill forecast history (if needed) and submit next-week MMX forecast for WA stores.
 *
 * Usage:
 *   node scripts/probe-wa-forecast-run.js
 *   node scripts/probe-wa-forecast-run.js --skip-backfill
 *   node scripts/probe-wa-forecast-run.js --headed --three-weeks --skip-backfill --force
 *   node scripts/probe-wa-forecast-run.js --stores 3901 3903
 */
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

process.env.FORECAST_SCRAPER_HEADLESS = process.argv.includes('--headed') ? 'false' : (process.env.FORECAST_SCRAPER_HEADLESS ?? 'true');

const { backfillForecastHistoryForStores } = require('../dashboard/src/reportSubscriptions/reportRunner');
const { runForecastForStores, runForecastWeeksForStores, buildTargetForecastDates } = require('../dashboard/src/forecast/forecastRunner');
const { assessHistoryReadiness } = require('../dashboard/src/forecast/forecastHistoryLedger');
const { assessHourlySalesCoverage } = require('../dashboard/src/reportSubscriptions/historicalHourlySalesCsv');
const { resolveHourlyBackfillDateRange } = require('../dashboard/src/reportSubscriptions/reportRunner');
const { storeHasServiceCredentials } = require('../stores/src/storeCredentials');
const { getStoreConfig } = require('../stores/src/storeList');
const { resolveNextThreeWeekTargets } = require('../dashboard/src/forecast/forecastStatusLedger');

const DEFAULT_WA_STORES = ['3901', '3902', '3903', '3904'];

function parseArgs(argv) {
    const args = argv.slice(2);
    const skipBackfill = args.includes('--skip-backfill');
    const headed = args.includes('--headed');
    const threeWeeks = args.includes('--three-weeks');
    const force = args.includes('--force');
    const storesIdx = args.indexOf('--stores');
    const stores =
        storesIdx >= 0
            ? args.slice(storesIdx + 1).filter((s) => /^\d{4}$/.test(s))
            : DEFAULT_WA_STORES;
    return { skipBackfill, headed, threeWeeks, force, stores: stores.length ? stores : DEFAULT_WA_STORES };
}

function logProgress(event) {
    const store = event.storeNumber ? ` [${event.storeNumber}]` : '';
    const msg = event.message || event.type || '';
    if (msg) console.log(`[backfill]${store} ${msg}`);
}

function summarizeStore(storeNumber) {
    const cfg = getStoreConfig(storeNumber) || {};
    const range = resolveHourlyBackfillDateRange({});
    const coverage = assessHourlySalesCoverage(storeNumber, range);
    const history = assessHistoryReadiness(storeNumber);
    return {
        storeNumber,
        storeName: cfg.storeName || storeNumber,
        mmxConfigured: storeHasServiceCredentials(storeNumber, 'mmx'),
        coverageReady: coverage.ready,
        coverage: `${coverage.presentDays}/${coverage.totalDays}`,
        missingDays: (coverage.missingDays || []).length,
        historyReady: history.ready,
        historyDays: history.daysRecorded,
        historyNewest: history.newestDate,
        weekdayGaps: history.weekdayGaps,
    };
}

async function main() {
    const startedAt = Date.now();
    const { skipBackfill, headed, threeWeeks, force, stores } = parseArgs(process.argv);
    const weekTargets = threeWeeks
        ? resolveNextThreeWeekTargets()
        : (() => {
              const t = buildTargetForecastDates();
              return [{ ...t, targetScope: t.scope || 'week-after', label: t.dates.join(' to ') }];
          })();

    console.log('[wa-forecast] WA stores:', stores.join(', '));
    if (threeWeeks) {
        console.log('[wa-forecast] Mode: next 3 weeks');
        for (let i = 0; i < weekTargets.length; i += 1) {
            const t = weekTargets[i];
            console.log(`  Week ${i + 1} (${t.targetScope}): ${t.label} — ${t.dates.length} day(s)`);
        }
        const totalDays = weekTargets.reduce((sum, t) => sum + t.dates.length, 0);
        console.log(`[wa-forecast] Total store-days: ${totalDays * stores.length} (${totalDays} days × ${stores.length} stores)`);
    } else {
        const target = weekTargets[0];
        console.log('[wa-forecast] Target week:', target.targetWeeks.join(', '));
        console.log('[wa-forecast] Dates:', target.dates.join(', '));
    }

    if (force) {
        console.log('[wa-forecast] Force mode: re-submitting all days (ignoring resume ledger).');
    }

    console.log('\n[wa-forecast] Pre-run status:');
    const pre = stores.map(summarizeStore);
    for (const row of pre) {
        console.log(`  ${row.storeNumber} ${row.storeName}: mmx=${row.mmxConfigured} history=${row.historyReady} (${row.historyDays}d, newest ${row.historyNewest}) coverage=${row.coverage} missing=${row.missingDays}`);
    }

    const backfillStores = stores.filter((s) => storeHasServiceCredentials(s, 'mmx'));
    const missingCreds = stores.filter((s) => !storeHasServiceCredentials(s, 'mmx'));

    if (missingCreds.length) {
        console.log('\n[wa-forecast] No MMX login configured (backfill + MMX submit skipped):', missingCreds.join(', '));
    }

    if (!skipBackfill && backfillStores.length) {
        const needsBackfill = backfillStores.filter((s) => {
            const row = pre.find((r) => r.storeNumber === s);
            return !row?.coverageReady || row.missingDays > 0;
        });
        if (needsBackfill.length) {
            console.log('\n[wa-forecast] Backfilling missing history from MMX:', needsBackfill.join(', '));
            await backfillForecastHistoryForStores(needsBackfill, { onProgress: logProgress });
        } else {
            console.log('\n[wa-forecast] Backfill skipped — coverage already complete for MMX stores.');
        }

        console.log('\n[wa-forecast] Post-backfill status:');
        for (const row of stores.map(summarizeStore)) {
            console.log(`  ${row.storeNumber} ${row.storeName}: coverage=${row.coverage} missing=${row.missingDays} history newest=${row.historyNewest}`);
        }
    } else if (skipBackfill) {
        console.log('\n[wa-forecast] Backfill skipped (--skip-backfill).');
    }

    const allResults = [];
    const progressHandler = (payload) => {
        if (payload.type === 'store-error' || payload.type === 'store-complete') {
            console.log(`[forecast] ${payload.storeNumber}: ${payload.type}${payload.error ? ' — ' + payload.error : ''}`);
        } else if (payload.type === 'day-done') {
            console.log(`[forecast] ${payload.storeNumber} ${payload.date}: saved (${payload.savedAs || 'ok'})`);
        } else if (payload.type === 'day-skipped') {
            console.log(`[forecast] ${payload.storeNumber} ${payload.date}: skipped (already done)`);
        }
    };

    const runCommon = {
        headless: !headed,
        keepBrowserOpen: headed,
        completedBy: force ? 'wa-probe-force' : 'wa-probe',
        skipResume: force,
        onProgress: progressHandler,
    };

    if (threeWeeks) {
        console.log('\n[wa-forecast] Submitting next 3 weeks — one MMX login per store', headed ? '(headed)' : '');
        const results = await runForecastWeeksForStores(stores, weekTargets, {
            ...runCommon,
            keepBrowserOpen: headed,
        });

        for (const row of results) {
            if (!row.ok) {
                for (let weekIdx = 0; weekIdx < weekTargets.length; weekIdx += 1) {
                    allResults.push({
                        storeNumber: row.storeNumber,
                        ok: false,
                        error: row.error,
                        weekLabel: weekTargets[weekIdx].label,
                        weekIndex: weekIdx + 1,
                    });
                }
                continue;
            }
            for (let weekIdx = 0; weekIdx < weekTargets.length; weekIdx += 1) {
                const meta = (row.weekMeta || [])[weekIdx];
                allResults.push({
                    storeNumber: row.storeNumber,
                    ok: true,
                    weekLabel: weekTargets[weekIdx].label,
                    weekIndex: weekIdx + 1,
                    mmx: { dayTouched: meta?.activeDays ?? 0 },
                });
            }
        }

        const storeOk = results.filter((r) => r.ok).length;
        console.log(`[wa-forecast] All stores complete: ${storeOk}/${results.length} succeeded (one login each).`);
    } else {
        for (let weekIdx = 0; weekIdx < weekTargets.length; weekIdx += 1) {
            const target = weekTargets[weekIdx];
            const runOptions = {
                targetScope: target.targetScope,
                ...(target.weekStart ? { weekStart: target.weekStart } : {}),
            };

            console.log(
                `\n[wa-forecast] Submitting MMX forecast — week ${weekIdx + 1}/${weekTargets.length}: ${target.label}`,
                headed ? '(headed)' : ''
            );

            const results = await runForecastForStores(stores, {
                ...runOptions,
                ...runCommon,
                keepBrowserOpen: headed && weekIdx === weekTargets.length - 1,
            });

            for (const row of results) {
                allResults.push({ ...row, weekLabel: target.label, weekIndex: weekIdx + 1 });
            }

            const weekOk = results.filter((r) => r.ok).length;
            console.log(`[wa-forecast] Week ${weekIdx + 1} complete: ${weekOk}/${results.length} store(s) succeeded.`);
            if (weekOk < results.length) {
                console.error('[wa-forecast] Stopping — remaining weeks not submitted.');
                break;
            }
        }
    }

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    console.log('\n[wa-forecast] Results:');
    let okCount = 0;
    for (const row of allResults) {
        const status = row.ok ? 'OK' : 'FAILED';
        if (row.ok) okCount += 1;
        const detail = row.error || (row.mmx?.dayTouched != null ? `${row.mmx.dayTouched} day(s), ${row.mmx.hourTouched || 0} hour(s)` : '');
        console.log(`  Week ${row.weekIndex} ${row.storeNumber}: ${status}${detail ? ' — ' + detail : ''}`);
    }

    console.log(
        `\n[wa-forecast] Complete: ${okCount}/${allResults.length} store-week(s) succeeded in ${elapsedSec}s (${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s).`
    );
    if (okCount < allResults.length) process.exit(1);
}

main().catch((err) => {
    console.error('[wa-forecast] Failed:', err.message);
    process.exit(1);
});
