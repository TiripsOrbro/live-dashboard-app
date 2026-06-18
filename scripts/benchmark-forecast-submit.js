#!/usr/bin/env node
/**
 * Time full forecast submit: login → store → 7 days fill/save.
 *
 * Usage: node scripts/benchmark-forecast-submit.js [storeNumber]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
require('./load-project-env');
process.env.FORECAST_SCRAPER_HEADLESS = 'true';

const { previewForecastForStore } = require('../dashboard/src/forecast/forecastRunner');
const { writeForecastPlanToMmx } = require('../mmx/src/forecast/forecastScraper');

function fmt(ms) {
    return `${(ms / 1000).toFixed(2)}s`;
}

async function main() {
    const storeNumber = process.argv[2] || '3806';
    const preview = previewForecastForStore(storeNumber);
    const plan = preview.plan;
    const marks = [];
    const mark = (label) => {
        const t = Date.now();
        marks.push({ label, t });
        return t;
    };
    const since = (label) => {
        const idx = marks.findIndex((m) => m.label === label);
        if (idx < 0) return null;
        const next = marks[idx + 1];
        return next ? next.t - marks[idx].t : Date.now() - marks[idx].t;
    };

    mark('start');
    let phase = 'login';
    const result = await writeForecastPlanToMmx(storeNumber, plan, {
        headless: true,
        onProgress: (payload) => {
            if (payload.type === 'store-start' && phase === 'login') {
                mark('login+nav');
                phase = 'days';
            }
            if (payload.type === 'day-start') {
                mark(`day:${payload.date}:start`);
            }
            if (payload.type === 'day-filling') {
                mark(`day:${payload.date}:date`);
            }
            if (payload.type === 'day-saving') {
                mark(`day:${payload.date}:fill`);
            }
            if (payload.type === 'day-done') {
                mark(`day:${payload.date}:done`);
            }
        },
    });
    mark('end');

    const total = marks[marks.length - 1].t - marks[0].t;
    console.log(`\n[benchmark] Store ${storeNumber} - ${plan.length} days - total ${fmt(total)}`);
    console.log(`[benchmark] login+nav: ${fmt(since('start'))} (until first day)`);
    if (since('login+nav') != null) {
        console.log(`[benchmark] login+nav only: ${fmt(since('login+nav'))} (nav segment)`);
    }

    for (const day of plan) {
        const d = day.date;
        const dateMs = since(`day:${d}:start`);
        const fillMs = since(`day:${d}:date`);
        const saveMs = since(`day:${d}:fill`);
        const dayMs = since(`day:${d}:start`);
        console.log(
            `[benchmark] ${d}: date ${fmt(dateMs || 0)} | fill ${fmt(fillMs || 0)} | save ${fmt(saveMs || 0)} | total ${fmt(dayMs || 0)}`
        );
    }

    console.log(`[benchmark] hourVerified=${result.mmx?.hourVerified} slotCount=${result.mmx?.slotCount} dayTouched=${result.mmx?.dayTouched}`);
    console.log(`[benchmark] target under 30s: ${total < 30000 ? 'PASS' : 'FAIL'} (${fmt(total)})`);
}

main().catch((err) => {
    console.error('[benchmark] Failed:', err.message);
    process.exit(1);
});
