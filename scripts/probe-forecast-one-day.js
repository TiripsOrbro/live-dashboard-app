#!/usr/bin/env node
/**
 * One-day forecast probe — headless by default, pass --headed to watch the browser.
 *
 * Usage:
 *   node scripts/probe-forecast-one-day.js 3901 1
 *   node scripts/probe-forecast-one-day.js 3901 1 --headed
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
require('./load-project-env');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const headed = process.argv.includes('--headed');
if (headed) process.env.FORECAST_SCRAPER_HEADLESS = 'false';

const { previewForecastForStore } = require('../dashboard/src/forecast/forecastRunner');
const { writeForecastPlanToMmx } = require('../mmx/src/forecast/forecastScraper');

const store = args[0] || '3811';
const dayIndex = Number(args[1] || 1);

(async () => {
    const preview = previewForecastForStore(store);
    const day = preview.plan[dayIndex];
    if (!day) throw new Error(`No plan day at index ${dayIndex}`);
    console.log('[probe-one-day] store', store, 'date', day.date, 'hours', day.hourly.length, headed ? '(headed)' : '');

    const events = [];
    try {
        const result = await writeForecastPlanToMmx(store, [day], {
            headless: !headed,
            keepBrowserOpen: headed,
            onProgress: (payload) => {
                if (payload.type?.startsWith('hour-') || payload.type?.startsWith('day-')) {
                    events.push(payload);
                    console.log('[event]', payload.type, payload.label || payload.date, payload.reason || payload.read || '');
                }
            },
        });
        console.log('[probe-one-day] ok', JSON.stringify(result.mmx, null, 2));
        if (headed) console.log('[probe-one-day] Browser left open — close manually when done.');
    } catch (err) {
        console.error('[probe-one-day] FAIL', err.message);
        const failed = events.filter((e) => e.type === 'hour-failed');
        console.log('[probe-one-day] hour-failed count', failed.length);
        for (const f of failed.slice(0, 8)) {
            console.log(' ', f.label, f.reason, 'read=', f.read, 'want=', f.forecast);
        }
        if (headed) console.log('[probe-one-day] Browser left open on failure — inspect the grid.');
        process.exit(1);
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
