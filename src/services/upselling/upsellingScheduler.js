const fs = require('fs');
const path = require('path');
const {
    loadUpsellingConfig,
    isUpsellingMmxSyncStore,
    resolveEnabledStores,
    upsellingDataDir,
    TIME_ZONE,
} = require('./upsellingConfig');
const { runUpsellMmxSync } = require('./upsellMmxPipeline');

function melbourneWallClock(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-AU', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value || 0);
    const hour = get('hour');
    const minute = get('minute');
    return { hour, minute, minuteOfDay: hour * 60 + minute };
}

function isUpsellingUpdateWindow(now = new Date(), peakWindows) {
    const cfg = loadUpsellingConfig();
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
    const p = path.join(upsellingDataDir(storeNumber), 'last-sync.json');
    if (!fs.existsSync(p)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        return data.lastHourKey || null;
    } catch (_) {
        return null;
    }
}

async function maybeRunScheduledUpsell(now = new Date()) {
    const cfg = loadUpsellingConfig();
    if (!isUpsellingUpdateWindow(now, cfg.peakWindows)) {
        return { skipped: true, reason: 'outside peak window' };
    }

    const hourKey = currentHourKey(now);
    const results = [];

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

function startUpsellingScheduler() {
    const cfg = loadUpsellingConfig();
    const intervalMin = Number(cfg.updateIntervalMinutes) || 60;
    const intervalMs = Math.max(1, intervalMin) * 60 * 1000;

    const tick = async () => {
        try {
            await maybeRunScheduledUpsell();
        } catch (e) {
            console.warn('[Upselling] Scheduler tick error:', e.message);
        }
    };

    setTimeout(tick, 15000).unref?.();
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    console.log(
        `[Upselling] Peak-hour scheduler every ${intervalMin}m for MMX stores: ${resolveEnabledStores(cfg).filter(isUpsellingMmxSyncStore).join(', ') || '(none)'}`
    );
    return timer;
}

module.exports = {
    melbourneWallClock,
    isUpsellingUpdateWindow,
    currentHourKey,
    maybeRunScheduledUpsell,
    startUpsellingScheduler,
};
