#!/usr/bin/env node
/**
 * Daily scheduler — at 8 AM (Melbourne) download build-to reports for stores
 * that have pending scheduled orders on the configured order date.
 *
 * Usage:
 *   npm run report-download-scheduler
 *
 * Enable in .env:
 *   REPORT_DOWNLOAD_SCHEDULE_ENABLED=1
 *   REPORT_DOWNLOAD_SCHEDULE_HOUR=8
 *   REPORT_DOWNLOAD_ORDER_DATE=today
 *
 * Order date options: today | tomorrow | YYYY-MM-DD | daysFromNow:N
 */
const path = require('path');
require('../src/loadEnv').loadEnv();

const {
    TIME_ZONE,
    scheduleHour,
    scheduleWindowMinutes,
    isScheduleEnabled,
    isWithinScheduleWindow,
    msUntilNextScheduleRun,
    melbourneDateKey,
    resolveOrderDateKey,
    runOrderDayReportDownload,
} = require('../src/services/scheduledReportDownload');
const { hasScheduledRunToday } = require('../src/services/reportDownloadScheduleState');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function maybeRunScheduledJob() {
    const runDateKey = melbourneDateKey();
    const orderDateKey = resolveOrderDateKey();
    if (hasScheduledRunToday(runDateKey, orderDateKey)) {
        console.log(`[ReportDownloadScheduler] Already ran today for order date ${orderDateKey} — skipping.`);
        return;
    }

    console.log(`[ReportDownloadScheduler] Running order-day report download (order date ${orderDateKey})…`);
    const result = await runOrderDayReportDownload({ scheduled: true, orderDate: orderDateKey });
    console.log('[ReportDownloadScheduler] Done:', JSON.stringify(result, null, 2));
}

async function main() {
    const hour = scheduleHour();
    const windowMin = scheduleWindowMinutes();
    console.log(
        `[ReportDownloadScheduler] Started — ${TIME_ZONE}, daily at ${hour}:00 (window ${windowMin} min), order date: ${resolveOrderDateKey()}`
    );

    if (!isScheduleEnabled()) {
        console.warn('[ReportDownloadScheduler] REPORT_DOWNLOAD_SCHEDULE_ENABLED is not set — sleeping 5 min (set to 1 to activate).');
    }

    for (;;) {
        if (!isScheduleEnabled()) {
            await sleep(5 * 60 * 1000);
            continue;
        }

        const now = new Date();
        if (isWithinScheduleWindow(now)) {
            try {
                await maybeRunScheduledJob();
            } catch (err) {
                console.error('[ReportDownloadScheduler] Run failed:', err.message);
            }
            await sleep(Math.max(msUntilNextScheduleRun(now), 60000));
            continue;
        }

        const wait = msUntilNextScheduleRun(now);
        const mins = Math.round(wait / 60000);
        console.log(`[ReportDownloadScheduler] Next check in ~${mins} min (target ${hour}:00 ${TIME_ZONE})`);
        await sleep(Math.min(wait, 10 * 60 * 1000));
    }
}

main().catch((err) => {
    console.error('[ReportDownloadScheduler] Fatal:', err.message);
    process.exit(1);
});
