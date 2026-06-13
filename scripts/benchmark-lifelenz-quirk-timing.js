#!/usr/bin/env node
/**
 * Headless sweep of LIFELENZ_QUIRK_RELOAD_MAX_MS values — one store, one day.
 *
 * Usage:
 *   npm run benchmark-lifelenz-quirk -- 3806 2026-06-22
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

process.env.LIFELENZ_SCRAPER_HEADLESS = 'true';
process.env.FORECAST_SCRAPER_HEADLESS = 'true';

const { createAuthenticatedLifeLenzSession, getDevLifeLenzCredentials } = require('../lifelenz/src/lifelenzAuth');
const {
    writeForecastPlanOnPage,
    countVisibleDayPartInputs,
} = require('../lifelenz/src/lifelenzForecastScraper');
const { previewForecastForStore } = require('../dashboard/src/forecast/forecastRunner');

const CAPS_MS = [2000, 4000, 6000, 8000, 10000];
const REPEAT_OK = 3;

async function runOnce(session, store, planDay, capMs) {
    const started = Date.now();
    process.env.LIFELENZ_QUIRK_RELOAD_MAX_MS = String(capMs);
    try {
        await writeForecastPlanOnPage(session.page, store, [planDay], session.stores, {
            headless: true,
            quirkReloadMaxMs: capMs,
            fieldDelayMs: 90,
        });
        const inputs = await countVisibleDayPartInputs(session.page);
        return {
            capMs,
            ok: inputs >= 9,
            elapsedMs: Date.now() - started,
            inputs,
            error: null,
        };
    } catch (err) {
        return {
            capMs,
            ok: false,
            elapsedMs: Date.now() - started,
            inputs: 0,
            error: err.message || String(err),
        };
    }
}

async function main() {
    const store = process.argv[2] || '3806';
    const date = process.argv[3] || '2026-06-22';
    const creds = getDevLifeLenzCredentials();
    if (!creds) {
        console.error('[benchmark-lifelenz-quirk] Set TempLifeLenzU / TempLifeLenzP in .env');
        process.exit(1);
    }

    const preview = previewForecastForStore(store, { force: true });
    const planDay = preview.plan.find((d) => d.date === date);
    if (!planDay) {
        console.error(`[benchmark-lifelenz-quirk] No plan day for ${date}`);
        process.exit(1);
    }

    console.log(`[benchmark-lifelenz-quirk] Store ${store}, date ${date}, caps: ${CAPS_MS.join(', ')} ms\n`);

    const session = await createAuthenticatedLifeLenzSession(creds.email, creds.password, { headless: true });
    const results = [];

    for (const capMs of CAPS_MS) {
        let passes = 0;
        for (let attempt = 1; attempt <= REPEAT_OK; attempt += 1) {
            const row = await runOnce(session, store, planDay, capMs);
            results.push({ ...row, attempt });
            if (row.ok) passes += 1;
            console.log(
                `  cap=${capMs} attempt=${attempt} ${row.ok ? 'PASS' : 'FAIL'} ${row.elapsedMs}ms` +
                    (row.error ? ` — ${row.error}` : '')
            );
        }
        if (passes === REPEAT_OK) {
            console.log(`\n[benchmark-lifelenz-quirk] Recommended cap: ${capMs} ms (${REPEAT_OK}/${REPEAT_OK} passes)\n`);
            break;
        }
    }

    console.log('\nSummary:');
    console.table(
        results.map((r) => ({
            capMs: r.capMs,
            attempt: r.attempt,
            ok: r.ok,
            elapsedMs: r.elapsedMs,
            inputs: r.inputs,
        }))
    );

    await session.browser.close().catch(() => null);
}

main().catch((err) => {
    console.error('[benchmark-lifelenz-quirk] Failed:', err.message);
    process.exit(1);
});
