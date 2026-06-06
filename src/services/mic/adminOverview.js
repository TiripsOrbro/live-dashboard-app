const {
    melbourneTodayIso,
    getAllActiveMultipliersForDay,
    ROTATE_INTERVAL_MS,
    DEFAULT_ITEM_MULTIPLIER,
    MULTIPLIER_NOTHING_LABEL,
    MIC_VOC_PLACEHOLDER,
} = require('./micStore');
const { loadPointsMapForParsing } = require('../upselling/pointsFile');
const {
    RAW_BASE_HOUR,
    trimHourlyToTradingWindow,
    computeDaySalesPresentation,
} = require('../salesProgress');
const { buildStockCountTileState } = require('../stockCountTileState');
const { DEFAULT_OPEN_HOUR, DEFAULT_CLOSE_HOUR, getStoreConfig } = require('../storeList');
const { TIME_ZONE } = require('../upselling/upsellingConfig');
const { getCachedSssgLy } = require('../macromatixScraper');
const { computeAreaWtdSssgPercent } = require('../sssg/sssgWeeklyLedger');

/** Same areas as store picker — always rotate through these even with no stores/data. */
const ADMIN_ROTATE_AREAS = ['Area 1', 'Area 2', 'Area 21', 'Area 22'];

function normalizeAreaKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function ensureAllAreaGroups(areaGroups) {
    const byKey = new Map();
    for (const group of areaGroups || []) {
        const name = String(group.name || '').trim();
        const key = normalizeAreaKey(group.key || group.areaKey || name);
        if (!key) continue;
        byKey.set(key, {
            name: name || group.name,
            key,
            stores: Array.isArray(group.stores) ? group.stores : [],
        });
    }
    return ADMIN_ROTATE_AREAS.map((name) => {
        const key = normalizeAreaKey(name);
        const existing = byKey.get(key);
        return existing || { name, key, stores: [] };
    });
}

function emptyAreaSalesToday() {
    return computeAreaSalesToday([]);
}

function mergeAreaHourly(areaStores) {
    const areaOpen = DEFAULT_OPEN_HOUR;
    const areaClose = DEFAULT_CLOSE_HOUR;
    const hours = Math.max(0, areaClose - areaOpen);
    const actual = new Array(hours).fill(0);
    const forecast = new Array(hours).fill(0);
    for (const store of areaStores || []) {
        const open = Number.isFinite(store.openHour) ? Math.trunc(store.openHour) : areaOpen;
        const close = Number.isFinite(store.closeHour) ? Math.trunc(store.closeHour) : areaClose;
        const rawA = Array.isArray(store.actual) ? store.actual : [];
        const rawF = Array.isArray(store.forecast) ? store.forecast : [];
        for (let localHour = areaOpen; localHour < areaClose; localHour++) {
            if (localHour < open || localHour >= close) continue;
            const rawIdx = localHour - RAW_BASE_HOUR;
            const outIdx = localHour - areaOpen;
            actual[outIdx] += Number(rawA[rawIdx]) || 0;
            forecast[outIdx] += Number(rawF[rawIdx]) || 0;
        }
    }
    return { actual, forecast, hours };
}

function resolveStoreTimeZone(store) {
    const explicit = String(store?.timeZone || '').trim();
    if (explicit) return explicit;
    const cfg = getStoreConfig(store?.storeNumber);
    return cfg?.timeZone || TIME_ZONE;
}

function computeAreaSssgToday(areaStores) {
    const values = (areaStores || [])
        .map((s) => s.sssgPercent)
        .filter((v) => v != null && !Number.isNaN(Number(v)))
        .map((v) => Number(v));
    if (!values.length) return null;
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    return Math.round(avg * 10) / 10;
}

function computeStoreSalesToday(store) {
    const openHour = Number.isFinite(store.openHour) ? store.openHour : DEFAULT_OPEN_HOUR;
    const closeHour = Number.isFinite(store.closeHour) ? store.closeHour : DEFAULT_CLOSE_HOUR;
    const timeZone = resolveStoreTimeZone(store);
    const trimmed = trimHourlyToTradingWindow(store.actual, store.forecast, openHour, closeHour);
    const { actual, forecast } = trimmed;
    let actualTotal = 0;
    let forecastTotal = 0;
    for (let i = 0; i < actual.length; i++) {
        actualTotal += Number(actual[i]) || 0;
        forecastTotal += Number(forecast[i]) || 0;
    }
    const progress = computeDaySalesPresentation({
        actual,
        forecast,
        openHour,
        closeHour,
        timeZone,
    });
    return {
        actual: Math.round(actualTotal),
        forecast: Math.round(forecastTotal),
        trackClass: progress.paceClass || 'cell-green',
        progress,
        sssgPercent: store.sssgPercent != null ? store.sssgPercent : null,
    };
}

function computeAreaSalesToday(areaStores) {
    const { actual, forecast, hours } = mergeAreaHourly(areaStores);
    let actualTotal = 0;
    let forecastTotal = 0;
    for (let i = 0; i < hours; i++) {
        actualTotal += Number(actual[i]) || 0;
        forecastTotal += Number(forecast[i]) || 0;
    }
    const progress = computeDaySalesPresentation({
        actual,
        forecast,
        openHour: DEFAULT_OPEN_HOUR,
        closeHour: DEFAULT_CLOSE_HOUR,
    });
    return {
        actual: Math.round(actualTotal),
        forecast: Math.round(forecastTotal),
        hours,
        openHour: DEFAULT_OPEN_HOUR,
        closeHour: DEFAULT_CLOSE_HOUR,
        progress,
    };
}

