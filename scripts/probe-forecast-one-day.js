#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
require('./load-project-env');
process.env.FORECAST_SCRAPER_HEADLESS = 'true';

const { previewForecastForStore } = require('../dashboard/src/forecast/forecastRunner');
const { writeForecastPlanToMmx } = require('../mmx/src/forecast/forecastScraper');

const store = process.argv[2] || '3811';
const dayIndex = Number(process.argv[3] || 1);

(async () => {
    const preview = previewForecastForStore(store);
    const day = preview.plan[dayIndex];
    if (!day) throw new Error(`No plan day at index ${dayIndex}`);
    console.log('[probe-one-day] store', store, 'date', day.date, 'hours', day.hourly.length);

    const events = [];
    try {
        const result = await writeForecastPlanToMmx(store, [day], {
            onProgress: (payload) => {
                if (payload.type?.startsWith('hour-') || payload.type?.startsWith('day-')) {
                    events.push(payload);
                    console.log('[event]', payload.type, payload.label || payload.date, payload.reason || payload.read || '');
                }
            },
        });
        console.log('[probe-one-day] ok', JSON.stringify(result.mmx, null, 2));
    } catch (err) {
        console.error('[probe-one-day] FAIL', err.message);
        const failed = events.filter((e) => e.type === 'hour-failed');
        console.log('[probe-one-day] hour-failed count', failed.length);
        for (const f of failed.slice(0, 5)) {
            console.log(' ', f.label, f.reason, 'read=', f.read, 'want=', f.forecast);
        }
        process.exit(1);
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
