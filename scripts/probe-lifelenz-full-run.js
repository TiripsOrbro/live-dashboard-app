#!/usr/bin/env node
/**
 * Headed LifeLenz run - list accessible stores, then write full target week forecast.
 *
 * Usage:
 *   npm run probe-lifelenz-full-run -- 3806 3811
 *   npm run probe-lifelenz-full-run -- 3806
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('./load-project-env');

process.env.LIFELENZ_SCRAPER_HEADLESS = 'false';

const { createAuthenticatedLifeLenzSession, getDevLifeLenzCredentials } = require('../lifelenz/src/lifelenzAuth');
const { writeForecastPlanOnPage } = require('../lifelenz/src/lifelenzForecastScraper');
const { previewForecastForStore, buildTargetForecastDates } = require('../dashboard/src/forecast/forecastRunner');

async function main() {
    const storeNumbers = process.argv.slice(2).filter(Boolean);
    if (!storeNumbers.length) {
        console.error('Usage: npm run probe-lifelenz-full-run -- 3806 3811');
        process.exit(1);
    }

    const creds = getDevLifeLenzCredentials();
    if (!creds) {
        console.error('[probe-lifelenz-full-run] Set TempLifeLenzU / TempLifeLenzP in .env');
        process.exit(1);
    }

    const { targetWeeks, dates } = buildTargetForecastDates();
    console.log('[probe-lifelenz-full-run] Target week(s):', targetWeeks.join(', '));
    console.log('[probe-lifelenz-full-run] Dates:', dates.join(', '));
    console.log('[probe-lifelenz-full-run] Logging in to LifeLenz (headed)...');

    const session = await createAuthenticatedLifeLenzSession(creds.email, creds.password, {
        headless: false,
        keepBrowserOpen: true,
    });

    console.log('\n[probe-lifelenz-full-run] Accessible stores detected:');
    for (const row of session.stores) {
        console.log(`  ${row.storeNumber} - ${row.label}`);
    }
    console.log(`  (${session.stores.length} total)\n`);

    const accessible = new Set(session.stores.map((row) => String(row.storeNumber)));
    const results = [];

    for (const storeNumber of storeNumbers) {
        const store = String(storeNumber).trim();
        console.log(`[probe-lifelenz-full-run] Store ${store} - building forecast plan...`);
        if (!accessible.has(store)) {
            const msg = `Store ${store} not in LifeLenz account (detected: ${[...accessible].join(', ')})`;
            console.error(`  FAILED: ${msg}`);
            results.push({ storeNumber: store, ok: false, error: msg });
            continue;
        }

        try {
            const preview = previewForecastForStore(store);
            console.log(
                `  Plan: ${preview.plan?.length || 0} days, week total ~$${Math.round(
                    preview.plan?.reduce((s, d) => s + (Number(d.forecastTotal) || 0), 0) || 0
                )}`
            );
            const applied = await writeForecastPlanOnPage(session.page, store, preview.plan, session.stores, {
                onProgress: (payload) => console.log(`  [${store}]`, JSON.stringify(payload)),
            });
            console.log(`  OK: ${applied.length} days entered in LifeLenz`);
            results.push({ storeNumber: store, ok: true, forecastDays: applied.length, lifelenz: applied });
        } catch (err) {
            console.error(`  FAILED: ${err.message}`);
            results.push({ storeNumber: store, ok: false, error: err.message });
        }
    }

    console.log('\n[probe-lifelenz-full-run] Summary:');
    console.log(JSON.stringify({ stores: session.stores, results }, null, 2));
    console.log('[probe-lifelenz-full-run] Browser left open - close manually when done.');
}

main().catch((err) => {
    console.error('[probe-lifelenz-full-run] Failed:', err.message);
    process.exit(1);
});
