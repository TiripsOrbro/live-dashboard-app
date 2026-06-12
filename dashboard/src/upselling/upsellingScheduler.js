const fs = require('fs');
const path = require('path');
const {
    loadUpsellingConfig,
    isUpsellingMmxSyncStore,
    isSyncAllStores,
    resolveEnabledStores,
    upsellingLastSyncPath,
    TIME_ZONE,
} = require('./upsellingConfig');
const { loadScores } = require('./leaderboardStore');
const { isMmxResourceBusy } = require('../../../mmx/src/mmxResourceGate');
const { runUpsellMmxSync } = require('../../../mmx/src/upselling/upsellMmxPipeline');

function melbourneWallClock(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false,
    }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    const hour = get('hour');
    const minute = get('minute');
    const second = get('second');
    return { hour, minute, second, minuteOfDay: hour * 60 + minute };
}

/** Milliseconds until the next top-of-hour in the dashboard timezone. */
function msUntilNextHourBoundary(now = new Date()) {
    const { minute, second } = melbourneWallClock(now);
    const ms = now.getMilliseconds();
    const secondsRemaining = (60 - minute - 1) * 60 + (60 - second);
    return Math.max(0, secondsRemaining * 1000 - ms);
}

function isHourlySchedule(cfg) {
    const mode = String(cfg?.updateSchedule || cfg?.scheduleMode || 'hourly').trim().toLowerCase();
    return mode === 'hourly' || mode === 'on-the-hour';
}

function isUpsellingUpdateWindow(now = new Date(), peakWindows) {
    const cfg = loadUpsellingConfig();
    if (isHourlySchedule(cfg)) return true;

    const windows = peakWindows || cfg.peakWindows || [];
    const { minuteOfDay } = melbourneWallClock(now);
    for (const w of windows) {
        const start = Number(w.start) * 60;
        const end = Number(w.end) * 60;
        if (Number.isFinite(start) && Number.isFinite(end) && minuteOfDay >= start && minuteOfDay < end) {
            return true;
        }
    }
    return false;
}

function currentHourKey(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}`;
}

function readLastHourKey(storeNumber) {
    const sharedPath = upsellingLastSyncPath();
    if (fs.existsSync(sharedPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(sharedPath, 'utf8'));
            const stores = data.storesUpdated || [];
            const store = String(storeNumber || '').trim();
            if (!store || store === 'all' || stores.includes(store) || !stores.length) {
                return data.lastHourKey || null;
            }
        } catch (_) {
            /* fall through */
        }
    }
    const store = String(storeNumber || '').trim();
    if (!store) return null;
    const lastSyncAt = loadScores(store).lastSyncAt;
    if (!lastSyncAt) return null;
    return currentHourKey(new Date(lastSyncAt));
}

async function maybeRunScheduledUpsell(now = new Date()) {
    if (isMmxResourceBusy()) {
        return { skipped: true, reason: 'mmx-busy' };
    }

    const cfg = loadUpsellingConfig();
    if (!isUpsellingUpdateWindow(now, cfg.peakWindows)) {
        return { skipped: true, reason: 'outside peak window' };
    }

    const hourKey = currentHourKey(now);
    const results = [];

    if (isSyncAllStores(cfg)) {
        if (readLastHourKey('all') === hourKey) {
            return { skipped: true, reason: 'already synced this hour', hourKey };
        }
        try {
            const out = await runUpsellMmxSync(null, { lastHourKey: hourKey, syncAllStores: true });
            results.push({
                storeNumber: 'all',
                ok: true,
                stores: out.storeNumbers || [],
            });
        } catch (error) {
            console.warn('[Upselling] Scheduled regional sync failed:', error.message);
            results.push({ storeNumber: 'all', ok: false, error: error.message });
        }
        return { skipped: false, hourKey, results, regional: true };
    }

    for (const storeNumber of resolveEnabledStores(cfg)) {
        if (!isUpsellingMmxSyncStore(storeNumber)) {
            results.push({ storeNumber, skipped: true, reason: 'no MMX sync (test store or disabled)' });
            continue;
        }
        if (readLastHourKey(storeNumber) === hourKey) {
            results.push({ storeNumber, skipped: true, reason: 'already synced this hour' });
            continue;
        }
        try {
            const out = await runUpsellMmxSync(storeNumber, { lastHourKey: hourKey });
            results.push({ storeNumber, ok: true, file: out.file });
        } catch (error) {
            console.warn(`[Upselling] Scheduled sync failed for ${storeNumber}:`, error.message);
            results.push({ storeNumber, ok: false, error: error.message });
        }
    }

    return { skipped: false, hourKey, results };
}

function cancelSchedulerHandle(handle) {
    if (!handle) return;
    if (typeof handle.cancel === 'function') {
        handle.cancel();
        return;
    }
    clearInterval(handle);
    clearTimeout(handle);
}

function startUpsellingScheduler() {
    const cfg = loadUpsellingConfig();
    const mmxStores = resolveEnabledStores(cfg).filter(isUpsellingMmxSyncStore);
    const hourly = isHourlySchedule(cfg);

    const tick = async () => {
        try {
            const out = await maybeRunScheduledUpsell();
            if (!out.skipped && out.results?.length) {
                const summary = out.results
                    .map((r) =>
                        r.ok ? `${r.storeNumber}: ok` : r.skipped ? `${r.storeNumber}: skip` : `${r.storeNumber}: fail`
                    )
                    .join(', ');
                console.log(`[Upselling] Hourly sync (${out.hourKey}): ${summary}`);
            }
        } catch (e) {
            console.warn('[Upselling] Scheduler tick error:', e.message);
        }
    };

    if (hourly) {
        let timeoutId = null;

        const scheduleNext = () => {
            const delay = msUntilNextHourBoundary();
            timeoutId = setTimeout(async () => {
                await tick();
                scheduleNext();
            }, delay);
            timeoutId.unref?.();
        };

        scheduleNext();
        const syncLabel = isSyncAllStores(cfg)
            ? 'regional (all stores, one export)'
            : `MMX stores: ${mmxStores.join(', ') || '(none)'}`;
        console.log(`[Upselling] Hourly sync on the hour (${TIME_ZONE}) for ${syncLabel}`);

        return {
            cancel() {
                if (timeoutId) clearTimeout(timeoutId);
            },
        };
    }

    const intervalMin = Number(cfg.updateIntervalMinutes) || 60;
    const intervalMs = Math.max(1, intervalMin) * 60 * 1000;

    setTimeout(tick, 15000).unref?.();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    console.log(
        `[Upselling] Peak-hour scheduler every ${intervalMin}m for MMX stores: ${mmxStores.join(', ') || '(none)'}`
    );
    return {
        cancel() {
            clearInterval(timer);
        },
    };
}

module.exports = {
    melbourneWallClock,
    msUntilNextHourBoundary,
    isHourlySchedule,
    isUpsellingUpdateWindow,
    currentHourKey,
    maybeRunScheduledUpsell,
    startUpsellingScheduler,
    cancelSchedulerHandle,
};
