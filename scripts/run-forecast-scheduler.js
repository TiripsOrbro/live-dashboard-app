#!/usr/bin/env node
/**
 * Monday 2 AM (Melbourne) - auto-submit forecasts for eligible stores.
 *
 * Usage:
 *   npm run forecast-scheduler
 *
 * Enable in .env:
 *   FORECAST_SCHEDULE_ENABLED=1
 *   FORECAST_SCHEDULE_HOUR=2
 *   FORECAST_SCHEDULE_WINDOW_MIN=30
 */
const path = require('path');
require('../src/loadEnv').loadEnv();
require('../dashboard/src/forecastMmxAbort');

const { getStoreList } = require('../stores/src/storeList');
const { storeHasMmxCredentials } = require('../mmx/src/macromatixScraper');
const { listCredentialCandidates } = require('../stores/src/storeCredentials');
const { assessHistoryReadiness } = require('../dashboard/src/forecast/forecastHistoryLedger');
const { buildStatusForStores, getTargetForecastWeekStarts } = require('../dashboard/src/forecast/forecastStatusLedger');
const { runCombinedForecastForStores } = require('../dashboard/src/forecast/forecastRunner');
const {
    TIME_ZONE,
    melbourneDateKey,
    scheduleHour,
    scheduleWindowMinutes,
    isScheduleEnabled,
    isWithinScheduleWindow,
    msUntilNextScheduleRun,
    hasScheduledRunForWeek,
    markScheduledRun,
    appendScheduleLog,
} = require('../dashboard/src/forecast/forecastSchedule');
const { runWithPriority, PRIORITY } = require('../src/services/mmxTaskQueue');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function listEligibleStores() {
    const targetWeeks = getTargetForecastWeekStarts();
    const weekStart = targetWeeks[0];
    const status = buildStatusForStores(getStoreList().map((s) => String(s.storeNumber)));
    const eligible = [];

    for (const cfg of getStoreList()) {
        const store = String(cfg.storeNumber || '').trim();
        if (!store) continue;
        if (status.stores?.[store]?.[weekStart]?.completed) continue;
        if (!storeHasMmxCredentials(store)) continue;

        const readiness = assessHistoryReadiness(store);
        if (!readiness.ready) continue;

        const lifelenzCandidates = listCredentialCandidates(store, 'lifelenz');
        const lifelenzCredentials = lifelenzCandidates[0];
        if (!lifelenzCredentials?.email || !lifelenzCredentials?.password) continue;

        eligible.push({ storeNumber: store, lifelenzCredentials });
    }
    return { weekStart, eligible };
}

async function runScheduledForecastJob() {
    const runDateKey = melbourneDateKey();
    const { weekStart, eligible } = await listEligibleStores();

    if (!eligible.length) {
        console.log('[ForecastScheduler] No eligible stores - skipping.');
        appendScheduleLog(runDateKey, { action: 'skip', reason: 'no eligible stores', weekStart });
        return { skipped: true, weekStart, stores: [] };
    }

    if (hasScheduledRunForWeek(runDateKey, weekStart)) {
        console.log(`[ForecastScheduler] Already ran today for week ${weekStart} - skipping.`);
        return { skipped: true, weekStart, stores: [] };
    }

    const storeNumbers = eligible.map((row) => row.storeNumber);
    const lifelenzByStore = Object.fromEntries(
        eligible.map((row) => [
            row.storeNumber,
            { email: row.lifelenzCredentials.email, password: row.lifelenzCredentials.password },
        ])
    );

    console.log(`[ForecastScheduler] Running ${storeNumbers.length} store(s) for week ${weekStart}…`);

    const windowEndMs = Date.now() + scheduleWindowMinutes() * 60 * 1000;
    let deferred = false;

    const results = await runWithPriority(PRIORITY.ADMIN, {
        type: 'forecast-scheduler',
        label: 'forecast scheduler',
        run: async () => {
            const out = [];
            for (const storeNumber of storeNumbers) {
                if (!isWithinScheduleWindow() && Date.now() > windowEndMs) {
                    deferred = true;
                    break;
                }
                const row = await runCombinedForecastForStores([storeNumber], {
                    completedBy: 'scheduler',
                    headless: true,
                    lifelenzCredentials: { byStore: lifelenzByStore },
                    onProgress: (payload) => {
                        console.log(`[ForecastScheduler] [${storeNumber}]`, JSON.stringify(payload));
                    },
                });
                out.push({ storeNumber, ...row });
            }
            return out;
        },
    }).catch((err) => {
        if (String(err?.name || '') === 'MmxTaskQueueTimeoutError') {
            deferred = true;
            appendScheduleLog(runDateKey, { action: 'defer', reason: 'queue timeout', weekStart });
            return null;
        }
        throw err;
    });

    if (deferred || !results) {
        console.warn('[ForecastScheduler] Deferred - MMX queue busy during schedule window.');
        return { deferred: true, weekStart };
    }

    markScheduledRun(runDateKey, weekStart, { storeCount: storeNumbers.length });
    appendScheduleLog(runDateKey, { action: 'run', weekStart, storeNumbers, results });
    console.log('[ForecastScheduler] Done:', JSON.stringify({ weekStart, storeNumbers }, null, 2));
    return { weekStart, storeNumbers, results };
}

async function main() {
    const hour = scheduleHour();
    const windowMin = scheduleWindowMinutes();
    console.log(
        `[ForecastScheduler] Started - ${TIME_ZONE}, Monday ~${hour}:00 (window ${windowMin} min), week target +14d`
    );

    if (!isScheduleEnabled()) {
        console.warn('[ForecastScheduler] FORECAST_SCHEDULE_ENABLED is not set - sleeping 5 min.');
    }

    for (;;) {
        if (!isScheduleEnabled()) {
            await sleep(5 * 60 * 1000);
            continue;
        }

        const now = new Date();
        if (isWithinScheduleWindow(now)) {
            try {
                await runScheduledForecastJob();
            } catch (err) {
                console.error('[ForecastScheduler] Run failed:', err.message);
                appendScheduleLog(melbourneDateKey(), { action: 'error', error: err.message });
            }
            await sleep(Math.max(msUntilNextScheduleRun(now), 60000));
            continue;
        }

        const wait = msUntilNextScheduleRun(now);
        const mins = Math.round(wait / 60000);
        console.log(`[ForecastScheduler] Next check in ~${mins} min (target Mon ${hour}:00 ${TIME_ZONE})`);
        await sleep(Math.min(wait, 10 * 60 * 1000));
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('[ForecastScheduler] Fatal:', err.message);
        process.exit(1);
    });
}

module.exports = { runScheduledForecastJob, listEligibleStores };
