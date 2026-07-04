#!/usr/bin/env node
/**
 * Headed LifeLenz timing run for WA stores — collects per-phase timings.
 *
 * Usage:
 *   npm run benchmark-lifelenz-wa -- 3901 3902 3903 3904
 *   npm run benchmark-lifelenz-wa
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

process.env.LIFELENZ_SCRAPER_HEADLESS = 'false';

const { createAuthenticatedLifeLenzSession, getDevLifeLenzCredentials } = require('../lifelenz/src/lifelenzAuth');
const { writeForecastPlanOnPage } = require('../lifelenz/src/lifelenzForecastScraper');
const { previewForecastForStore, buildTargetForecastDates } = require('../dashboard/src/forecast/forecastRunner');

const DEFAULT_WA_STORES = ['3901', '3902', '3903', '3904'];

function fmtMs(ms) {
    if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
    return `${ms}ms`;
}

function summarizeTimings(rows) {
    const byPhase = new Map();
    for (const row of rows) {
        const key = row.phase;
        if (!byPhase.has(key)) byPhase.set(key, []);
        byPhase.get(key).push(row.ms);
    }
    const summary = [];
    for (const [phase, times] of byPhase.entries()) {
        const total = times.reduce((s, n) => s + n, 0);
        const avg = total / times.length;
        const max = Math.max(...times);
        summary.push({ phase, count: times.length, totalMs: total, avgMs: Math.round(avg), maxMs: max });
    }
    summary.sort((a, b) => b.totalMs - a.totalMs);
    return summary;
}

async function main() {
    const storeNumbers = process.argv.slice(2).filter(Boolean);
    const stores = storeNumbers.length ? storeNumbers : DEFAULT_WA_STORES;

    const creds = getDevLifeLenzCredentials();
    if (!creds) {
        console.error('[benchmark-lifelenz-wa] Set TempLifeLenzU / TempLifeLenzP in .env');
        process.exit(1);
    }

    const { targetWeeks, dates } = buildTargetForecastDates();
    console.log('[benchmark-lifelenz-wa] Target week(s):', targetWeeks.join(', '));
    console.log('[benchmark-lifelenz-wa] Dates:', dates.join(', '));
    console.log('[benchmark-lifelenz-wa] Stores:', stores.join(', '));
    console.log('[benchmark-lifelenz-wa] Logging in (headed)...\n');

    const runStarted = Date.now();
    const allTimings = [];
    const storeResults = [];

    const loginStarted = Date.now();
    const session = await createAuthenticatedLifeLenzSession(creds.email, creds.password, {
        headless: false,
        keepBrowserOpen: true,
    });
    const loginMs = Date.now() - loginStarted;
    console.log(`Login complete in ${fmtMs(loginMs)} (${session.stores.length} stores accessible)\n`);

    const accessible = new Set(session.stores.map((row) => String(row.storeNumber)));

    for (const storeNumber of stores) {
        const store = String(storeNumber).trim();
        if (!accessible.has(store)) {
            console.error(`Store ${store} not accessible — skipping`);
            storeResults.push({ store, ok: false, error: 'not accessible' });
            continue;
        }

        const preview = previewForecastForStore(store);
        const plan = preview.plan || [];
        console.log(`--- Store ${store} (${plan.length} days) ---`);

        const storeStarted = Date.now();
        const storeTimings = [];

        try {
            await writeForecastPlanOnPage(session.page, store, plan, session.stores, {
                headless: false,
                onProgress: (payload) => {
                    if (payload.type === 'phase-timing') {
                        const row = {
                            store,
                            phase: payload.phase,
                            ms: payload.ms,
                            date: payload.date || null,
                            skipped: payload.skipped || false,
                        };
                        storeTimings.push(row);
                        allTimings.push(row);
                        const extra = payload.date ? ` ${payload.date}` : '';
                        const skip = payload.skipped ? ' (skipped)' : '';
                        console.log(`  ${payload.phase}${extra}: ${fmtMs(payload.ms)}${skip}`);
                    } else if (payload.type === 'day-complete') {
                        console.log(`  day-complete ${payload.date}`);
                    } else if (payload.type === 'day-error') {
                        console.error(`  day-error ${payload.date}: ${payload.error}`);
                    }
                },
            });
            const storeMs = Date.now() - storeStarted;
            console.log(`Store ${store} OK in ${fmtMs(storeMs)}\n`);
            storeResults.push({ store, ok: true, days: plan.length, elapsedMs: storeMs, timings: storeTimings });
        } catch (err) {
            const storeMs = Date.now() - storeStarted;
            console.error(`Store ${store} FAILED in ${fmtMs(storeMs)}: ${err.message}\n`);
            storeResults.push({ store, ok: false, error: err.message, elapsedMs: storeMs, timings: storeTimings });
        }
    }

    const totalMs = Date.now() - runStarted;
    const phaseSummary = summarizeTimings(allTimings);

    console.log('='.repeat(60));
    console.log('TIMING SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total run: ${fmtMs(totalMs)} (login ${fmtMs(loginMs)})`);
    console.log('');
    console.log('Per store:');
    for (const row of storeResults) {
        const status = row.ok ? 'OK' : 'FAIL';
        console.log(`  ${row.store}: ${status} ${fmtMs(row.elapsedMs || 0)} (${row.days || 0} days)`);
    }
    console.log('');
    console.log('Phase totals (sorted by time spent):');
    console.table(
        phaseSummary.map((row) => ({
            phase: row.phase,
            count: row.count,
            total: fmtMs(row.totalMs),
            avg: fmtMs(row.avgMs),
            max: fmtMs(row.maxMs),
        }))
    );

    const perStoreSetup = summarizeTimings(allTimings.filter((r) => ['select-store', 'navigate-forecast', 'day-view-ready'].includes(r.phase)));
    const perDay = summarizeTimings(allTimings.filter((r) => r.phase === 'write-day'));
    const saveSettle = summarizeTimings(allTimings.filter((r) => r.phase === 'save-settle'));
    const setDate = summarizeTimings(allTimings.filter((r) => r.phase === 'set-date'));
    const fill = summarizeTimings(allTimings.filter((r) => r.phase === 'fill-dayparts'));
    const verify = summarizeTimings(allTimings.filter((r) => r.phase === 'verify-dayparts'));

    console.log('\nAnalysis (where time goes):');
    if (perStoreSetup.length) {
        const setupTotal = perStoreSetup.reduce((s, r) => s + r.totalMs, 0);
        console.log(`  Store setup (select + nav + day-view): ${fmtMs(setupTotal)} total`);
        for (const row of perStoreSetup) {
            console.log(`    - ${row.phase}: ${fmtMs(row.totalMs)} (${row.count}x, avg ${fmtMs(row.avgMs)})`);
        }
    }
    if (perDay.length) {
        const dayRow = perDay[0];
        console.log(`  Per-day write: avg ${fmtMs(dayRow.avgMs)}, max ${fmtMs(dayRow.maxMs)} (${dayRow.count} days)`);
    }
    if (setDate.length) console.log(`  Date navigation: avg ${fmtMs(setDate[0].avgMs)} (${setDate[0].count}x)`);
    if (fill.length) console.log(`  Day-part entry: avg ${fmtMs(fill[0].avgMs)} (${fill[0].count}x)`);
    if (saveSettle.length) console.log(`  Post-save settle (quirk reload): avg ${fmtMs(saveSettle[0].avgMs)} (${saveSettle[0].count}x)`);
    if (verify.length) console.log(`  Verification poll: avg ${fmtMs(verify[0].avgMs)} (${verify[0].count}x)`);

    const navSkipped = allTimings.filter((r) => r.phase === 'navigate-forecast' && r.skipped);
    if (navSkipped.length) {
        console.log(`  Forecast nav skipped for ${navSkipped.length} store(s) (already on forecast page)`);
    }

    console.log('\n[benchmark-lifelenz-wa] Browser left open — close manually when done.');
}

main().catch((err) => {
    console.error('[benchmark-lifelenz-wa] Failed:', err.message);
    process.exit(1);
});
