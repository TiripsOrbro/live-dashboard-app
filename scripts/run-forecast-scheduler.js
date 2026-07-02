#!/usr/bin/env node
/**
 * Daily 5 AM (Melbourne) - auto-submit forecasts for eligible stores when admin toggle is on.
 *
 * Usage:
 *   npm run forecast-scheduler
 *
 * Enable in .env:
 *   FORECAST_SCHEDULE_ENABLED=1
 *   FORECAST_SCHEDULE_HOUR=5
 *   FORECAST_SCHEDULE_WINDOW_MIN=30
 *
 * Also enable in Admin → Forecast → "Daily auto-submit" (Area Manager+).
 */
const path = require('path');
require('../src/loadEnv').loadEnv();
require('../dashboard/src/forecastMmxAbort');

const { getStoreList } = require('../stores/src/storeList');
const { storeHasMmxCredentials } = require('../mmx/src/macromatixScraper');
const { listCredentialCandidates } = require('../stores/src/storeCredentials');
const { assessHistoryReadiness } = require('../dashboard/src/forecast/forecastHistoryLedger');
const { getTargetForecastWeekStarts, resolveForecastTarget } = require('../dashboard/src/forecast/forecastStatusLedger');
const { runCombinedForecastForStores } = require('../dashboard/src/forecast/forecastRunner');
const { isStoreAutoSubmitEnabled } = require('../dashboard/src/forecast/forecastStoreAutoSubmitLedger');
const {
    TIME_ZONE,
    melbourneDateKey,
    scheduleHour,
    scheduleWindowMinutes,
    isScheduleEnabled,
    isWithinScheduleWindow,
    msUntilNextScheduleRun,
    hasScheduledRunForDate,
    markScheduledRun,
    appendScheduleLog,
} = require('../dashboard/src/forecast/forecastSchedule');
const { runWithPriority, PRIORITY } = require('../src/services/mmxTaskQueue');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function listEligibleStores() {
    const { weekStart } = resolveForecastTarget({ targetScope: 'week-after' });
    const targetWeeks = [weekStart];
    const eligible = [];

    for (const cfg of getStoreList()) {
        const store = String(cfg.storeNumber || '').trim();
        if (!store) continue;
        if (!storeHasMmxCredentials(store)) continue;
        if (!isStoreAutoSubmitEnabled(store)) continue;

        const readiness = assessHistoryReadiness(store);
        if (!readiness.ready) continue;

        const lifelenzCandidates = listCredentialCandidates(store, 'lifelenz');
        const lifelenzCredentials = lifelenzCandidates[0];
        const lifelenzByStore =
            lifelenzCredentials?.email && lifelenzCredentials?.password
                ? { [store]: { email: lifelenzCredentials.email, password: lifelenzCredentials.password } }
                : null;

        eligible.push({ storeNumber: store, lifelenzByStore });
    }
    return { weekStart, eligible };
}

async function runScheduledForecastJob() {
    const runDateKey = melbourneDateKey();

    if (hasScheduledRunForDate(runDateKey)) {
        console.log(`[ForecastScheduler] Already ran today (${runDateKey}) - skipping.`);
        return { skipped: true, reason: 'already-ran' };
    }

    const { weekStart, eligible } = await listEligibleStores();

    if (!eligible.length) {
        console.log('[ForecastScheduler] No eligible stores - skipping.');
        appendScheduleLog(runDateKey, { action: 'skip', reason: 'no eligible stores', weekStart });
        return { skipped: true, weekStart, stores: [] };
    }

    const storeNumbers = eligible.map((row) => row.storeNumber);
    const lifelenzByStore = Object.assign({}, ...eligible.map((row) => row.lifelenzByStore || {}));
    const lifelenzCredentials =
        Object.keys(lifelenzByStore).length > 0 ? { byStore: lifelenzByStore } : null;

    console.log(`[ForecastScheduler] Running ${storeNumbers.length} store(s) for week ${weekStart}…`);

    const windowEndMs = Date.now() + scheduleWindowMinutes() * 60 * 1000;
    let deferred = false;

    const storeRunFailed = (row) => {
        const mmxOk = (row.mmxResults || []).length > 0 && (row.mmxResults || []).every((r) => r.ok);
        const llResults = row.lifelenzResults || [];
        const llOk = row.lifelenzSkipped === true || (llResults.length > 0 && llResults.every((r) => r.ok));
        return !mmxOk || !llOk;
    };

    const runStore = async (storeNumber) =>
        runCombinedForecastForStores([storeNumber], {
            completedBy: 'auto',
            headless: true,
            lifelenzCredentials,
            onProgress: (payload) => {
                console.log(`[ForecastScheduler] [${storeNumber}]`, JSON.stringify(payload));
            },
        });

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
                const row = await runStore(storeNumber);
                out.push({ storeNumber, ...row });
            }

            // Scraper failures are usually transient (slow reloads, timing);
            // give failed stores one more pass while we still hold the queue slot.
            const retryTargets = out.filter(storeRunFailed).map((row) => row.storeNumber);
            for (const storeNumber of retryTargets) {
                if (!isWithinScheduleWindow() && Date.now() > windowEndMs) break;
                console.warn(`[ForecastScheduler] Retrying failed store ${storeNumber}…`);
                appendScheduleLog(runDateKey, { action: 'retry', storeNumber, weekStart });
                const row = await runStore(storeNumber);
                const idx = out.findIndex((r) => r.storeNumber === storeNumber);
                out[idx] = { storeNumber, ...row, retried: true };
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

    const failedStores = results.filter(storeRunFailed).map((row) => row.storeNumber);
    markScheduledRun(runDateKey, weekStart, {
        storeCount: storeNumbers.length,
        failedStores,
        allSucceeded: failedStores.length === 0,
    });
    appendScheduleLog(runDateKey, { action: 'run', weekStart, storeNumbers, failedStores, results });
    if (failedStores.length) {
        console.warn(`[ForecastScheduler] Completed with failures for store(s): ${failedStores.join(', ')}`);
    }
    console.log('[ForecastScheduler] Done:', JSON.stringify({ weekStart, storeNumbers, failedStores }, null, 2));
    return { weekStart, storeNumbers, failedStores, results };
}

async function main() {
    const hour = scheduleHour();
    const windowMin = scheduleWindowMinutes();
    console.log(
        `[ForecastScheduler] Started - ${TIME_ZONE}, daily ~${hour}:00 (window ${windowMin} min), week target +14d`
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
        console.log(`[ForecastScheduler] Next check in ~${mins} min (target daily ${hour}:00 ${TIME_ZONE})`);
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