function buildStoresNeedingOrders(liveByNum, areaGroups) {
    const seen = new Set();
    const entries = [];
    for (const group of ensureAllAreaGroups(areaGroups)) {
        for (const cfg of group.stores || []) {
            const storeNumber = String(cfg.storeNumber || '').trim();
            if (!storeNumber || seen.has(storeNumber)) continue;
            seen.add(storeNumber);
            const live = liveByNum.get(storeNumber) || {};
            const tile = buildStockCountTileState(storeNumber, live);
            if (!tile.active || !tile.href) continue;
            entries.push({
                storeNumber,
                storeName: String(cfg.storeName || storeNumber).trim(),
                href: tile.href,
                pendingCount: tile.pendingCount,
                message: tile.message,
            });
        }
    }
    return entries.sort((a, b) => a.storeNumber.localeCompare(b.storeNumber));
}

function buildAreaStockCountTileState(areaStores, liveByNum) {
    let active = false;
    let pendingCount = 0;
    let firstHref = null;
    for (const cfg of areaStores || []) {
        const live = liveByNum.get(String(cfg.storeNumber)) || {};
        const tile = buildStockCountTileState(cfg.storeNumber, live);
        if (!tile.active) continue;
        active = true;
        pendingCount += Number(tile.pendingCount) || 0;
        if (!firstHref && tile.clickable && tile.href) firstHref = tile.href;
    }
    return {
        active,
        clickable: Boolean(firstHref),
        href: firstHref,
        message: active
            ? pendingCount
                ? `${pendingCount} vendor count${pendingCount === 1 ? '' : 's'} due in this area`
                : 'Stock counts due in this area'
            : 'All orders are placed for today in this area',
    };
}

function buildAdminOverviewPayload(salesPayload, areaGroups) {
    const day = melbourneTodayIso();
    const liveByNum = new Map((salesPayload?.stores || []).map((s) => [String(s.storeNumber), s]));

    const areas = ensureAllAreaGroups(areaGroups).map((group) => {
        const configs = group.stores || [];
        const areaStores = configs.map((cfg) => {
            const live = liveByNum.get(String(cfg.storeNumber)) || {};
            return {
                storeNumber: cfg.storeNumber,
                storeName: cfg.storeName,
                openHour: cfg.openHour,
                closeHour: cfg.closeHour,
                timeZone: resolveStoreTimeZone(cfg),
                sssgPercent: live.sssgPercent != null ? live.sssgPercent : null,
                actual: Array.isArray(live.actual) ? live.actual : [],
                forecast: Array.isArray(live.forecast) ? live.forecast : [],
            };
        });
        const hasStores = configs.length > 0;
        const storeSales = hasStores
            ? areaStores
                  .map((s) => ({
                      storeNumber: s.storeNumber,
                      storeName: s.storeName,
                      ...computeStoreSalesToday(s),
                  }))
                  .sort((a, b) =>
                      String(a.storeNumber).localeCompare(String(b.storeNumber), undefined, {
                          numeric: true,
                      })
                  )
            : [];
        const sssgTodayPercent = hasStores ? computeAreaSssgToday(areaStores) : null;
        const sssgWtdPercent = hasStores
            ? computeAreaWtdSssgPercent(areaStores, (s) => getCachedSssgLy(s.storeNumber, day))
            : null;

        return {
            name: group.name,
            areaKey: group.key || normalizeAreaKey(group.name),
            salesToday: hasStores ? computeAreaSalesToday(areaStores) : emptyAreaSalesToday(),
            storeSales,
            stockCount: buildAreaStockCountTileState(areaStores, liveByNum),
            sssgTodayPercent,
            sssgWtdPercent,
        };
    });

    const vocByArea = areas.map((a) => ({
        name: a.name,
        areaKey: a.areaKey,
        ...MIC_VOC_PLACEHOLDER,
        placeholder: true,
    }));

    const { byLabel } = loadPointsMapForParsing();
    const items = [...byLabel.values()]
        .map((entry) => ({ label: entry.label, basePoints: Number(entry.points) || 0 }))
        .sort((a, b) => a.label.localeCompare(b.label));

    return {
        day,
        areas,
        vocByArea,
        storesNeedingOrders: buildStoresNeedingOrders(liveByNum, areaGroups),
        activeMultipliers: getAllActiveMultipliersForDay(day),
        items,
        defaultMultiplier: DEFAULT_ITEM_MULTIPLIER,
        multiplierNothingLabel: MULTIPLIER_NOTHING_LABEL,
        rotateIntervalMs: ROTATE_INTERVAL_MS,
    };
}

module.exports = {
    ADMIN_ROTATE_AREAS,
    buildAdminOverviewPayload,
    computeAreaSalesToday,
    computeAreaSssgToday,
    computeStoreSalesToday,
    mergeAreaHourly,
    ensureAllAreaGroups,
    buildStoresNeedingOrders,
};
